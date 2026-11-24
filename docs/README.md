# MeatGeek V2 Documentation

A comprehensive BBQ temperature monitoring and cook management system built with modern cloud architecture and NX monorepo practices.

## 🚀 Quick Start

- **New to MeatGeek V2?** Start with [System Overview](architecture/system-overview.md)
- **Ready to develop?** Go to [Local Setup](development/local-setup.md)
- **Setting up infrastructure?** Check [Terraform Setup](infrastructure/terraform-setup.md)
- **API integration?** See [OpenAPI Specifications](api/openapi-specs.md)

## 📋 Documentation Structure

### Architecture & Design
- **[Architecture site](https://stevebargelt.github.io/meatgeekv2/)** - The interactive LikeC4 model, published from `docs/architecture/likec4/` on every merge to `main`
- **[Architecture diagrams](architecture/diagrams.md)** - Generated from the model and rendered on GitHub
- **[Architecture model](architecture/likec4/README.md)** - How to preview the site locally and add an element, a view or a flow
- **[System Overview](architecture/system-overview.md)** - High-level architecture, design decisions, and technology choices
- **[Monorepo Structure](architecture/monorepo-structure.md)** - NX workspace organization and project relationships
- **[Data Flow](architecture/data-flow.md)** - End-to-end data processing pipeline from device to client
- **[Security](architecture/security.md)** - Authentication, authorization, and data protection strategies

### Infrastructure & Deployment
- **[Terraform Setup](infrastructure/terraform-setup.md)** - Infrastructure as Code with modular Terraform configuration
- **[Azure Services](infrastructure/azure-services.md)** - Detailed Azure service configurations and dependencies
- **[Deployment Guide](infrastructure/deployment.md)** - Device and cloud deployment procedures

### API & Integration
- **[OpenAPI Specifications](api/openapi-specs.md)** - Complete API documentation with contract-first development
- **[Azure Functions](api/azure-functions.md)** - Serverless function implementations and Event Hub processing
- **[Shared Libraries](api/shared-libraries.md)** - TypeScript libraries for consistent API interfaces

### Monitoring & Observability
- **[Observability Strategy](monitoring/observability.md)** - Azure Monitor integration replacing NewRelic
- **[Distributed Tracing](monitoring/distributed-tracing.md)** - End-to-end OpenTelemetry tracing implementation
- **[Dashboards & Alerts](monitoring/dashboards.md)** - KQL queries, dashboards, and monitoring setup

### Applications
- **[Device runbook](devices/runbook.md)** - Onboard a Raspberry Pi with one command, then claim, release or revoke it
- **[Device Controller](applications/device-controller.md)** - Raspberry Pi Go application for temperature monitoring
- **[Data Pusher](applications/data-pusher.md)** - IoT Hub integration service and local buffering
- **Mobile App** - Native iOS (Swift) app in [`apps/ios`](../apps/ios/README.md), so far a skeleton in `apps/ios` (HAR-158) that builds and tests in the simulator and has Entra sign-in (HAR-162) and a Devices tab to list, claim, rename and release devices (HAR-165); it shares only the OpenAPI contract with the web app
- **[Web App](applications/web-app.md)** - React web application

### Data Models & Business Logic
- **[CosmosDB Collections](data-models/cosmos-collections.md)** - Database schemas and partitioning strategies
- **[Cook Session Flow](data-models/cook-session-flow.md)** - Cook lifecycle and temperature data associations

### Development & Operations
- **[NX Commands](development/nx-commands.md)** - Development workflow and build commands
- **[CI/CD Pipeline](development/ci-cd.md)** - GitHub Actions workflows and deployment automation
- **[Deterministic Tests](development/deterministic-tests.md)** - The no-real-time rule for every non-live test, how to wait without a clock in each language, and the guard that enforces it
- **[Local Setup](development/local-setup.md)** - Environment configuration and getting started guide

### Planning & Strategy
- **[Implementation Phases](planning/implementation-phases.md)** - Project timeline, milestones, and deliverables
- **[Cost Estimation](planning/cost-estimation.md)** - Azure pricing analysis and scaling considerations
- **[Future Enhancements](planning/future-enhancements.md)** - Roadmap and commercial opportunities

## 🏗️ System Overview

MeatGeek V2 is a modern IoT system that monitors BBQ temperatures in real-time and provides comprehensive cook management through mobile and web applications. The system leverages:

- **NX Monorepo** for unified development across all applications
- **Azure Cloud Services** for scalable, serverless architecture
- **Terraform** for infrastructure as code
- **OpenTelemetry** for end-to-end observability
- **React** for the web client, and a native iOS (Swift) client that is so far a skeleton (`apps/ios`)

## 🔄 Data Flow Summary

The device controller reads the RTD sensors, and the data pusher stamps each reading with the active cook and sends it to Azure IoT Hub. IoT Hub's `cosmos-storage-route` writes each reading straight into the Cosmos DB `temperatures` container, with no Function in the path; its `eventhub-realtime-route` feeds the `temperature-data` Event Hub, which the API's `broadcastTemperature` reads to push each reading to its device's SignalR group. The API (Azure Functions) reads that history and serves cooks. See the [`telemetry` view](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) for one reading's path.

## 📱 Applications

| Application | Technology | Purpose | Status |
|------------|------------|---------|---------|
| Device Controller | Go | Temperature monitoring on Raspberry Pi | ✅ Existing |
| Data Pusher | Go | IoT Hub integration service | 🔄 New |
| Azure Functions | TypeScript | Serverless API and data processing | 🔄 New |
| Web App | React | User interface | 🔄 New |
| iOS App | Swift (native) | Mobile client in [`apps/ios`](../apps/ios/README.md); shares only the OpenAPI contract with the web app | 🚧 Skeleton |
| Infrastructure | Terraform | Cloud resource management | 🔄 New |

## 🚀 Getting Started

1. **Review Architecture**: Start with [System Overview](architecture/system-overview.md)
2. **Set Up Environment**: Follow [Local Setup](development/local-setup.md)
3. **Provision Infrastructure**: Use [Terraform Setup](infrastructure/terraform-setup.md)
4. **Run Development**: Use [NX Commands](development/nx-commands.md)

## 🤝 Contributing

This system uses NX monorepo practices. All applications and libraries are co-located for maximum code reuse and consistent development practices.

## 📄 License

MIT License - See the original MeatGeek project for licensing details.

---

> **Migration Note**: This documentation was split from a single 3,700+ line plan file for better maintainability and navigation. Each section now has focused documentation that's easier to maintain and understand.