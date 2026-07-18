# MeatGeek V2

A comprehensive cloud-based BBQ temperature monitoring and cook management system built with modern architecture and NX monorepo practices.

## 🚀 Quick Start

### Prerequisites
- **Node.js** (v20 or later) with npm
- **NX CLI**: `npm install -g nx`
- **Go** (v1.21 or later) for device services
- **Azure CLI** for cloud integration
- **Terraform** (v1.9+) for infrastructure

### Installation

```bash
# Clone the repository
git clone https://github.com/stevebargelt/meatgeekv2
cd meatgeekv2

# Activate the pinned npm (npm 10.9.8, from package.json "packageManager")
corepack enable

# Install dependencies
npm install

# Build all projects
nx run-many --target=build --all

# Start development servers (in separate terminals)
nx serve web          # React web app (http://localhost:3000)
nx serve api          # Azure Functions (http://localhost:7071)  
nx serve mobile       # React Native mobile app
```

### Local Configuration & Secrets

Real secrets and Azure connection strings must **never** be committed. Keep them out of the repo:

- Put local secrets in the **untracked** `apps/api/local.settings.json` (already gitignored) and/or supply them as environment variables: `COSMOSDB_CONNECTION_STRING`, `IOTHUB_CONNECTION_STRING`, `SIGNALR_CONNECTION_STRING`, `APPINSIGHTS_CONNECTION_STRING`, and related keys.
- The fallback values committed in `apps/api/src/environments/environment.development.ts` are **not** real credentials — they are the publicly documented Azure Cosmos DB Emulator default key and explicit `fake-key` placeholders, used only when the environment variables above are unset.

## 🏗️ System Architecture

MeatGeek V2 is a modern IoT system that monitors BBQ temperatures in real-time and provides comprehensive cook management through mobile and web applications.

### Technology Stack
- **NX Monorepo** - Unified development across all applications
- **Azure Cloud Services** - Scalable, serverless architecture
- **Terraform** - Infrastructure as Code
- **OpenTelemetry** - End-to-end observability
- **React Native & React** - Cross-platform client applications
- **Go** - High-performance device services
- **TypeScript** - Type-safe development across all layers

### Data Flow
```
RTD Sensors → Device Controller → Data Pusher → Azure IoT Hub → Azure Functions → CosmosDB
                                                                      ↓
                                                              SignalR Hub → Client Apps
```

## 📁 Project Structure

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
├── docs/                         # Comprehensive documentation
└── .github/workflows/             # CI/CD pipeline definitions
```

## 📱 Applications

| Application | Technology | Purpose | Status |
|------------|------------|---------|---------|
| Device Controller | Go | Temperature monitoring on Raspberry Pi | ✅ Enhanced |
| Data Pusher | Go | IoT Hub integration service | ✅ New |
| Azure Functions | TypeScript | Serverless API and data processing | ✅ New |
| Mobile App | React Native | Primary user interface | ✅ Foundation |
| Web App | React | Secondary interface with analytics | ✅ Foundation |
| Infrastructure | Terraform | Cloud resource management | 🔄 In Progress |

## 🔧 Development Commands

### NX Commands

```bash
# Build commands
nx build api                        # Build specific project
nx run-many --target=build --all    # Build all projects
nx affected:build                   # Build only affected projects

# Development servers
nx serve web                        # Web app at http://localhost:3000
nx serve api                        # Azure Functions at http://localhost:7071
nx serve mobile                     # React Native metro bundler

# Testing
nx test api                         # Test specific project
nx run-many --target=test --all     # Test all projects
nx affected:test                    # Test affected projects

# Code quality
nx lint api                         # Lint specific project
nx format:write                     # Format all code
nx dep-graph                        # Visualize dependencies
```

### Go Applications (Device Services)

Go projects use Makefiles with NX orchestration:

```bash
# Via NX (recommended for monorepo development)
nx build device-controller          # Calls: make build
nx build-arm device-controller      # Calls: make build-arm (Raspberry Pi)
nx serve device-controller          # Calls: make dev (mock sensors)

# Direct Make commands (useful for debugging)
cd apps/device-controller
make build                          # Local build
make dev                            # Development server
make deploy-to-pi PI_HOST=pi@192.168.1.100  # Deploy to Pi
```

## 📖 Documentation

Comprehensive documentation is available in the `/docs` directory:

- **[System Overview](docs/architecture/system-overview.md)** - Architecture and design decisions
- **[Local Setup](docs/development/local-setup.md)** - Development environment setup
- **[NX Commands](docs/development/nx-commands.md)** - Development workflows
- **[Implementation Plan](docs/planning/implementation-phases.md)** - Project roadmap
- **[API Documentation](docs/api/)** - API specifications and integration
- **[Infrastructure Guide](docs/infrastructure/)** - Terraform and Azure setup

## 🚦 Development Status - Phase 1 In Progress 🔄

**Phase 0: Monorepo Setup** is complete, and **Phase 1: Foundation** is underway.

### ✅ Phase 0 - Completed
- [x] NX workspace initialized with TypeScript preset
- [x] All application project structures created
- [x] Go projects integrated with Makefile + NX orchestration
- [x] Shared libraries foundation established
- [x] API interfaces library with comprehensive TypeScript types
- [x] VS Code workspace configured with recommended settings

### 🔄 Phase 1 - In Progress
**Phase 1: Foundation** - Infrastructure & Core Services
- Azure infrastructure deployment with Terraform
- Enhanced device controller with Azure Monitor integration
- Data pusher service with IoT Hub connectivity
- API development with OpenTelemetry tracing

## 🛠️ Key Features

### Current (Phase 0)
- **Monorepo Architecture**: Unified development with NX
- **Type Safety**: Comprehensive TypeScript interfaces
- **Cross-Platform**: React Native (mobile) + React (web) + Go (device)
- **Modern Tooling**: ESLint, Prettier, Jest configured
- **Development Ready**: Hot reloading, testing, linting all set up

### Planned (Phases 1-4)
- **Real-time Monitoring**: Live temperature updates via SignalR
- **Cloud Integration**: Azure IoT Hub, Functions, CosmosDB
- **Cook Management**: Complete cook lifecycle tracking
- **Advanced Analytics**: Historical data and trend analysis
- **Mobile-First Design**: Optimized for outdoor BBQ use

## 🔍 Quality & Standards

- **Type Safety**: No `any` types, comprehensive interfaces
- **Code Quality**: ESLint + Prettier + automated formatting
- **Testing**: Jest unit tests, integration tests planned
- **Documentation**: Comprehensive README files for each project
- **Git Practices**: Conventional commits, automated workflows

## 🤝 Contributing

This project follows NX monorepo best practices:

1. **Code Quality**: Run `nx format:write` before committing
2. **Testing**: Ensure `nx affected:test` passes
3. **Type Safety**: Use shared interfaces from `@meatgeekv2/api-interfaces`
4. **Documentation**: Update relevant README files
5. **Commit Messages**: Follow conventional commit format

## 📄 License

MIT License - See the original MeatGeek project for licensing details.

## 🎯 Goals

- **Sub-second latency** from sensor reading to client display
- **99.9% uptime** for temperature monitoring  
- **Cross-platform compatibility** (iOS, Android, Web)
- **Real-time updates** with live temperature charts
- **Mobile-first design** optimized for outdoor use

---

> **Phase 0 Complete!** 🎉 The MeatGeek V2 monorepo foundation is established, and Phase 1 (Infrastructure & Core Services) is now in progress. All applications, libraries, and development tooling are configured and tested.