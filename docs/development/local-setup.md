# Local Development Setup

## Prerequisites

### Required Software
- **Node.js** (v20 or later) with npm
- **NX CLI**: `npm install -g nx`
- **Go** (v1.21 or later) for device controller and data pusher
- **Go Tools** for development:
  - `golangci-lint` for linting: `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`
  - `goimports` for imports: `go install golang.org/x/tools/cmd/goimports@latest`
- **Make** for Go build orchestration (usually pre-installed on macOS/Linux)
- **Azure CLI** for cloud integration
- **Terraform** (v1.9+) for infrastructure management
- **Git** for version control

### Development Tools (Recommended)
- **VS Code** with extensions:
  - NX Console
  - Azure Functions
  - Go extension
  - TypeScript/JavaScript support
  - Terraform extension

## Quick Start

### 1. Clone and Initialize

```bash
# Clone the monorepo
git clone https://github.com/stevebargelt/meatgeekv2
cd meatgeekv2

# Install all dependencies
npm install

# Verify NX installation
nx --version
```

### 2. Environment Configuration

Create environment files for local development:

**.env.local** (root directory):
```bash
# Azure Configuration
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_SUBSCRIPTION_ID=your-subscription-id

# CosmosDB Connection
COSMOSDB_CONNECTION_STRING=your-cosmos-connection-string
COSMOSDB_DATABASE_NAME=meatgeek

# IoT Hub Configuration
IOTHUB_CONNECTION_STRING=your-iothub-connection-string
DEVICE_CONNECTION_STRING=your-device-connection-string

# SignalR Configuration
SIGNALR_CONNECTION_STRING=your-signalr-connection-string

# Application Insights
APPINSIGHTS_CONNECTION_STRING=your-appinsights-connection-string
```

### 3. Set Up Development Infrastructure

```bash
# Initialize Terraform for development environment
nx init infrastructure

# Plan and apply development infrastructure
nx plan infrastructure --env=dev
nx apply infrastructure --env=dev
```

### 4. Start Development Services

```bash
# Start all development services
nx run-many --target=serve --all

# Or start services individually
nx serve web          # React web app (http://localhost:3000)
nx serve mobile       # React Native mobile app
nx serve api          # Azure Functions (http://localhost:7071)
```

## Development Workflow

### Daily Development Commands

```bash
# Check what projects are affected by your changes
nx affected:graph

# Run tests for affected projects
nx affected:test

# Build affected projects
nx affected:build

# Lint affected projects
nx affected:lint

# Format all code
nx format:write
```

### Working with Shared Libraries

```bash
# Generate a new shared library
nx generate @nx/js:library my-new-lib --directory=libs

# Generate a new React component in ui-components
nx generate @nx/react:component MyComponent --project=ui-components

# Update API interfaces (triggers rebuild of dependent projects)
nx build api-interfaces
```

### Device Development (Go + Makefiles)

The Go applications use Makefiles for build management, with NX providing orchestration:

```bash
# Build device controller for local testing (native architecture)
nx build device-controller       # Calls: make build

# Cross-compile for Raspberry Pi deployment (ARM64)
nx build-arm device-controller   # Calls: make build-arm

# Development with mock sensors
nx serve device-controller       # Calls: make dev (runs with --mock-sensors=true)

# Alternative: Direct Make commands for debugging
cd apps/device-controller
make build                       # Direct local build
make build-arm                   # Direct ARM build
make dev                         # Development server
make test                        # Run Go tests
make lint                        # Run linting
make format                      # Format Go code
```

## Project Structure Overview

```
meatgeekv2/
├── apps/                       # Deployable applications
│   ├── api/                   # Azure Functions
│   ├── mobile/                # React Native app
│   ├── web/                   # React web app
│   ├── device-controller/     # Go device controller
│   ├── data-pusher/          # Go IoT service
│   └── infrastructure/       # Terraform IaC
├── libs/                      # Shared libraries
│   ├── api-interfaces/       # TypeScript types
│   ├── ui-components/        # React components
│   ├── data-models/          # Business logic
│   ├── azure-client/         # Cloud integrations
│   └── ...
└── tools/                    # Build and deployment scripts
```

## IDE Configuration

### VS Code Settings (`.vscode/settings.json`)

```json
{
  "typescript.preferences.includePackageJsonAutoImports": "on",
  "typescript.suggest.autoImports": true,
  "eslint.workingDirectories": ["apps", "libs"],
  "go.gopath": "apps/device-controller",
  "files.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.terraform": true
  }
}
```

### Recommended VS Code Extensions

```json
{
  "recommendations": [
    "nrwl.angular-console",
    "ms-azuretools.vscode-azurefunctions",
    "golang.go",
    "hashicorp.terraform",
    "ms-vscode.vscode-typescript-next",
    "bradlc.vscode-tailwindcss",
    "ms-vscode-remote.remote-containers"
  ]
}
```

## Testing Strategy

### Unit Testing
```bash
# Run all tests
nx test api
nx test ui-components
nx test data-models

# Run tests in watch mode
nx test api --watch

# Run tests with coverage
nx test api --coverage
```

### Integration Testing
```bash
# Test API endpoints with local Azure Functions
nx serve api
npm run test:integration

# Test mobile app with simulator
nx serve mobile --platform=ios
nx test mobile --platform=ios
```

### End-to-End Testing
```bash
# Start all services and run E2E tests
nx run-many --target=serve --projects=api,web --parallel
nx e2e web-e2e
```

## Debugging

### Azure Functions Debugging
1. Start Functions runtime: `nx serve api`
2. Attach VS Code debugger to port 7071
3. Set breakpoints in TypeScript files
4. Send requests to `http://localhost:7071/api/...`

### Mobile App Debugging
```bash
# iOS simulator
nx serve mobile --platform=ios
nx run mobile:debug --platform=ios

# Android emulator
nx serve mobile --platform=android
nx run mobile:debug --platform=android
```

### Device Controller Debugging
```bash
# Local testing with mock sensors
nx serve device-controller       # Starts with --mock-sensors=true --debug=true

# Direct Make for debugging builds
cd apps/device-controller
make dev                         # Run with debug flags
make build                       # Build with debug symbols

# Remote debugging on Raspberry Pi
ssh pi@your-device-ip
sudo systemctl stop meatgeek-controller
cd /home/pi
make build                       # If Makefile deployed to Pi
./MeatGeek-DeviceController --debug --mock-sensors=false
```

## Common Issues & Solutions

### Node.js Memory Issues
```bash
# Increase Node.js heap size
export NODE_OPTIONS="--max-old-space-size=8192"
nx build api
```

### Go Cross-compilation Issues
```bash
# The Makefile handles GOARCH/GOOS automatically
nx build-arm device-controller   # This calls make build-arm

# If issues persist, check Make targets directly:
cd apps/device-controller
make clean                       # Clean previous builds
make build-arm                   # Direct ARM build

# Verify Go environment:
go env GOARCH GOOS              # Check current settings
```

### Terraform State Locking
```bash
# If state is locked, force unlock (use carefully)
terraform force-unlock <lock-id> -force
```

### Azure Functions Local Development
```bash
# Install Azure Functions Core Tools
npm install -g azure-functions-core-tools@4

# Start with specific port
nx serve api --port=7072
```

## Performance Optimization

### NX Build Cache
```bash
# Enable NX Cloud for distributed caching (optional)
nx connect-to-nx-cloud

# Clear local cache if needed
nx reset
```

### Development Build Optimization
```bash
# Use affected commands to build only changed projects
nx affected:build --base=main

# Parallel execution for faster builds
nx run-many --target=build --all --parallel=4
```

## Getting Help

- **NX Documentation**: [https://nx.dev](https://nx.dev)
- **Project Documentation**: See `/docs` directory
- **Azure Functions**: [Azure Functions Documentation](https://docs.microsoft.com/en-us/azure/azure-functions/)
- **React Native**: [React Native Documentation](https://reactnative.dev/)

## Next Steps

1. **Review Architecture**: [System Overview](../architecture/system-overview.md)
2. **Set up Infrastructure**: [Terraform Setup](../infrastructure/terraform-setup.md) 
3. **Start Development**: [NX Commands](nx-commands.md)
4. **API Development**: [OpenAPI Specifications](../api/openapi-specs.md)

---

> **Tip**: Use `nx dep-graph` to visualize project dependencies and understand the system architecture visually.