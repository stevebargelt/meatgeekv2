# MeatGeek V2 Monorepo Structure

## Repository Overview

The entire MeatGeek V2 system is organized as an **NX monorepo** hosted at `https://github.com/stevebargelt/meatgeekv2`. This structure provides unified development, build, and deployment workflows while enabling maximum code reuse and consistency across all applications.

## NX Workspace Structure

```
meatgeekv2/
├── apps/                           # Deployable applications and their tests
│   ├── api/                       # Azure Functions API (TypeScript)
│   ├── data-pusher/              # IoT Hub integration service (Go), plus cmd/simdevice
│   ├── device-controller/         # Enhanced Raspberry Pi controller (Go)
│   ├── infrastructure/           # Terraform Infrastructure as Code
│   ├── web/                       # React web application (Vercel)
│   └── web-e2e/                   # Playwright browser tests of the web app
├── libs/                          # Shared libraries and utilities
│   ├── api-interfaces/           # TypeScript types and interfaces
│   ├── api-specs/                # OpenAPI 3.0 specification and generated types
│   ├── data-models/              # Domain models and business logic
│   └── utils/                    # Common utilities
├── docs/architecture/likec4/      # The LikeC4 architecture model
├── tools/                         # Repository tooling
│   ├── test-repeat/              # Runs each test suite N times in a row and with K parallel copies
│   └── no-real-time/             # The guard against real-time waits in tests
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

#### 2. Mobile Application (`apps/ios/`, skeleton)
**Purpose**: Mobile interface for BBQ monitoring  
**Technology**: Native iOS app in Swift  

The mobile client is a native iOS (Swift) app in `apps/ios`. So far it is a skeleton in `apps/ios` (HAR-158) that builds and tests in the simulator, with Entra sign-in through MSAL (HAR-162; it shows "Sign-in is not configured" until the iOS client id is in its config) and a placeholder home. It is not an Nx project in this workspace: it builds with Xcode, from `MeatGeek.xcodeproj` and the local Swift package `MeatGeekKit`, which holds its logic. CI's `ios` job builds it and runs its unit and UI tests on a macOS runner on every pull request and push (HAR-160, see [CI/CD](../development/ci-cd.md#ios-job-har-160)). See [`apps/ios/README.md`](../../apps/ios/README.md). Because it is Swift, it shares no TypeScript code with the web app: the only thing the two clients share is the OpenAPI contract in `libs/api-specs/spec`.

#### 3. Web Application (`apps/web/`)
**Purpose**: The live client: sign in, devices, cooks, a live panel by push and a chart of the whole cook  
**Technology**: React 18, Vite, TypeScript; MSAL, openapi-fetch, `@microsoft/signalr`, recharts  

Served by Vercel production at `https://meatgeekv2-web.vercel.app`, built by Vercel's Git integration from every push to `main`.

```
apps/web/
├── src/
│   ├── app/                    # Routes and status pages
│   ├── auth/                   # MSAL instance and the silent token
│   ├── config/                 # /config.json, fetched and validated before render
│   ├── api/                    # openapi-fetch client (types from libs/api-specs)
│   ├── devices/                # Devices page: list, claim, rename, release
│   ├── cooks/                  # Cooks list, start form, cook detail, chart
│   └── live/                   # SignalR connection and the live panel
├── build/                      # version.json generation
├── public/                     # Static assets and config.json
└── project.json                # NX web app configuration
```

#### 4. Web Browser Tests (`apps/web-e2e/`)
**Purpose**: Playwright tests of the web app  
**Technology**: Playwright, TypeScript  

```
apps/web-e2e/
├── src/                        # `nx e2e web-e2e`: the main path against the built app
│   └── fakes/                  # Entra, the API and the SignalR hub, faked at the network edge
├── live/                       # `nx e2e-live web-e2e`: the live browser proof against production
├── playwright.config.ts
├── playwright.live.config.ts
└── project.json
```

`nx e2e web-e2e` runs in CI's `web-e2e` job on every pull request and push: it needs no secret and no network beyond the installs. `nx e2e-live web-e2e` runs only in Deploy Dev App's `web-acceptance` job: it signs in on Microsoft's real pages as the TOTP acceptance user, starts a cook on `<simulated_device_id>-web` and waits for a reading pushed by `simdevice` (see `docs/development/live-acceptance.md`).

#### 5. Device Controller (`apps/device-controller/`)
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

#### 6. Data Pusher (`apps/data-pusher/`)
**Purpose**: Reliable IoT Hub communication service  
**Technology**: Go service  

```
apps/data-pusher/
├── cmd/                        # Service entry point
├── deploy/                     # onboard-pi.sh, enrol-, revoke- and delete-device.sh, systemd units, udev rule
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

#### 7. Infrastructure (`apps/infrastructure/`)
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

#### 2. Data Models (`libs/data-models/`)
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

#### 3. OpenAPI Specifications (`libs/api-specs/`)
**Purpose**: The API contract the clients share: every HTTP route `apps/api` serves and every SignalR message it sends. `npx nx test api` fails when the spec and `apps/api/src/main.ts` disagree (see `libs/api-specs/README.md`).

```
libs/api-specs/
├── spec/                      # OpenAPI 3.0 specification
│   ├── openapi.yaml           # Entrypoint (paths, x-signalr, components)
│   ├── components/            # Schemas, responses, headers, parameters
│   └── paths/                 # API endpoint definitions
├── contract-tests/            # Spec-only checks (nx test api-specs)
├── src/                       # Swagger UI helper; generated/ types (not checked in)
└── project.json               # validate-spec, generate-types
```

### Buildable Library Pattern

Libraries that are compiled into a dependent app's build — the API dependency chain `api-interfaces`, `utils`, and `data-models` — each carry a minimal `package.json` whose `name` matches the library's `@meatgeekv2/*` alias in `tsconfig.base.json`:

```json
// libs/api-interfaces/package.json
{
  "name": "@meatgeekv2/api-interfaces",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
```

This `package.json` is **required** for the build to succeed. When NX builds an app or a dependent library with `@nx/js:tsc`, it rewrites each `@meatgeekv2/*` alias to point at the library's compiled `dist` output via its `updatePaths()` step, keyed on the `name` in that library's `package.json`. Without the `package.json`, the remap is inert, the alias stays pointed at source, and `nx build` fails with `TS6059` (`file is not under 'rootDir'`) for the depended-on library.

The alias entries in `tsconfig.base.json` intentionally still point at source (`libs/*/src/index.ts`) and must **not** be changed to point at `dist`. Source resolution is what Jest's `moduleNameMapper` and IDE go-to-definition rely on; the `dist` remap happens only at build time via the per-library `package.json`. In other words: `tsconfig.base.json` = source (for tests and editors), library `package.json` name = build-time `dist` remap.

When you add a new buildable library, give it a `package.json` whose `name` is its `tsconfig.base.json` alias, or apps and libraries that depend on it will fail to build.

## NX Workspace Benefits

### 1. Code Reuse and Consistency
- **Shared interfaces** ensure type safety across applications
- **Common components** reduce duplication across web screens
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
nx affected:build                   # Build only affected projects
nx run-many --target=build --all    # Build all projects

# Development servers
nx serve web                        # Start web development server

# Testing and quality
nx test api                         # Test specific project
nx affected:test                    # Test affected projects
nx lint api                         # Lint specific project
nx affected:lint                    # Lint affected projects

# Infrastructure and deployment
nx plan infrastructure --args="--env=dev"    # Plan Terraform changes
nx apply infrastructure   # Apply infrastructure
nx deploy api --functionApp=<name>  # Deploy Azure Functions (func publish; no --env)
```

## Project Dependencies

The monorepo dependency graph flows from shared libraries to applications:

```
                    apps/api
                       ↑
libs/api-interfaces ───┤
                       ↑
libs/data-models ──────┤
                       ↑
libs/utils ────────────┘

libs/api-specs (generated types) ──→ apps/web
```

This structure ensures that:
- Applications depend on libraries, not other applications
- Shared logic lives in libraries for maximum reuse
- Type safety is maintained across all boundaries
- Changes to libraries trigger rebuilds of dependent applications

---

> **Next Steps**: Review [Data Flow](data-flow.md) to understand how data moves through this architecture, or check [Local Setup](../development/local-setup.md) to start developing.