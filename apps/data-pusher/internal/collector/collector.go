package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/otel/trace"
)

// TemperatureData represents the temperature data structure
type TemperatureData struct {
	DeviceID    string     `json:"deviceId"`
	Timestamp   time.Time  `json:"timestamp"`
	CookID      *string    `json:"cookId,omitempty"`
	GrillTemp   *float64   `json:"grillTemp"`
	Probe1Temp  *float64   `json:"probe1Temp"`
	Probe2Temp  *float64   `json:"probe2Temp"`
	Probe3Temp  *float64   `json:"probe3Temp"`
	Probe4Temp  *float64   `json:"probe4Temp"`
}

// DeviceStatus represents the device status from the API
type DeviceStatus struct {
	Temps struct {
		GrillTemp  *float64 `json:"grillTemp"`
		Probe1Temp *float64 `json:"probe1Temp"`
		Probe2Temp *float64 `json:"probe2Temp"`
		Probe3Temp *float64 `json:"probe3Temp"`
		Probe4Temp *float64 `json:"probe4Temp"`
	} `json:"temps"`
	Status struct {
		SmokerID    string `json:"smokerid"`
		CurrentTime string `json:"currentTime"`
	} `json:"status"`
}

// Collector handles polling the device controller for temperature data
type Collector struct {
	deviceURL     string
	pollInterval  time.Duration
	httpClient    *http.Client
	tracer        trace.Tracer
	activeCookID  *string // Maintained in memory for cook session management
}

// DataHandler is called for each temperature reading
type DataHandler func(data TemperatureData) error

// New creates a new temperature collector
func New(deviceURL string, pollInterval time.Duration, tracer trace.Tracer) (*Collector, error) {
	if deviceURL == "" {
		return nil, fmt.Errorf("device URL is required")
	}

	return &Collector{
		deviceURL:    deviceURL,
		pollInterval: pollInterval,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		tracer: tracer,
	}, nil
}

// SetActiveCook sets the current active cook ID
func (c *Collector) SetActiveCook(cookID *string) {
	c.activeCookID = cookID
	if cookID != nil {
		logrus.WithField("cookId", *cookID).Info("Set active cook ID")
	} else {
		logrus.Info("Cleared active cook ID")
	}
}

// Start begins polling the device controller
func (c *Collector) Start(ctx context.Context, handler DataHandler) error {
	logrus.WithFields(logrus.Fields{
		"deviceURL":    c.deviceURL,
		"pollInterval": c.pollInterval,
	}).Info("Starting temperature collection")

	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	// Initial poll
	if err := c.poll(ctx, handler); err != nil {
		logrus.WithError(err).Warn("Initial poll failed")
	}

	for {
		select {
		case <-ctx.Done():
			logrus.Info("Temperature collection stopped")
			return ctx.Err()
		case <-ticker.C:
			if err := c.poll(ctx, handler); err != nil {
				logrus.WithError(err).Error("Poll failed")
				// Continue polling even if individual polls fail
			}
		}
	}
}

func (c *Collector) poll(ctx context.Context, handler DataHandler) error {
	ctx, span := c.tracer.Start(ctx, "collector.poll")
	defer span.End()

	// Get temperature data from device controller
	status, err := c.fetchDeviceStatus(ctx)
	if err != nil {
		return fmt.Errorf("failed to fetch device status: %w", err)
	}

	// Convert to our data structure
	data := TemperatureData{
		DeviceID:   status.Status.SmokerID,
		Timestamp:  time.Now().UTC(),
		CookID:     c.activeCookID, // Add cook ID if we have an active cook
		GrillTemp:  status.Temps.GrillTemp,
		Probe1Temp: status.Temps.Probe1Temp,
		Probe2Temp: status.Temps.Probe2Temp,
		Probe3Temp: status.Temps.Probe3Temp,
		Probe4Temp: status.Temps.Probe4Temp,
	}

	// Call the handler to process the data
	if err := handler(data); err != nil {
		return fmt.Errorf("handler failed: %w", err)
	}

	return nil
}

func (c *Collector) fetchDeviceStatus(ctx context.Context) (*DeviceStatus, error) {
	ctx, span := c.tracer.Start(ctx, "collector.fetchDeviceStatus")
	defer span.End()

	// Create request to device controller
	url := fmt.Sprintf("%s/api/robots/MeatGeekBot/commands/get_status", c.deviceURL)
	
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Make the request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device returned status %d", resp.StatusCode)
	}

	// Parse response
	var status DeviceStatus
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &status, nil
}