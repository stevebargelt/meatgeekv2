# Terraform Infrastructure Setup

## Overview

The MeatGeek V2 infrastructure is completely managed using **Terraform** as Infrastructure as Code, organized within the NX monorepo for consistent development workflows.

## Directory Structure

```
apps/infrastructure/
├── environments/               # Environment-specific variables
│   ├── dev.tfvars             # Development environment
│   ├── staging.tfvars         # Staging environment
│   └── prod.tfvars            # Production environment
├── modules/                   # Reusable Terraform modules
│   ├── iot-hub/               # Azure IoT Hub resources
│   ├── cosmos-db/             # CosmosDB configuration
│   ├── functions/             # Azure Functions resources
│   ├── signalr/               # SignalR Service setup
│   ├── monitoring/            # Application Insights & monitoring
│   └── networking/            # Virtual networks and security
├── main.tf                    # Root module configuration
├── variables.tf               # Input variable definitions
├── outputs.tf                 # Output value definitions
├── backend.tf                 # Remote state management
├── versions.tf                # Provider version constraints
├── project.json               # NX project configuration
└── README.md                  # Infrastructure documentation
```

## Core Configuration Files

### Backend Configuration (`backend.tf`)

Remote state management using Azure Storage for team collaboration:

```hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "meatgeek-terraform-state-rg"
    storage_account_name = "meatgeekterraformstate"
    container_name       = "tfstate"
    key                  = "meatgeekv2.tfstate"
  }
}
```

### Provider Configuration (`versions.tf`)

Terraform and provider version constraints:

```hcl
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}
```

### Root Module (`main.tf`)

Main infrastructure configuration using modular approach:

```hcl
locals {
  common_tags = {
    Project     = "MeatGeek-V2"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# Resource Group
resource "azurerm_resource_group" "meatgeek" {
  name     = "meatgeek-${var.environment}-rg"
  location = var.location
  tags     = local.common_tags
}

# IoT Hub Module
module "iot_hub" {
  source = "./modules/iot-hub"

  resource_group_name = azurerm_resource_group.meatgeek.name
  location           = azurerm_resource_group.meatgeek.location
  environment        = var.environment
  tags              = local.common_tags
}

# CosmosDB Module
module "cosmos_db" {
  source = "./modules/cosmos-db"

  resource_group_name = azurerm_resource_group.meatgeek.name
  location           = azurerm_resource_group.meatgeek.location
  environment        = var.environment
  tags              = local.common_tags
}

# Azure Functions Module
module "functions" {
  source = "./modules/functions"

  resource_group_name = azurerm_resource_group.meatgeek.name
  location           = azurerm_resource_group.meatgeek.location
  environment        = var.environment
  cosmos_connection  = module.cosmos_db.connection_string
  iot_hub_connection = module.iot_hub.event_hub_connection_string
  tags              = local.common_tags
}

# SignalR Module
module "signalr" {
  source = "./modules/signalr"

  resource_group_name = azurerm_resource_group.meatgeek.name
  location           = azurerm_resource_group.meatgeek.location
  environment        = var.environment
  tags              = local.common_tags
}

# Monitoring Module
module "monitoring" {
  source = "./modules/monitoring"

  resource_group_name = azurerm_resource_group.meatgeek.name
  location           = azurerm_resource_group.meatgeek.location
  environment        = var.environment
  function_app_id    = module.functions.function_app_id
  cosmos_db_id       = module.cosmos_db.account_id
  iot_hub_id         = module.iot_hub.hub_id
  signalr_id         = module.signalr.service_id
  tags              = local.common_tags
}
```

## Environment Management

### Development Environment (`environments/dev.tfvars`)

Cost-optimized configuration for development:

```hcl
environment = "dev"
location    = "North Central US"

# IoT Hub Configuration
iot_hub_sku_name     = "F1"  # Free tier for dev
iot_hub_sku_capacity = 1

# CosmosDB Configuration
cosmos_consistency_level = "Session"
cosmos_throughput       = 400  # Minimum for dev

# Function App Configuration
function_app_service_plan_sku = "Y1"  # Consumption plan

# SignalR Configuration
signalr_sku = "Free_F1"

# Device Configuration
device_count = 1  # Single development device
```

### Production Environment (`environments/prod.tfvars`)

Production-ready configuration with higher performance:

```hcl
environment = "prod"
location    = "North Central US"

# IoT Hub Configuration
iot_hub_sku_name     = "S1"  # Standard tier for production
iot_hub_sku_capacity = 2

# CosmosDB Configuration
cosmos_consistency_level = "Strong"
cosmos_throughput       = 1000

# Function App Configuration
function_app_service_plan_sku = "EP1"  # Premium plan for better performance

# SignalR Configuration
signalr_sku = "Standard_S1"

# Device Configuration
device_count = 5  # Support multiple production devices
```

## NX Integration

### Project Configuration (`project.json`)

NX commands for Terraform operations:

```json
{
  "name": "infrastructure",
  "sourceRoot": "apps/infrastructure",
  "projectType": "application",
  "targets": {
    "init": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform init",
        "cwd": "apps/infrastructure"
      }
    },
    "plan": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform plan -var-file=environments/{args.env}.tfvars",
        "cwd": "apps/infrastructure"
      }
    },
    "apply": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform apply -var-file=environments/{args.env}.tfvars -auto-approve",
        "cwd": "apps/infrastructure"
      }
    },
    "destroy": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform destroy -var-file=environments/{args.env}.tfvars -auto-approve",
        "cwd": "apps/infrastructure"
      }
    },
    "validate": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform validate && terraform fmt -check",
        "cwd": "apps/infrastructure"
      }
    }
  },
  "tags": ["type:infrastructure", "scope:shared"]
}
```

### Common NX Commands

```bash
# Initialize Terraform
nx init infrastructure

# Plan changes for development
nx plan infrastructure --env=dev

# Apply development infrastructure
nx apply infrastructure --env=dev

# Plan production changes
nx plan infrastructure --env=prod

# Apply production infrastructure
nx apply infrastructure --env=prod

# Validate Terraform configuration
nx validate infrastructure

# Destroy development environment
nx destroy infrastructure --env=dev
```

## Terraform Modules

### IoT Hub Module (`modules/iot-hub/main.tf`)

Complete IoT Hub setup with parallel message routing:

```hcl
resource "azurerm_iothub" "main" {
  name                = "meatgeek-${var.environment}-iothub"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku {
    name     = var.sku_name
    capacity = var.sku_capacity
  }

  tags = var.tags
}

# Device registrations
resource "azurerm_iothub_device" "meatgeek_devices" {
  count               = var.device_count
  name                = "meatgeek${count.index + 1}"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  authentication_type = "sas"
}

# Event Hub for real-time processing
resource "azurerm_eventhub_namespace" "realtime" {
  name                = "meatgeek-${var.environment}-events"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "Standard"
  capacity            = 1

  tags = var.tags
}

resource "azurerm_eventhub" "realtime" {
  name                = "temperature-realtime"
  namespace_name      = azurerm_eventhub_namespace.realtime.name
  resource_group_name = var.resource_group_name
  partition_count     = 2
  message_retention   = 1
}

# Consumer group for real-time Functions
resource "azurerm_eventhub_consumer_group" "realtime_functions" {
  name                = "realtime-functions"
  namespace_name      = azurerm_eventhub_namespace.realtime.name
  eventhub_name       = azurerm_eventhub.realtime.name
  resource_group_name = var.resource_group_name
}

# IoT Hub endpoint for direct CosmosDB routing
resource "azurerm_iothub_endpoint_cosmosdb_account" "storage" {
  resource_group_name     = var.resource_group_name
  iothub_name            = azurerm_iothub.main.name
  name                   = "cosmosdb-temperatures"
  connection_string      = var.cosmos_connection_string
  endpoint_uri           = var.cosmos_endpoint_uri
  database_name          = var.cosmos_database_name
  container_name         = "temperatures"
  partition_key_template = "$body.cookId"
  partition_key_name     = "cookId"
}

# IoT Hub endpoint for Event Hub routing
resource "azurerm_iothub_endpoint_eventhub" "realtime" {
  resource_group_name = var.resource_group_name
  iothub_name         = azurerm_iothub.main.name
  name                = "eventhub-realtime"
  connection_string   = azurerm_eventhub.realtime.default_primary_connection_string
}

# Route 1: Direct storage to CosmosDB
resource "azurerm_iothub_route" "temperature_storage" {
  resource_group_name = var.resource_group_name
  iothub_name         = azurerm_iothub.main.name
  name                = "TemperatureStorage"

  source         = "DeviceMessages"
  condition      = "messageType = 'temperature'"
  endpoint_names = [azurerm_iothub_endpoint_cosmosdb_account.storage.name]
  enabled        = true
}

# Route 2: Real-time processing via Event Hub
resource "azurerm_iothub_route" "temperature_realtime" {
  resource_group_name = var.resource_group_name
  iothub_name         = azurerm_iothub.main.name
  name                = "TemperatureRealtime"

  source         = "DeviceMessages"
  condition      = "messageType = 'temperature'"
  endpoint_names = [azurerm_iothub_endpoint_eventhub.realtime.name]
  enabled        = true
}

# Outputs for other modules
output "connection_string" {
  value     = azurerm_iothub.main.shared_access_policy[0].connection_string
  sensitive = true
}

output "event_hub_connection_string" {
  value     = azurerm_eventhub.realtime.default_primary_connection_string
  sensitive = true
}

output "event_hub_name" {
  value = azurerm_eventhub.realtime.name
}

output "hub_id" {
  value = azurerm_iothub.main.id
}
```

### CosmosDB Module (`modules/cosmos-db/main.tf`)

CosmosDB configuration with proper collections:

```hcl
resource "azurerm_cosmosdb_account" "main" {
  name                = "meatgeek-${var.environment}-cosmos"
  resource_group_name = var.resource_group_name
  location            = var.location
  offer_type          = "Standard"

  consistency_policy {
    consistency_level = var.consistency_level
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  tags = var.tags
}

# Database for MeatGeek data
resource "azurerm_cosmosdb_sql_database" "main" {
  name                = "meatgeek"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  throughput          = var.throughput
}

# Collections with proper partitioning
resource "azurerm_cosmosdb_sql_container" "temperatures" {
  name                = "temperatures"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_path  = "/cookId"
  throughput          = 400
}

resource "azurerm_cosmosdb_sql_container" "cooks" {
  name                = "cooks"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_path  = "/deviceId"
  throughput          = 400
}

resource "azurerm_cosmosdb_sql_container" "devices" {
  name                = "devices"
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.main.name
  partition_key_path  = "/id"
  throughput          = 400
}
```

## CI/CD Integration

### GitHub Actions Workflow (`.github/workflows/infrastructure.yml`)

Automated infrastructure deployment pipeline:

```yaml
name: Infrastructure Deployment

on:
  push:
    branches: [main]
    paths: ['apps/infrastructure/**']
  pull_request:
    paths: ['apps/infrastructure/**']

jobs:
  terraform:
    runs-on: ubuntu-latest
    environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'development' }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.9.0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install NX
        run: npm install -g nx

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Terraform Init
        run: nx init infrastructure

      - name: Terraform Validate
        run: nx validate infrastructure

      - name: Terraform Plan
        run: nx plan infrastructure --env=${{ github.ref == 'refs/heads/main' && 'prod' || 'dev' }}

      - name: Terraform Apply
        if: github.ref == 'refs/heads/main'
        run: nx apply infrastructure --env=prod
```

## Getting Started

### Prerequisites

1. **Azure CLI** installed and authenticated
2. **Terraform** >= 1.9.0 installed
3. **Node.js** and **NX** for monorepo commands
4. **Azure Subscription** with appropriate permissions

### Initial Setup

1. **Clone the repository**:

   ```bash
   git clone https://github.com/stevebargelt/meatgeekv2
   cd meatgeekv2
   npm install
   ```

2. **Set up Terraform backend** (one-time setup):

   ```bash
   # Create resource group for Terraform state
   az group create --name meatgeek-terraform-state-rg --location "North Central US"

   # Create storage account for state
   az storage account create \
     --name meatgeekterraformstate \
     --resource-group meatgeek-terraform-state-rg \
     --location "North Central US" \
     --sku Standard_LRS

   # Create storage container
   az storage container create \
     --name tfstate \
     --account-name meatgeekterraformstate
   ```

3. **Initialize and deploy development environment**:
   ```bash
   nx init infrastructure
   nx plan infrastructure --env=dev
   nx apply infrastructure --env=dev
   ```

## Authentication Integration

### External Authentication Provider

MeatGeek V2 uses **Supabase Auth** as the external authentication provider, which means:

- No complex identity provider infrastructure needed in Terraform
- Authentication is handled by Supabase's managed service
- Azure Functions validate JWT tokens from Supabase
- Reduced infrastructure complexity and cost

### Environment Variables Required

```bash
# Add to Azure Functions App Settings
SUPABASE_URL=<your-supabase-project-url>
SUPABASE_ANON_KEY=<your-supabase-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>
```

## Benefits of This Terraform Setup

- **Modular Architecture**: Reusable components across environments
- **Environment Separation**: Clear development, staging, production configurations
- **State Management**: Shared state with Azure Storage backend
- **NX Integration**: Consistent tooling with other applications
- **CI/CD Ready**: Automated deployment with GitHub Actions
- **Scalable Structure**: Easy to add new Azure resources and modules
- **External Auth**: No complex identity provider infrastructure to manage in Azure

---

> **Next Steps**: Once infrastructure is deployed, configure applications using [Azure Services](azure-services.md) documentation, or proceed with [Deployment Guide](deployment.md).
