# MeatGeek Data Pusher Service Makefile
# Variables
BINARY_NAME=meatgeek-pusher
SERVICE_NAME=meatgeek-pusher
GO_FILES=$(shell find . -name '*.go' -not -path "./vendor/*")
VERSION := $(shell git describe --tags --always --dirty)
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -ldflags "-X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME)"

# Build commands  
.PHONY: build build-arm test lint format clean dev install init-dev check-deps info help status logs deploy-to-pi

# Local development build (native architecture)
build:
	@echo "Building $(BINARY_NAME) for local development..."
	go build $(LDFLAGS) -o dist/$(BINARY_NAME) cmd/main.go
	@echo "✅ Build complete: dist/$(BINARY_NAME)"

# Cross-compile for Raspberry Pi (ARM64)
build-arm:
	@echo "Cross-compiling $(BINARY_NAME) for Raspberry Pi (ARM64)..."
	GOARCH=arm64 GOOS=linux go build $(LDFLAGS) -o dist/$(BINARY_NAME)-arm cmd/main.go
	@echo "✅ ARM build complete: dist/$(BINARY_NAME)-arm"

# Run tests
test:
	@echo "Running Go tests..."
	go test -v ./...
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

# Install as systemd service (on Raspberry Pi).
# Operator MUST populate /etc/meatgeek-pusher/env (chmod 600) with the
# per-device IoT Hub connection string before the service can start cleanly.
# See apps/data-pusher/README.md for the env file contents.
install: build-arm
	@echo "Installing $(BINARY_NAME) as systemd service..."
	sudo install -m 0755 dist/$(BINARY_NAME)-arm /usr/local/bin/$(BINARY_NAME)
	sudo install -d -m 0755 /var/lib/meatgeek-pusher
	sudo install -d -m 0750 /etc/meatgeek-pusher
	sudo cp deploy/$(SERVICE_NAME).service /etc/systemd/system/$(SERVICE_NAME).service
	@echo "⚠️  Ensure /etc/meatgeek-pusher/env exists and is chmod 600 before starting (see README)."
	sudo systemctl daemon-reload
	sudo systemctl enable $(SERVICE_NAME)
	sudo systemctl start $(SERVICE_NAME)
	@echo "✅ Service installed and started"

# Status and logs
status:
	sudo systemctl status $(SERVICE_NAME)

logs:
	sudo journalctl -u $(SERVICE_NAME) -f

# Deployment helpers
deploy-to-pi: build-arm
	@echo "Deploying to Raspberry Pi..."
	@if [ -z "$(PI_HOST)" ]; then echo "❌ PI_HOST not set. Usage: make deploy-to-pi PI_HOST=pi@192.168.1.100"; exit 1; fi
	scp dist/$(BINARY_NAME)-arm $(PI_HOST):~/$(BINARY_NAME)
	ssh $(PI_HOST) 'sudo systemctl stop $(SERVICE_NAME) || true'
	ssh $(PI_HOST) 'sudo cp ~/$(BINARY_NAME) /usr/local/bin/$(BINARY_NAME)'
	ssh $(PI_HOST) 'sudo systemctl start $(SERVICE_NAME)'
	@echo "✅ Deployment complete"

# Development helpers
init-dev:
	@echo "Initializing development environment..."
	mkdir -p dist
	go mod init meatgeek-pusher 2>/dev/null || true
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
	@echo "  install       - Install as systemd service (Raspberry Pi)"
	@echo "  deploy-to-pi  - Deploy to Raspberry Pi (requires PI_HOST)"
	@echo "  status        - Show systemd service status"
	@echo "  logs          - Show live logs"
	@echo "  info          - Show build information"
	@echo "  help          - Show this help"
	@echo ""
	@echo "Examples:"
	@echo "  make dev                              # Start development mode"
	@echo "  make deploy-to-pi PI_HOST=pi@192.168.1.100  # Deploy to specific Pi"