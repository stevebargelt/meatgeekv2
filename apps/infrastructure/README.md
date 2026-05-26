# MeatGeek V2 Infrastructure

Terraform Infrastructure as Code for the MeatGeek V2 cloud-based BBQ temperature monitoring system.

## Overview

This Terraform project provisions all Azure resources required for the MeatGeek V2 system:

- **Azure IoT Hub** - Device-to-cloud messaging with parallel routing
- **CosmosDB** - Document database for telemetry and application data  
- **Azure Functions** - Serverless API and event processing
- **SignalR Service** - Real-time client communication
- **Application Insights** - Monitoring and observability
- **Event Hub** - Real-time data processing pipeline

## Architecture

```
Device Data → IoT Hub → Parallel Routing:
                       ├─→ CosmosDB (Direct storage)
                       └─→ Event Hub → Azure Functions → SignalR
```

## Prerequisites

- **Terraform** v1.9+ installed
- **Azure CLI** installed and authenticated
- **Azure subscription** with appropriate permissions
- **Storage account** for Terraform state (recommended)

## Quick Start

### 1. Authentication

```bash
# Login to Azure
az login

# Set subscription (if needed)
az account set --subscription "your-subscription-id"
```

### 2. Initialize Terraform

```bash
# Initialize Terraform (first time only)
nx init infrastructure

# Or directly:
cd apps/infrastructure
terraform init
```

### 3. Deploy Development Environment

```bash
# Plan deployment
nx plan infrastructure --env=dev

# Apply deployment
nx apply infrastructure --env=dev

# View outputs
nx output infrastructure
```

## Environment Configuration

### Development (`dev.tfvars`)
- IoT Hub F1 (Free tier) - 8,000 messages/day
- CosmosDB with free tier enabled
- Azure Functions Consumption plan
- SignalR Free tier
- Minimal retention periods for cost savings

### Production (`prod.tfvars`)  
- IoT Hub S1 with 2 units - 800,000 messages/day
- CosmosDB Standard tier with higher throughput
- Azure Functions Premium plan
- SignalR Standard tier with redundancy
- Extended retention and backup enabled

## Module Structure

### Core Modules

#### `modules/iot-hub/`
- Azure IoT Hub with device management
- Event Hub namespace for real-time processing
- Parallel message routing configuration
- Device identity management

#### `modules/cosmos-db/` (to be implemented)
- CosmosDB account with SQL API
- Database and container creation
- Partition key strategy implementation
- Automatic scaling configuration

#### `modules/functions/` (to be implemented)
- Function App with consumption/premium plans
- Storage account for function data
- Application settings injection
- Deployment slots for blue/green deployments

#### `modules/signalr/` (to be implemented)
- SignalR Service configuration
- Connection string management
- CORS settings for web clients

#### `modules/monitoring/` (to be implemented)
- Application Insights configuration
- Log Analytics workspace setup
- Custom dashboards and alerts
- Performance monitoring

## Terraform Commands

### Via NX (Recommended)

```bash
# Initialize Terraform
nx init infrastructure

# Validate configuration
nx validate infrastructure

# Format Terraform files
nx format infrastructure

# Plan changes for specific environment
nx plan infrastructure --env=dev
nx plan infrastructure --env=prod

# Apply changes
nx apply infrastructure --env=dev

# View outputs
nx output infrastructure

# Destroy resources (careful!)
nx destroy infrastructure --env=dev
```

### Direct Terraform Commands

```bash
cd apps/infrastructure

# Initialize with backend configuration
terraform init -backend-config=backend-config.hcl

# Plan with environment variables
terraform plan -var-file=environments/dev.tfvars

# Apply with plan file
terraform apply tfplan

# Output values
terraform output

# Destroy resources
terraform destroy -var-file=environments/dev.tfvars
```

## Backend Configuration

For production use, configure remote state storage:

**backend-config.hcl:**
```hcl
resource_group_name  = "meatgeek-terraform-rg"
storage_account_name = "meatgeekterraformstate"
container_name       = "tfstate"
key                 = "meatgeek-v2.terraform.tfstate"
```

Initialize with backend:
```bash
terraform init -backend-config=backend-config.hcl
```

## Environment Variables

Key outputs for application configuration:

```bash
# Get connection strings
terraform output -raw iot_hub_connection_string
terraform output -raw cosmos_db_connection_string
terraform output -raw signalr_connection_string
terraform output -raw application_insights_connection_string

# Get environment configuration (all at once)
terraform output environment_config
```

## Security Considerations

### Network Security
- Configure `allowed_ip_ranges` in environment files
- Use private endpoints for production deployments
- Enable Azure Firewall for additional protection

### Access Control
- IoT device certificates and connection strings
- Function App managed identity integration
- CosmosDB RBAC configuration
- Key Vault integration for secrets management

### Data Protection
- Encryption at rest enabled by default
- TLS/SSL for all data in transit
- Backup and disaster recovery configured

## Cost Management

### Development Cost Optimization
- Free tiers for IoT Hub, SignalR, and CosmosDB
- Consumption plan for Azure Functions
- Reduced retention periods
- Auto-shutdown capabilities

### Production Cost Monitoring
- Budget alerts configured per environment
- Resource tagging for cost allocation
- Reserved instances for predictable workloads
- Scaling policies based on usage patterns

## Monitoring and Observability

### Application Insights Integration
- Distributed tracing across all services
- Custom telemetry from IoT devices
- Performance monitoring and alerting
- Log correlation with trace IDs

### Resource Health Monitoring
- Azure Monitor integration
- Custom KQL queries for BBQ-specific metrics
- Automated alerting for service degradation
- Dashboard creation for operational insights

## Troubleshooting

### Common Issues

1. **Terraform State Conflicts**
   ```bash
   terraform force-unlock <lock-id>
   ```

2. **Resource Naming Conflicts**
   - Ensure resource names are globally unique
   - Check existing resources in subscription

3. **Permission Issues**
   - Verify Azure CLI authentication
   - Check subscription-level permissions
   - Validate service principal roles

### Debugging Commands

```bash
# Check Terraform version and providers
terraform version

# Validate configuration syntax
nx validate infrastructure

# Debug plan with verbose output
TF_LOG=DEBUG terraform plan -var-file=environments/dev.tfvars

# Check Azure resources
az resource list --resource-group meatgeek-dev-rg
```

## Development Status

### ✅ Completed (Phase 0)
- [x] Main Terraform configuration structure
- [x] Environment variable management  
- [x] IoT Hub module with parallel routing
- [x] NX integration with Terraform commands
- [x] Development and production configurations

### 🔄 Phase 1 Implementation
- [ ] CosmosDB module implementation
- [ ] Azure Functions module implementation
- [ ] SignalR Service module implementation
- [ ] Monitoring module implementation
- [ ] Backend state configuration
- [ ] Resource deployment and testing

## Next Steps

1. **Complete remaining modules** (cosmos-db, functions, signalr, monitoring)
2. **Set up remote state backend** for team collaboration
3. **Deploy development environment** and test connectivity
4. **Configure CI/CD pipelines** for automated deployments
5. **Implement security hardening** for production readiness

---

> **Note**: This infrastructure code supports the MeatGeek V2 system architecture with parallel data processing paths optimized for both storage reliability and real-time performance.