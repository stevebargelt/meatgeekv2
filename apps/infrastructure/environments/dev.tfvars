# Development Environment Configuration

environment = "dev"
location    = "North Central US"

# Development-friendly settings
appinsights_retention_days = 30
log_retention_days        = 30

# IoT Hub - Free tier for development
iot_hub_sku_name     = "F1"  # Free tier - 8,000 messages/day
iot_hub_sku_capacity = 1

# CosmosDB - Using existing account with environment-specific database
existing_cosmos_account_name        = "meatgeek"        # Update this
existing_cosmos_resource_group_name = "MeatGeek-Shared" # Update this

cosmos_database_throughput     = 400   # Minimum allowed (will use full remaining capacity)
cosmos_database_max_throughput = 1000  # Auto-scale maximum for dev
temperature_data_ttl_days      = 7     # Shorter retention for dev (cost savings)

# Azure Functions - Consumption plan
functions_app_service_plan_sku = "Y1"  # Consumption plan for cost efficiency

# SignalR - Free tier
signalr_sku_name     = "Free_F1"  # Free tier - 20 concurrent connections
signalr_sku_capacity = 1

# Device settings for development
device_count         = 5
max_daily_messages  = 10000

# Security - More permissive for development
allowed_ip_ranges = ["0.0.0.0/0"]

# Cost management
enable_backup           = false  # Disable backups in dev to save costs
backup_retention_days   = 1
auto_shutdown_enabled  = true   # Enable auto-shutdown for dev resources
budget_limit           = 50     # Lower budget limit for development
admin_email           = "steve@bargelt.com"  # Update with your email for alerts
