# MeatGeek Device Controller Makefile
# Variables
BINARY_NAME=meatgeek-controller
GO_FILES=$(shell find . -name '*.go' -not -path "./vendor/*")
VERSION := $(shell git describe --tags --always --dirty)
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -ldflags "-X main.Version=$(VERSION) -X main.BuildTime=$(BUILD_TIME)"

# Build commands
.PHONY: build build-arm build-windows test lint format clean dev status logs init-dev check-deps info help

# Local development build (native architecture)
build:
	@echo "Building $(BINARY_NAME) for local development..."
	go build $(LDFLAGS) -o dist/$(BINARY_NAME) main.go
	@echo "✅ Build complete: dist/$(BINARY_NAME)"

# Cross-compile for the Pi (linux/arm64: Raspberry Pi OS Lite 64-bit, Debian Trixie)
build-arm:
	@echo "Cross-compiling $(BINARY_NAME) for the Pi (linux/arm64)..."
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
	go test -race -tags testserver -v ./...
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

# Status and logs
status:
	sudo systemctl status meatgeek-controller

logs:
	sudo journalctl -u meatgeek-controller -f

# Getting a build onto a Pi: there is no deploy target here. Onboard or
# update a Pi with apps/data-pusher/deploy/onboard-pi.sh (make deploy-to-pi in
# apps/data-pusher), which builds this controller, installs it as
# /usr/local/bin/meatgeek-controller with its unit and restarts it. See
# docs/devices/runbook.md.

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
	@echo "  build-arm     - Cross-compile for the Pi (linux/arm64)"
	@echo "  build-windows - Cross-compile for Windows"
	@echo "  test          - Run tests"
	@echo "  lint          - Run linters"
	@echo "  format        - Format code"
	@echo "  clean         - Clean build artifacts"
	@echo "  dev           - Start development server with mock sensors"
	@echo "  status        - Show systemd service status (on the Pi)"
	@echo "  logs          - Show live logs (on the Pi)"
	@echo "  info          - Show build information"
	@echo "  help          - Show this help"
	@echo ""
	@echo "Examples:"
	@echo "  make dev                              # Start development server"
	@echo ""
	@echo "To put a build on a Pi, see docs/devices/runbook.md (apps/data-pusher: make deploy-to-pi)."
