package iothub

import (
	"context"
	"encoding/json"

	"meatgeek-pusher/internal/collector"
)

// Client interface for IoT Hub communication
type Client interface {
	PublishTelemetry(ctx context.Context, data collector.TemperatureData) error
}

// AzureClient implements Client for Azure IoT Hub
type AzureClient struct {
	connectionString string
	deviceID         string
}

// MockClient implements Client for development testing
type MockClient struct{}

// NewAzureClient creates a new Azure IoT Hub client
func NewAzureClient(connectionString string) (Client, error) {
	// TODO: Implement Azure IoT Hub client
	// For now, return a basic implementation
	return &AzureClient{
		connectionString: connectionString,
		deviceID:         "meatgeek3", // TODO: Extract from config
	}, nil
}

// NewMockClient creates a mock client for development
func NewMockClient() Client {
	return &MockClient{}
}

// PublishTelemetry sends temperature data to Azure IoT Hub
func (c *AzureClient) PublishTelemetry(ctx context.Context, data collector.TemperatureData) error {
	// TODO: Implement actual Azure IoT Hub publishing
	// This is a placeholder implementation for Phase 0
	
	// Convert data to JSON for logging
	jsonData, _ := json.Marshal(data)
	
	// In a real implementation, this would:
	// 1. Create MQTT or AMQP connection to IoT Hub
	// 2. Send telemetry message with proper device credentials
	// 3. Handle connection failures and retry logic
	// 4. Implement local buffering for offline scenarios
	
	// For now, just log that we would send the data
	_ = jsonData // Suppress unused variable warning
	
	return nil
}

// PublishTelemetry mock implementation - just logs the data
func (c *MockClient) PublishTelemetry(ctx context.Context, data collector.TemperatureData) error {
	// Mock implementation for development - just return success
	return nil
}