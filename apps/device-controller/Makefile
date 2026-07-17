# MeatGeek Device Controller Makefile
# Variables
BINARY_NAME=MeatGeek-DeviceController
GO_FILES=$(shell find . -name '*.go' -not -path "./vendor/*")
VERSION := $(shell git describe --tags --always --dirty)
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -ldflags "-X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME)"

# Build commands
.PHONY: build build-arm build-windows test lint format clean dev install

# Local development build (native architecture)
build:
	@echo "Building $(BINARY_NAME) for local development..."
	go build $(LDFLAGS) -o dist/$(BINARY_NAME) main.go
	@echo "✅ Build complete: dist/$(BINARY_NAME)"

# Cross-compile for Raspberry Pi OS (linux/arm64)
build-arm:
	@echo "Cross-compiling $(BINARY_NAME) for Raspberry Pi OS (linux/arm64)..."
	GOARCH=arm64 GOOS=linux go build $(LDFLAGS) -o dist/$(BINARY_NAME)-arm main.go
	@echo "✅ ARM build complete: dist/$(BINARY_NAME)-arm"

# Cross-compile for Windows (if needed)
build-windows:
	@echo "Cross-compiling $(BINARY_NAME) for Windows..."
	GOARCH=amd64 GOOS=windows go build $(LDFLAGS) -o dist/$(BINARY_NAME).exe main.go
	@echo "✅ Windows build complete: dist/$(BINARY_NAME).exe"

# Run tests
test:
	@echo "Running Go tests..."
	go test -tags testserver -v ./...
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

# Development server with mock sensors
dev:
	@echo "Starting development server with mock sensors..."
	@echo "🚀 Starting MeatGeek Device Controller in development mode"
	@echo "   - Mock sensors enabled"
	@echo "   - Debug logging enabled"
	@echo "   - API available at http://localhost:3000"
	go run main.go --mock-sensors=true --debug=true

# Install as systemd service (on Raspberry Pi)
install: build-arm
	@echo "Installing $(BINARY_NAME) as systemd service..."
	sudo cp dist/$(BINARY_NAME)-arm /usr/local/bin/$(BINARY_NAME)
	@echo "Creating systemd service file..."
	@echo "[Unit]" | sudo tee /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "Description=MeatGeek Device Controller" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "After=network.target" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "[Service]" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "Type=simple" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "User=pi" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "WorkingDirectory=/home/pi" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "ExecStart=/usr/local/bin/$(BINARY_NAME)" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "Restart=always" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "RestartSec=5" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "[Install]" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	@echo "WantedBy=multi-user.target" | sudo tee -a /etc/systemd/system/meatgeek-controller.service > /dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable meatgeek-controller
	sudo systemctl start meatgeek-controller
	@echo "✅ Service installed and started"

# Status and logs
status:
	sudo systemctl status meatgeek-controller

logs:
	sudo journalctl -u meatgeek-controller -f

# Deployment helpers
deploy-to-pi: build-arm
	@echo "Deploying to Raspberry Pi..."
	@if [ -z "$(PI_HOST)" ]; then echo "❌ PI_HOST not set. Usage: make deploy-to-pi PI_HOST=pi@192.168.1.100"; exit 1; fi
	scp dist/$(BINARY_NAME)-arm $(PI_HOST):~/$(BINARY_NAME)
	ssh $(PI_HOST) 'sudo systemctl stop meatgeek-controller || true'
	ssh $(PI_HOST) 'sudo cp ~/$(BINARY_NAME) /usr/local/bin/$(BINARY_NAME)'
	ssh $(PI_HOST) 'sudo systemctl start meatgeek-controller'
	@echo "✅ Deployment complete"

# Development helpers
init-dev:
	@echo "Initializing development environment..."
	mkdir -p dist
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
	@echo "  Version: $(VERSION)"
	@echo "  Build Time: $(BUILD_TIME)"
	@echo "  Go Version: $(shell go version)"
	@echo "  Platform: $(shell go env GOOS)/$(shell go env GOARCH)"

# Help
help:
	@echo "MeatGeek Device Controller Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  build         - Build for local development"
	@echo "  build-arm     - Cross-compile for Raspberry Pi OS (linux/arm64)"
	@echo "  build-windows - Cross-compile for Windows"
	@echo "  test          - Run tests"
	@echo "  lint          - Run linters"
	@echo "  format        - Format code"
	@echo "  clean         - Clean build artifacts"
	@echo "  dev           - Start development server with mock sensors"
	@echo "  install       - Install as systemd service (Raspberry Pi)"
	@echo "  deploy-to-pi  - Deploy to Raspberry Pi (requires PI_HOST)"
	@echo "  status        - Show systemd service status"
	@echo "  logs          - Show live logs"
	@echo "  info          - Show build information"
	@echo "  help          - Show this help"
	@echo ""
	@echo "Examples:"
	@echo "  make dev                              # Start development server"
	@echo "  make deploy-to-pi PI_HOST=pi@192.168.1.100  # Deploy to specific Pi"