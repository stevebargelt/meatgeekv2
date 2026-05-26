# MeatGeek Data Pusher Service

The IoT integration service for the MeatGeek V2 system, responsible for collecting temperature data from the device controller and pushing it to Azure IoT Hub.

## Overview

This Go service acts as a bridge between the local device controller and the Azure cloud infrastructure:

- **Polls device controller**: Regularly fetches temperature data from the local HTTP API
- **Cook session management**: Maintains active cookId in memory and enriches telemetry
- **IoT Hub integration**: Pushes temperature data to Azure IoT Hub
- **Local buffering**: Handles network outages with store-and-forward capability
- **OpenTelemetry tracing**: Provides distributed tracing for observability

## Architecture

```
Device Controller (HTTP API) ←→ Data Pusher ←→ Azure IoT Hub ←→ Azure Functions
                                      ↓
                                Local Buffer (SQLite)
```

## Key Features

### Temperature Data Collection
- Polls device controller every 5-10 seconds (configurable)
- Converts device API response to standardized telemetry format
- Handles device unavailability gracefully

### Cook Session Integration
- Maintains active cook ID in memory
- Enriches temperature messages with cook context
- Supports cook state recovery on service restart

### Reliable Data Delivery
- Local buffering for network outages
- Retry logic with exponential backoff
- Connection health monitoring

### Observability
- Structured JSON logging
- OpenTelemetry distributed tracing
- Azure Monitor integration
- Performance metrics

## Configuration

### Environment Variables

- `DEVICE_URL` - Device controller URL (default: http://localhost:3000)
- `IOTHUB_CONNECTION_STRING` - Azure IoT Hub connection string
- `POLL_INTERVAL` - Polling interval (default: 5s)
- `DEBUG` - Enable debug logging (default: false)
- `MOCK_IOT` - Use mock IoT Hub for development (default: false)
- `APPINSIGHTS_CONNECTION_STRING` - Application Insights connection string

### Command Line Flags

All environment variables can be overridden with command line flags:

```bash
./meatgeek-pusher \
  --device-url=http://localhost:3000 \
  --poll-interval=5s \
  --debug=true \
  --mock-iot=true
```

## Development

### Prerequisites
- Go 1.21 or later
- Make (for build orchestration)
- Running device controller (for integration testing)

### Building

```bash
# Local development build
make build

# Cross-compile for Raspberry Pi
make build-arm

# Initialize development environment
make init-dev
```

### Development Server

```bash
# Start with mock IoT Hub and debug logging
make dev
```

This starts the service with:
- Device URL: http://localhost:3000
- Debug logging enabled
- Mock IoT Hub (no actual Azure connection)
- OpenTelemetry tracing enabled

### Testing

```bash
# Run all tests
make test

# Check dependencies
make check-deps
```

### Code Quality

```bash
# Lint code
make lint

# Format code
make format
```

## Deployment

### Development Deployment

The service is designed to run alongside the device controller on a Raspberry Pi:

```bash
# Deploy to specific Pi
make deploy-to-pi PI_HOST=pi@192.168.1.100
```

### System Service Installation

On the Raspberry Pi:

```bash
# Install as systemd service
make install

# Check service status
make status

# View live logs
make logs
```

The systemd service configuration:
- Depends on `meatgeek-controller.service`
- Runs as `pi` user
- Auto-restarts on failure
- Environment variables from service file

### Service Dependencies

```
meatgeek-controller.service (device controller)
         ↓
meatgeek-pusher.service (this service)
```

## Data Flow

### Temperature Data Structure

Input from device controller:
```json
{
  "temps": {
    "grillTemp": 225.0,
    "probe1Temp": 160.0,
    "probe2Temp": 145.0,
    "probe3Temp": null,
    "probe4Temp": 200.0
  },
  "status": {
    "smokerid": "meatgeek3",
    "currentTime": "2025-01-26T10:30:00Z"
  }
}
```

Output to IoT Hub:
```json
{
  "deviceId": "meatgeek3",
  "timestamp": "2025-01-26T10:30:15.123Z",
  "cookId": "cook-456",
  "grillTemp": 225.0,
  "probe1Temp": 160.0,
  "probe2Temp": 145.0,
  "probe3Temp": null,
  "probe4Temp": 200.0
}
```

### Cook Session Management

The service maintains cook session state:

1. **Cook Start**: Receives cook ID from SignalR or API
2. **Active Cook**: Enriches all temperature messages with cook ID
3. **Cook End**: Clears cook ID from memory
4. **Recovery**: Can restore cook state from API on restart

## Integration with MeatGeek V2

### Phase 1 Implementation (Current)
- Basic temperature polling and IoT Hub publishing
- Mock IoT Hub client for development
- Local buffering (placeholder)
- OpenTelemetry tracing setup

### Future Enhancements
- Real Azure IoT Hub client implementation
- SQLite local buffering
- SignalR client for cook notifications
- Device twins for configuration
- Bi-directional communication
- OTA updates support

## NX Integration

This project integrates with the NX monorepo:

```bash
# Via NX (recommended for monorepo development)
nx build data-pusher        # Calls: make build
nx build-arm data-pusher    # Calls: make build-arm
nx test data-pusher         # Calls: make test
nx serve data-pusher        # Calls: make dev

# Direct Make commands (useful for debugging)
cd apps/data-pusher
make build
make dev
```

## Monitoring

### Logging
- Structured JSON logging with logrus
- Debug, info, warn, error levels
- Contextual fields for correlation

### Tracing
- OpenTelemetry distributed tracing
- Span correlation across service boundaries
- Azure Monitor integration

### Metrics
- Connection health status
- Polling success/failure rates
- Message publish rates
- Buffer usage (when implemented)

## Troubleshooting

### Common Issues

1. **Device Controller Unavailable**
   - Check device controller is running: `make -C ../device-controller status`
   - Verify network connectivity: `curl http://localhost:3000/api/robots/MeatGeekBot/commands/get_temps`

2. **IoT Hub Connection Failures**
   - Verify connection string is correct
   - Check network connectivity to Azure
   - Use mock mode for development: `--mock-iot=true`

3. **High Memory Usage**
   - Check for connection leaks
   - Monitor buffer usage
   - Review polling interval settings

### Debugging

```bash
# Start with debug logging
make dev

# Check systemd service logs
make logs

# Build information
make info
```

## Contributing

This project follows the MeatGeek V2 monorepo development practices:
- Use `nx format data-pusher` for consistent code formatting
- Run `nx lint data-pusher` before committing
- Test changes with `nx test data-pusher`
- Integration test with device controller running