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

The API is gobot's HTTP API on port 3000. The two commands the data-pusher
and you care about:

- `GET /api/robots/MeatGeekBot/commands/get_status` - Complete device status
- `GET /api/robots/MeatGeekBot/commands/get_temps` - Temperature readings only

Both answer `GET` (or `POST`) with `{"result": "<JSON string>"}`; the result is
a JSON-encoded string, not an object. **A request body is optional.** gobot
reads the body as the command's parameters and panics on an empty one, so the
controller supplies `{}` when a command request has none; the data-pusher sends
a plain `GET` with no body. Sending `{}` yourself works too. A panic in any
handler answers `500` with `{"error":"internal error"}` and one log line (method,
path, panic value); it never drops the connection.

```bash
curl http://localhost:3000/api/robots/MeatGeekBot/commands/get_status
```

The routes, commands and middleware live in `internal/deviceapi`, so the real
HTTP surface runs in tests without hardware. `main.go` only adds the ADC, LCD
and work loop.

### Contract test

The get_status body is pinned by a golden file shared with the data-pusher:
`libs/api-interfaces/test-vectors/controller-get-status.json`.

- `internal/deviceapi/deviceapi_test.go` serves the real API with fixed
  temperatures, sends get_status exactly as the pusher builds it (body-less
  `GET` with a `traceparent`), and asserts `200` and the golden body byte for
  byte. It also covers the `{}` body, a panicking command answering `500`, and
  gobot's own API dropping the body-less `GET` (the bug this guards against).
- `apps/data-pusher/internal/collector/contract_test.go` serves the same file
  to the pusher's real collector and wire mapping and asserts the reading.

If you change the Status shape on purpose, regenerate the golden file with
`go test -tags testserver ./internal/deviceapi -run Golden -update` and update
the pusher side to match.

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

This Makefile does not deploy. To get a build onto a Pi, follow the
[device runbook](../../docs/devices/runbook.md): `apps/data-pusher/deploy/onboard-pi.sh`
(`make deploy-to-pi PI_HOST=pi@<lan ip>` in `apps/data-pusher`) builds this controller,
installs it as `/usr/local/bin/meatgeek-controller` with
[its unit](../data-pusher/deploy/meatgeek-controller.service) (the `meatgeek` system user),
and restarts it. Run it again after pulling a newer build.

Onboarding puts only the binaries and units on the Pi, not this repo. There,
`systemctl status meatgeek-controller` and `journalctl -u meatgeek-controller -f` show the
service and its logs (`make status` and `make logs` run the same, if you have a checkout on the Pi).

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

get_status's `result` string, decoded (from the golden file). A probe with no
reading is `null`; `0` is a real 0 °F reading.

### When a probe has a reading

Every 10 ms the loop samples each probe's resistance (an ADC result `<= 0`
records `0`); every 5 s `internal/rtd.Evaluate` turns the probe's window of
samples into a temperature. The window gives a temperature only when **every**
sample is non-zero and within the resistance range of a Pt1000 between
−40 °F and 800 °F (about 842.7 Ω to 2,562.4 Ω, computed from the same
Callendar–Van Dusen coefficients the conversion uses). The average is then
converted and the probe's `tempCorrection` added; a corrected value outside
−40…800 °F is also no reading.

Otherwise the probe has **no reading** for that window: NaN internally, `null`
in get_status, `unplg` on the LCD. The previous value is never kept, so a probe
unplugged mid-cook stops reporting at the next window. This is what keeps a
floating (unplugged) input, which samples as a mix of zeros and tens of kΩ,
from showing as thousands of degrees (HAR-151). Before the first window every
probe is `null`.

```json
{
  "id": "",
  "ttl": 259200,
  "smokerid": "meatgeek3",
  "type": "",
  "augerOn": false,
  "blowerOn": false,
  "igniterOn": false,
  "temps": {
    "grillTemp": 64.4,
    "probe1Temp": 66.2,
    "probe2Temp": 65.9,
    "probe3Temp": 0,
    "probe4Temp": null
  },
  "fireHealthy": true,
  "mode": "test",
  "setPoint": 200,
  "modeTime": "0001-01-01T00:00:00Z",
  "currentTime": "2026-11-23T15:04:05Z"
}
```

get_temps's `result` is the `temps` object alone.

## Build Information

Run `make info` to see current build configuration:
- Binary name and version
- Build timestamp
- Go version and target platform

## Troubleshooting

### Common Issues

1. **Permission Errors on Pi**: The service runs as `meatgeek`, which needs group `meatgeek` on the SPI and I2C nodes; see the [device runbook](../../docs/devices/runbook.md)
2. **Port Already in Use**: Check if another instance is running
3. **Sensor Read Errors**: Verify hardware connections and try mock sensors

### Debugging

```bash
# Start with debug logging
make dev

# On the Pi: service status and live logs
systemctl status meatgeek-controller
journalctl -u meatgeek-controller -f
```

## Contributing

This project follows the MeatGeek V2 monorepo development practices:
- Use `nx format device-controller` for consistent code formatting
- Run `nx lint device-controller` before committing
- Test changes with `nx test device-controller`