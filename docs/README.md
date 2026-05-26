# MeatGeek V2 Documentation

A comprehensive BBQ temperature monitoring and cook management system built with modern cloud architecture and NX monorepo practices.

## 🚀 Quick Start

- **New to MeatGeek V2?** Start with [System Overview](architecture/system-overview.md)
- **Ready to develop?** Go to [Local Setup](development/local-setup.md)
- **Setting up infrastructure?** Check [Terraform Setup](infrastructure/terraform-setup.md)
- **API integration?** See [OpenAPI Specifications](api/openapi-specs.md)

## 📋 Documentation Structure

### Architecture & Design
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
- **[Device Controller](applications/device-controller.md)** - Raspberry Pi Go application for temperature monitoring
- **[Data Pusher](applications/data-pusher.md)** - IoT Hub integration service and local buffering
- **[Mobile App](applications/mobile-app.md)** - React Native mobile application (primary interface)
- **[Web App](applications/web-app.md)** - React web application (secondary interface)

### Data Models & Business Logic
- **[CosmosDB Collections](data-models/cosmos-collections.md)** - Database schemas and partitioning strategies
- **[Cook Session Flow](data-models/cook-session-flow.md)** - Cook lifecycle and temperature data associations

### Development & Operations
- **[NX Commands](development/nx-commands.md)** - Development workflow and build commands
- **[CI/CD Pipeline](development/ci-cd.md)** - GitHub Actions workflows and deployment automation
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
- **React Native & React** for cross-platform client applications

## 🔄 Data Flow Summary

```
RTD Sensors → Device Controller → Data Pusher → Azure IoT Hub → Azure Functions → CosmosDB
                                                                      ↓
                                                              SignalR Hub → Client Apps
```

## 📱 Applications

| Application | Technology | Purpose | Status |
|------------|------------|---------|---------|
| Device Controller | Go | Temperature monitoring on Raspberry Pi | ✅ Existing |
| Data Pusher | Go | IoT Hub integration service | 🔄 New |
| Azure Functions | TypeScript | Serverless API and data processing | 🔄 New |
| Mobile App | React Native | Primary user interface | 🔄 New |
| Web App | React | Secondary interface | 🔄 New |
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