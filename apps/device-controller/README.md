# MeatGeek Device Controller

The hardware interface component of the MeatGeek V2 system, running on Raspberry Pi to monitor BBQ temperatures through RTD sensors.

## Overview

This Go application interfaces directly with hardware components to:
- Read temperatures from 5 RTD sensors (1 grill + 4 probe sensors)
- Display real-time temperatures on an LCD
- Provide HTTP API endpoints for temperature data
- Support the existing MeatGeek V1 functionality while integrating with the V2 cloud system

## Hardware Components

- **Raspberry Pi**: Main computing platform
- **MCP3008 ADC**: Analog-to-digital converter for RTD sensors
- **RTD Sensors**: 5 resistance temperature detectors
- **LCD Display**: Local temperature readouts
- **GPIO Pins**: Hardware control interface

## API Endpoints

- `GET /api/robots/MeatGeekBot/commands/get_status` - Complete device status
- `GET /api/robots/MeatGeekBot/commands/get_temps` - Temperature readings only

## Development

### Prerequisites
- Go 1.21 or later
- Make (for build orchestration)
- golangci-lint (for linting): `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`
- goimports (for formatting): `go install golang.org/x/tools/cmd/goimports@latest`

### Building

```bash
# Local development build
make build

# Cross-compile for Raspberry Pi
make build-arm

# Cross-compile for Windows
make build-windows
```

### Development Server

```bash
# Start with mock sensors for development
make dev
```

This starts the server with:
- Mock sensor data enabled
- Debug logging enabled
- API available at http://localhost:3000

### Testing

```bash
# Run all tests
make test
```

### Code Quality

```bash
# Lint code
make lint

# Format code
make format
```

### Deployment

#### Manual Deployment to Raspberry Pi

```bash
# Deploy to specific Pi
make deploy-to-pi PI_HOST=pi@192.168.1.100
```

#### System Service Installation

On the Raspberry Pi:

```bash
# Install as systemd service
make install

# Check service status
make status

# View live logs
make logs
```

### NX Integration

This project integrates with the NX monorepo through Make command orchestration:

```bash
# Via NX (recommended for monorepo development)
nx build device-controller      # Calls: make build
nx build-arm device-controller  # Calls: make build-arm
nx test device-controller       # Calls: make test
nx serve device-controller      # Calls: make dev

# Direct Make commands (useful for debugging)
cd apps/device-controller
make build
make dev
```

## Configuration

The application supports the following runtime flags:
- `--mock-sensors=true` - Use mock sensor data instead of hardware
- `--debug=true` - Enable debug logging
- `--port=3000` - Specify API port (default: 3000)

## Integration with MeatGeek V2

This device controller is designed to work with the new V2 system through:

1. **Data Pusher Service**: The separate `data-pusher` service polls this controller's API and sends data to Azure IoT Hub
2. **Existing API Compatibility**: Maintains the original API endpoints for backward compatibility
3. **Observability**: NewRelic instrumentation was removed in ticket #4. OTel Go SDK + Azure Monitor exporter will be re-added in ticket #6 at the same `main.go` init site.

## Temperature Data Structure

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
    "augerOn": false,
    "blowerOn": false,
    "igniterOn": false,
    "fireHealthy": true,
    "mode": "test",
    "setPoint": 200,
    "currentTime": "2025-01-26T10:30:00Z"
  }
}
```

## Build Information

Run `make info` to see current build configuration:
- Binary name and version
- Build timestamp
- Go version and target platform

## Troubleshooting

### Common Issues

1. **Permission Errors on Pi**: Ensure the pi user has access to GPIO
2. **Port Already in Use**: Check if another instance is running
3. **Sensor Read Errors**: Verify hardware connections and try mock sensors

### Debugging

```bash
# Start with debug logging
make dev

# Check systemd service status
make status

# View detailed logs
make logs
```

## Contributing

This project follows the MeatGeek V2 monorepo development practices:
- Use `nx format device-controller` for consistent code formatting
- Run `nx lint device-controller` before committing
- Test changes with `nx test device-controller`