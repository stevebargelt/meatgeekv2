package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"meatgeek-pusher/internal/collector"
	"meatgeek-pusher/internal/iothub"
	"meatgeek-pusher/internal/telemetry"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

var (
	Version   = "dev"
	BuildTime = "unknown"
)

type Config struct {
	DeviceURL       string
	IoTHubConnStr   string
	PollInterval    time.Duration
	Debug           bool
	MockIoT         bool
	AppInsightsKey  string
}

func main() {
	// Parse command line flags
	config := parseFlags()

	// Set up logging
	setupLogging(config.Debug)

	logrus.WithFields(logrus.Fields{
		"version":   Version,
		"buildTime": BuildTime,
	}).Info("Starting MeatGeek Data Pusher")

	// Set up OpenTelemetry tracing
	ctx := context.Background()
	shutdown, err := telemetry.SetupTracing(ctx, config.AppInsightsKey)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to set up tracing")
	}
	defer shutdown()

	// Create tracer
	tracer := otel.Tracer("meatgeek-pusher")

	// Start main service
	if err := run(ctx, config, tracer); err != nil {
		logrus.WithError(err).Fatal("Service failed")
	}

	logrus.Info("MeatGeek Data Pusher stopped")
}

func parseFlags() Config {
	config := Config{}

	flag.StringVar(&config.DeviceURL, "device-url", 
		getEnvString("DEVICE_URL", "http://localhost:3000"), 
		"Device controller URL")
	
	flag.StringVar(&config.IoTHubConnStr, "iothub-connection-string", 
		getEnvString("IOTHUB_CONNECTION_STRING", ""), 
		"Azure IoT Hub connection string")
	
	flag.DurationVar(&config.PollInterval, "poll-interval", 
		getEnvDuration("POLL_INTERVAL", 5*time.Second), 
		"Polling interval for device data")
	
	flag.BoolVar(&config.Debug, "debug", 
		getEnvBool("DEBUG", false), 
		"Enable debug logging")
	
	flag.BoolVar(&config.MockIoT, "mock-iot", 
		getEnvBool("MOCK_IOT", false), 
		"Use mock IoT Hub (for development)")
	
	flag.StringVar(&config.AppInsightsKey, "appinsights-key", 
		getEnvString("APPINSIGHTS_CONNECTION_STRING", ""), 
		"Application Insights connection string")

	flag.Parse()

	return config
}

func setupLogging(debug bool) {
	logrus.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: time.RFC3339,
	})

	if debug {
		logrus.SetLevel(logrus.DebugLevel)
	} else {
		logrus.SetLevel(logrus.InfoLevel)
	}
}

func run(ctx context.Context, config Config, tracer trace.Tracer) error {
	ctx, span := tracer.Start(ctx, "main.run")
	defer span.End()

	logrus.WithFields(logrus.Fields{
		"deviceURL":     config.DeviceURL,
		"pollInterval":  config.PollInterval,
		"mockIoT":       config.MockIoT,
	}).Info("Starting data collection service")

	// Create IoT Hub client
	var iotClient iothub.Client
	var err error

	if config.MockIoT {
		logrus.Info("Using mock IoT Hub client for development")
		iotClient = iothub.NewMockClient()
	} else {
		if config.IoTHubConnStr == "" {
			return fmt.Errorf("IoT Hub connection string is required when not using mock")
		}
		iotClient, err = iothub.NewAzureClient(config.IoTHubConnStr)
		if err != nil {
			return fmt.Errorf("failed to create IoT Hub client: %w", err)
		}
	}

	// Create temperature collector
	tempCollector, err := collector.New(config.DeviceURL, config.PollInterval, tracer)
	if err != nil {
		return fmt.Errorf("failed to create temperature collector: %w", err)
	}

	// Set up graceful shutdown
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigChan
		logrus.WithField("signal", sig.String()).Info("Received shutdown signal")
		cancel()
	}()

	// Start temperature collection and IoT publishing
	errChan := make(chan error, 1)
	
	go func() {
		errChan <- tempCollector.Start(ctx, func(data collector.TemperatureData) error {
			_, span := tracer.Start(ctx, "publish.temperature.data")
			defer span.End()

			// Publish to IoT Hub
			if err := iotClient.PublishTelemetry(ctx, data); err != nil {
				logrus.WithError(err).Error("Failed to publish telemetry")
				return err
			}

			logrus.WithFields(logrus.Fields{
				"deviceId": data.DeviceID,
				"cookId":   data.CookID,
				"grillTemp": data.GrillTemp,
			}).Debug("Published temperature data")

			return nil
		})
	}()

	// Wait for shutdown or error
	select {
	case err := <-errChan:
		if err != nil {
			return fmt.Errorf("service error: %w", err)
		}
	case <-ctx.Done():
		logrus.Info("Shutting down gracefully...")
	}

	return nil
}

// Helper functions for environment variables
func getEnvString(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1"
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if duration, err := time.ParseDuration(value); err == nil {
			return duration
		}
	}
	return defaultValue
}