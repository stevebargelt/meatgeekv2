# MeatGeek V2 Monorepo Structure

## Repository Overview

The entire MeatGeek V2 system is organized as an **NX monorepo** hosted at `https://github.com/stevebargelt/meatgeekv2`. This structure provides unified development, build, and deployment workflows while enabling maximum code reuse and consistency across all applications.

## NX Workspace Structure

```
meatgeekv2/
├── apps/                           # Deployable applications
│   ├── api/                       # Azure Functions API (TypeScript)
│   ├── mobile/                    # React Native mobile app (primary)
│   ├── web/                       # React web application (secondary)
│   ├── device-controller/         # Enhanced Raspberry Pi controller (Go)
│   ├── data-pusher/              # IoT Hub integration service (Go)
│   ├── device-simulator/         # Development and testing tool
│   └── infrastructure/           # Terraform Infrastructure as Code
├── libs/                          # Shared libraries and utilities
│   ├── api-interfaces/           # TypeScript types and interfaces
│   ├── ui-components/            # Shared React/React Native components
│   ├── data-models/              # Domain models and business logic
│   ├── azure-client/             # Azure service clients
│   ├── realtime/                 # SignalR real-time communication
│   ├── charts/                   # Data visualization components
│   ├── tracing/                  # OpenTelemetry observability
│   ├── api-specs/                # OpenAPI 3.0 specifications
│   └── utils/                    # Common utilities
├── tools/                         # Build scripts and generators
├── .github/workflows/             # CI/CD pipeline definitions
└── configuration files            # NX, TypeScript, ESLint, Jest configs
```

## Application Details

### Core Applications (`apps/`)

#### 1. Azure Functions API (`apps/api/`)
**Purpose**: Serverless API and telemetry processing  
**Technology**: TypeScript + Azure Functions  

```
apps/api/
├── src/
│   ├── functions/              # Individual Azure Functions
│   │   ├── cooks/              # Cook management endpoints
│   │   ├── temperatures/       # Temperature processing and queries
│   │   ├── devices/            # Device management
│   │   └── auth/               # Authentication functions
│   ├── shared/                 # Function utilities
│   │   ├── middleware/         # OpenAPI validation, auth
│   │   ├── services/           # Business logic services
│   │   └── adapters/           # EventData processing
│   └── main.ts                 # Function app entry point
├── host.json                   # Azure Functions host config
├── local.settings.json         # Local development settings
└── project.json                # NX project configuration
```

#### 2. Mobile Application (`apps/mobile/`)
**Purpose**: Primary user interface for BBQ monitoring  
**Technology**: React Native with TypeScript  

```
apps/mobile/
├── src/
│   ├── screens/                # App screens (Home, Cook, History)
│   ├── components/             # Mobile-specific components
│   ├── navigation/             # React Navigation setup
│   ├── services/               # API clients and real-time connections
│   ├── store/                  # State management
│   └── utils/                  # Mobile utilities
├── android/                    # Android-specific configuration
├── ios/                        # iOS-specific configuration
└── project.json                # NX build and deployment configs
```

#### 3. Web Application (`apps/web/`)
**Purpose**: Secondary interface with advanced analytics  
**Technology**: React with TypeScript  

```
apps/web/
├── src/
│   ├── pages/                  # Web pages/routes
│   ├── components/             # Web-specific components
│   ├── hooks/                  # Custom React hooks
│   ├── services/               # API integration
│   └── styles/                 # Styling and themes
├── public/                     # Static assets
└── project.json                # NX web app configuration
```

#### 4. Device Controller (`apps/device-controller/`)
**Purpose**: Enhanced version of existing Raspberry Pi controller  
**Technology**: Go with hardware integration  

```
apps/device-controller/
├── cmd/                        # Application entry points
├── internal/                   # Private application code
│   ├── sensors/                # RTD sensor reading logic
│   ├── display/                # LCD display management  
│   ├── api/                    # Local HTTP API server
│   └── config/                 # Configuration management
├── pkg/                        # Public/reusable packages
├── goqueue/                    # Existing temperature averaging
├── main.go                     # Main application
├── go.mod                      # Go module definition
├── Makefile                    # Go build commands and tooling
└── project.json                # NX orchestration configuration
```

#### 5. Data Pusher (`apps/data-pusher/`)
**Purpose**: Reliable IoT Hub communication service  
**Technology**: Go service  

```
apps/data-pusher/
├── cmd/                        # Service entry point
├── internal/                   # Private service logic
│   ├── collector/              # Temperature data collection
│   ├── buffer/                 # Local buffering and retry logic
│   ├── iothub/                 # Azure IoT Hub client
│   └── telemetry/              # OpenTelemetry integration
├── pkg/                        # Shared packages
├── go.mod                      # Go module definition
├── Makefile                    # Go build commands and tooling
└── project.json                # NX orchestration configuration
```

#### 6. Infrastructure (`apps/infrastructure/`)
**Purpose**: Terraform Infrastructure as Code  
**Technology**: Terraform with NX integration  

```
apps/infrastructure/
├── environments/               # Environment-specific variables
│   ├── dev.tfvars
│   ├── staging.tfvars
│   └── prod.tfvars
├── modules/                    # Reusable Terraform modules
│   ├── iot-hub/
│   ├── cosmos-db/
│   ├── functions/
│   ├── signalr/
│   └── monitoring/
├── main.tf                     # Root Terraform configuration
├── backend.tf                  # Remote state configuration
├── versions.tf                 # Provider constraints
└── project.json                # NX Terraform commands
```

### Go Project Integration Strategy

**Challenge**: NX is designed for JavaScript/TypeScript ecosystems, while Go has its own build tooling and conventions.

**Solution**: Use **Makefiles for Go projects** with NX orchestration - this provides the best of both worlds:

#### Makefile-Based Approach

Each Go project (`device-controller` and `data-pusher`) uses a standard Makefile:

**Example Makefile** (`apps/device-controller/Makefile`):
```makefile
# Variables
BINARY_NAME=MeatGeek-DeviceController
GO_FILES=$(shell find . -name '*.go' -not -path "./vendor/*")

# Build commands
.PHONY: build build-arm build-windows test lint format clean dev

# Local development build
build:
	go build -o dist/$(BINARY_NAME) main.go

# Cross-compile for Raspberry Pi (ARM64)
build-arm:
	GOARCH=arm64 GOOS=linux go build -o dist/$(BINARY_NAME)-arm main.go

# Cross-compile for Windows (if needed)
build-windows:
	GOARCH=amd64 GOOS=windows go build -o dist/$(BINARY_NAME).exe main.go

# Run tests
test:
	go test -v ./...
	go test -v ./goqueue

# Lint code
lint:
	golangci-lint run
	go vet ./...

# Format code
format:
	go fmt ./...
	goimports -w .

# Clean build artifacts
clean:
	rm -rf dist/
	go clean

# Development server with mock sensors
dev:
	go run main.go --mock-sensors=true --debug=true
```

**Similar Makefile for Data Pusher** (`apps/data-pusher/Makefile`):
```makefile
# Variables
BINARY_NAME=meatgeek-pusher
SERVICE_NAME=meatgeek-pusher

# Build commands  
.PHONY: build build-arm test lint format clean dev install

build:
	go build -o dist/$(BINARY_NAME) cmd/main.go

build-arm:
	GOARCH=arm64 GOOS=linux go build -o dist/$(BINARY_NAME)-arm cmd/main.go

test:
	go test -v ./...

lint:
	golangci-lint run
	go vet ./...

format:
	go fmt ./...
	goimports -w .

clean:
	rm -rf dist/
	go clean

# Development mode - connects to local device-controller
dev:
	go run cmd/main.go --device-url=http://localhost:3000 --debug=true

# Install as systemd service (on Raspberry Pi)
install:
	sudo cp dist/$(BINARY_NAME) /usr/local/bin/
	sudo cp $(SERVICE_NAME).service /etc/systemd/system/
	sudo systemctl enable $(SERVICE_NAME)
	sudo systemctl start $(SERVICE_NAME)
```

#### NX Integration via project.json

NX orchestrates by calling Make targets, not managing Go directly:

**Example project.json** (`apps/device-controller/project.json`):
```json
{
  "name": "device-controller",
  "sourceRoot": "apps/device-controller",
  "projectType": "application",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make build",
        "cwd": "apps/device-controller"
      }
    },
    "build-arm": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make build-arm",
        "cwd": "apps/device-controller"
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make test",
        "cwd": "apps/device-controller"
      }
    },
    "lint": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make lint",
        "cwd": "apps/device-controller"
      }
    },
    "serve": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make dev",
        "cwd": "apps/device-controller"
      }
    },
    "format": {
      "executor": "nx:run-commands",
      "options": {
        "command": "make format",
        "cwd": "apps/device-controller"
      }
    }
  },
  "tags": ["type:app", "platform:go", "scope:device"]
}
```

#### Benefits of This Approach

1. **Idiomatic Go Development**: Developers can use standard Go tools and workflows
2. **Flexibility**: Easy to add complex Go-specific build steps in Makefiles  
3. **Cross-compilation Simplicity**: Make handles GOARCH/GOOS settings cleanly
4. **Debugging**: Can run `make build` directly when troubleshooting
5. **CI/CD Compatibility**: Standard Make targets work in any CI system
6. **NX Benefits Preserved**: Affected detection, parallel builds, unified commands still work

#### Developer Experience

```bash
# NX commands (recommended for consistency)
nx build device-controller      # Calls: make build
nx build-arm device-controller  # Calls: make build-arm  
nx test device-controller       # Calls: make test
nx serve device-controller      # Calls: make dev

# Direct Make commands (when debugging)
cd apps/device-controller
make build                      # Direct build
make test                       # Direct test
make lint                       # Direct lint
```

This approach maintains the monorepo benefits while respecting Go's ecosystem and development practices.

## Shared Libraries (`libs/`)

### Core Libraries

#### 1. API Interfaces (`libs/api-interfaces/`)
**Purpose**: Shared TypeScript types ensuring consistency  

```typescript
// Example interfaces
export interface TemperatureReading {
  deviceId: string;
  timestamp: Date;
  cookId?: string;
  grillTemp?: number;
  probe1Temp?: number;
  probe2Temp?: number;
  probe3Temp?: number;
  probe4Temp?: number;
}

export interface Cook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  status: 'planning' | 'active' | 'paused' | 'completed';
  startTime: Date;
  endTime?: Date;
  targetTemps?: TargetTemperatures;
}
```

#### 2. UI Components (`libs/ui-components/`)
**Purpose**: Reusable components across mobile and web  

```
libs/ui-components/
├── src/lib/
│   ├── TemperatureDisplay/     # Live temperature readouts
│   ├── CookCard/               # Cook session cards
│   ├── DeviceStatus/           # Device health indicators
│   ├── ChartComponents/        # Base chart components
│   ├── LoadingSpinner/         # Shared loading states
│   └── ErrorBoundary/          # Error handling components
└── index.ts                    # Library exports
```

#### 3. Data Models (`libs/data-models/`)
**Purpose**: Business logic and domain models  

```typescript
// Example business logic
export class CookManager {
  static async startCook(request: StartCookRequest): Promise<Cook> {
    // Validation, business rules, cook creation logic
  }
  
  static calculateCookProgress(cook: Cook, temps: TemperatureReading[]): number {
    // Cook completion percentage based on target temps
  }
}

export class TemperatureCalculator {
  static getResistanceFromADC(adcValue: number): number {
    // RTD resistance calculation
  }
  
  static getFahrenheitFromResistance(resistance: number): number {
    // Temperature conversion with calibration
  }
}
```

#### 4. Azure Client (`libs/azure-client/`)
**Purpose**: Centralized Azure service integration  

```typescript
export class CosmosClient {
  async saveTemperatureReading(reading: TemperatureReading): Promise<void> { }
  async queryCookTemperatures(cookId: string): Promise<TemperatureReading[]> { }
}

export class IoTHubClient {
  async sendTelemetry(deviceId: string, data: any): Promise<void> { }
}

export class SignalRService {
  async sendToGroup(groupName: string, method: string, data: any): Promise<void> { }
}
```

#### 5. OpenAPI Specifications (`libs/api-specs/`)
**Purpose**: Contract-first API development  

```
libs/api-specs/
├── specs/                      # OpenAPI specifications
│   ├── meatgeek-api.yaml      # Main API spec
│   ├── components/            # Reusable components
│   └── paths/                 # API endpoint definitions
├── tools/                     # Code generation scripts
├── generated/                 # Auto-generated types and clients
└── project.json               # Build and validation commands
```

## NX Workspace Benefits

### 1. Code Reuse and Consistency
- **Shared interfaces** ensure type safety across applications
- **Common components** reduce duplication between mobile and web
- **Business logic libraries** prevent logic drift
- **Unified coding standards** with shared ESLint/Prettier configs

### 2. Efficient Development Workflow
- **Single installation**: `npm install` for entire workspace
- **Parallel execution**: Build, test, lint multiple projects simultaneously
- **Incremental builds**: Only rebuild affected projects after changes
- **Dependency visualization**: `nx dep-graph` shows project relationships

### 3. Build Optimization
- **Affected commands**: `nx affected:build` only builds changed projects
- **Distributed caching**: NX Cloud caches build artifacts
- **Smart rebuilding**: Detects file changes and dependencies
- **Optimized CI/CD**: Pipeline runs only necessary jobs

### 4. Developer Experience
- **IntelliSense**: Auto-completion across project boundaries
- **Refactoring**: Safe renames and moves across all projects
- **Unified debugging**: Single development environment
- **Easy navigation**: Go-to-definition works across libraries

## Common Development Commands

```bash
# Workspace management
npm install                          # Install all dependencies
nx dep-graph                        # Visualize project dependencies

# Building projects
nx build api                        # Build specific project
nx build mobile --platform=ios     # Build with platform options
nx affected:build                   # Build only affected projects
nx run-many --target=build --all    # Build all projects

# Development servers
nx serve web                        # Start web development server
nx serve mobile                     # Start React Native development

# Testing and quality
nx test api                         # Test specific project
nx affected:test                    # Test affected projects
nx lint api                         # Lint specific project
nx affected:lint                    # Lint affected projects

# Infrastructure and deployment
nx plan infrastructure --env=dev    # Plan Terraform changes
nx apply infrastructure --env=dev   # Apply infrastructure
nx deploy api                       # Deploy Azure Functions
```

## Project Dependencies

The monorepo dependency graph flows from shared libraries to applications:

```
                    apps/api
                       ↑
libs/api-interfaces ←──┼──→ apps/mobile
                       ↑        ↑
libs/data-models ──────┼────────┘
                       ↑
libs/azure-client ─────┼──→ apps/web
                       ↑
libs/tracing ──────────┘

libs/ui-components ──→ apps/mobile
                   └──→ apps/web

libs/charts ───────────→ apps/web
```

This structure ensures that:
- Applications depend on libraries, not other applications
- Shared logic lives in libraries for maximum reuse
- Type safety is maintained across all boundaries
- Changes to libraries trigger rebuilds of dependent applications

---

> **Next Steps**: Review [Data Flow](data-flow.md) to understand how data moves through this architecture, or check [Local Setup](../development/local-setup.md) to start developing.