# Production Environment Configuration

environment = "prod"
location    = "North Central US"

# Production-grade retention settings
appinsights_retention_days = 365
log_retention_days         = 90

# IoT Hub - Standard tier for production
iot_hub_sku_name     = "S1" # Standard tier - 400,000 messages/day
iot_hub_sku_capacity = 2    # 2 units for redundancy

# CosmosDB - Using existing account with production database
existing_cosmos_account_name        = "meatgeek"        # Update this
existing_cosmos_resource_group_name = "MeatGeek-Shared" # Update this

cosmos_database_throughput     = 400  # Cost-optimized base throughput
cosmos_database_max_throughput = 4000 # Auto-scale for production spikes when needed
temperature_data_ttl_days      = 90   # Full 90-day retention for production

# Azure Functions - Premium plan for better performance
functions_app_service_plan_sku = "EP1" # Premium plan

# SignalR - Standard tier for production
signalr_sku_name     = "Standard_S1" # Standard tier - 1,000 concurrent connections
signalr_sku_capacity = 2             # 2 units for redundancy

# Device settings for production
device_count       = 100
max_daily_messages = 1000000

# Security - Restricted IP ranges (should be customized)
allowed_ip_ranges = [
  "10.0.0.0/8",    # Private networks
  "172.16.0.0/12", # Private networks
  "192.168.0.0/16" # Private networks
]

# Backup and disaster recovery
enable_backup         = true
backup_retention_days = 30
auto_shutdown_enabled = false # Never auto-shutdown production
budget_limit          = 200   # Reduced budget with cost-optimized throughput
