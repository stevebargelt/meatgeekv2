# MeatGeek Data Pusher Service Makefile
# Variables
BINARY_NAME=meatgeek-pusher
SERVICE_NAME=meatgeek-pusher
GO_FILES=$(shell find . -name '*.go' -not -path "./vendor/*")
VERSION := $(shell git describe --tags --always --dirty)
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -ldflags "-X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME)"

# Build commands  
.PHONY: build build-arm test lint format clean dev init-dev check-deps info help status logs deploy-to-pi

# Local development build (native architecture)
build:
	@echo "Building $(BINARY_NAME) for local development..."
	go build $(LDFLAGS) -o dist/$(BINARY_NAME) cmd/main.go
	@echo "✅ Build complete: dist/$(BINARY_NAME)"
	@echo "Building simdevice (host platform only)..."
	go build -o dist/simdevice ./cmd/simdevice
	@echo "✅ Build complete: dist/simdevice"

# Cross-compile for Raspberry Pi (ARM64)
build-arm:
	@echo "Cross-compiling $(BINARY_NAME) for Raspberry Pi (ARM64)..."
	GOARCH=arm64 GOOS=linux go build $(LDFLAGS) -o dist/$(BINARY_NAME)-arm cmd/main.go
	@echo "✅ ARM build complete: dist/$(BINARY_NAME)-arm"

# Run tests
test:
	@echo "Running Go tests..."
	go test -race -v ./...
	@echo "✅ Tests complete"

# Lint code
lint:
	@echo "Running Go linters..."
	@which golangci-lint > /dev/null 2>&1 || (echo "❌ golangci-lint not found. Install with: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest"; exit 1)
	golangci-lint run
	go vet ./...
	@echo "✅ Linting complete"

# Format code
format:
	@echo "Formatting Go code..."
	go fmt ./...
	@which goimports > /dev/null 2>&1 || (echo "⚠️  goimports not found. Install with: go install golang.org/x/tools/cmd/goimports@latest")
	@which goimports > /dev/null 2>&1 && goimports -w . || echo "⚠️  Skipping goimports"
	@echo "✅ Formatting complete"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf dist/
	go clean
	@echo "✅ Clean complete"

# Development mode - connects to local device-controller
dev:
	@echo "Starting data pusher in development mode..."
	@echo "🚀 Starting MeatGeek Data Pusher in development mode"
	@echo "   - Device URL: http://localhost:3000"
	@echo "   - Debug logging enabled"
	@echo "   - Mock IoT Hub connection"
	go run cmd/main.go --device-url=http://localhost:3000 --debug=true --mock-iot=true

# Status and logs
status:
	sudo systemctl status $(SERVICE_NAME)

logs:
	sudo journalctl -u $(SERVICE_NAME) -f

# Deployment: onboard-pi.sh builds the controller and the pusher, installs
# them and the units, enrols the device's own certificate with DPS and starts
# the pusher in DPS mode (HAR-144). Safe to run again on a set-up Pi: it
# restarts the pusher on the new build. Extra options (--device-id, --dps,
# --hub, ...) go in ONBOARD_ARGS. See docs/devices/runbook.md.
deploy-to-pi:
	@if [ -z "$(PI_HOST)" ]; then echo "❌ PI_HOST not set. Usage: make deploy-to-pi PI_HOST=pi@192.168.1.100"; exit 1; fi
	deploy/onboard-pi.sh $(PI_HOST) $(ONBOARD_ARGS)

# Development helpers
init-dev:
	@echo "Initializing development environment..."
	mkdir -p dist
	go mod init github.com/stevebargelt/meatgeekv2/apps/data-pusher 2>/dev/null || true
	go mod tidy
	@echo "✅ Development environment ready"

check-deps:
	@echo "Checking Go dependencies..."
	go mod verify
	go mod tidy
	@echo "✅ Dependencies verified"

# Build info
info:
	@echo "Build Information:"
	@echo "  Binary Name: $(BINARY_NAME)"
	@echo "  Service Name: $(SERVICE_NAME)"
	@echo "  Version: $(VERSION)"
	@echo "  Build Time: $(BUILD_TIME)"
	@echo "  Go Version: $(shell go version)"
	@echo "  Platform: $(shell go env GOOS)/$(shell go env GOARCH)"

# Help
help:
	@echo "MeatGeek Data Pusher Service Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  build         - Build for local development"
	@echo "  build-arm     - Cross-compile for Raspberry Pi (ARM64)"
	@echo "  test          - Run tests"
	@echo "  lint          - Run linters"
	@echo "  format        - Format code"
	@echo "  clean         - Clean build artifacts"
	@echo "  dev           - Start development server with mock IoT Hub"
	@echo "  deploy-to-pi  - Onboard or update a Raspberry Pi with deploy/onboard-pi.sh (requires PI_HOST)"
	@echo "  status        - Show systemd service status"
	@echo "  logs          - Show live logs"
	@echo "  info          - Show build information"
	@echo "  help          - Show this help"
	@echo ""
	@echo "Examples:"
	@echo "  make dev                              # Start development mode"
	@echo "  make deploy-to-pi PI_HOST=pi@192.168.1.100  # Deploy to specific Pi"