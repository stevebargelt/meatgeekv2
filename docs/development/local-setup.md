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

# Activate the pinned npm (npm 10.9.8, from package.json "packageManager")
corepack enable

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
APPLICATIONINSIGHTS_CONNECTION_STRING=your-appinsights-connection-string
```

### 3. Set Up Development Infrastructure

```bash
# Initialize Terraform against the dev remote backend. The state-account name is
# derived from the subscription id and injected as an extra -backend-config (the
# backend-*.hcl files omit it), so init it directly rather than via `nx init`,
# which does not pass storage_account_name. ARM_SUBSCRIPTION_ID must be exported.
cd apps/infrastructure
terraform init -reconfigure \
  -backend-config=environments/backend-dev.hcl \
  -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"

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

#### New project checklist

The library and app generators don't scaffold everything this workspace needs. When you add a new project, wire up two things by hand:

1. **Local ESLint override.** The root `.eslintrc.json` sets `ignorePatterns: ["**/*"]`, so every project must supply its own `.eslintrc.json` (extending the root config) to be lintable — otherwise `nx lint <project>` silently ignores all files. The existing projects (`api`, `web`, `mobile`, and the `libs/*`) each have one; copy an existing library's `.eslintrc.json` as the starting point.

2. **Buildable-library `package.json`.** If the new library is compiled into a dependent app or library, give it a `package.json` whose `name` matches its `@meatgeekv2/*` alias in `tsconfig.base.json` (see [Buildable Library Pattern](../architecture/monorepo-structure.md#buildable-library-pattern)). Leave the `tsconfig.base.json` alias pointed at `libs/<name>/src` — it must resolve to source for Jest and IDE navigation.

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

### `TS6059: file is not under 'rootDir'` when building a library or app

This means a depended-on library is missing its buildable `package.json`, so NX can't remap its `@meatgeekv2/*` alias to `dist` at build time and the alias stays pointed at source. Add a `package.json` to that library whose `name` equals its `tsconfig.base.json` alias (do **not** change the alias). See the [Buildable Library Pattern](../architecture/monorepo-structure.md#buildable-library-pattern).

### `npm ci` fails with a lockfile sync error

`package-lock.json` must be generated with **npm 10** — the version CI uses. npm 11 drops nested optional-peer entries that npm 10 requires, which breaks `npm ci`. The toolchain is pinned via `"packageManager": "npm@10.9.8"` in `package.json`, so you get the right npm automatically once corepack is enabled:

```bash
corepack enable
```

With corepack enabled, any `npm install` that touches dependencies regenerates the lockfile under npm 10.9.8 — no manual `npx npm@10` step required. If you hit this error, confirm `corepack enable` has been run in your clone and re-run the install.

See the [CI/CD Pipeline](ci-cd.md#npm-and-the-lockfile) doc for details.

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