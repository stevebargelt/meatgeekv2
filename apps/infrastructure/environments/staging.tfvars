# Staging Environment Configuration

environment = "staging"
location    = "North Central US"

# Staging retention settings (between dev and prod)
appinsights_retention_days = 90
log_retention_days         = 30

# IoT Hub - Standard tier for staging integration testing
iot_hub_sku_name     = "S1" # Standard tier for realistic testing
iot_hub_sku_capacity = 1    # Single unit for staging

# CosmosDB - Using existing account with staging database
existing_cosmos_account_name        = "meatgeek"        # Update this
existing_cosmos_resource_group_name = "MeatGeek-Shared" # Update this

cosmos_database_throughput     = 400  # Same as dev for cost optimization
cosmos_database_max_throughput = 1000 # Reduced auto-scale maximum for staging
temperature_data_ttl_days      = 30   # 30-day retention for staging

# Azure Functions - Consumption plan (cost-effective for staging)
functions_app_service_plan_sku = "Y1" # Consumption plan

# SignalR - Standard tier for realistic connection testing
signalr_sku_name     = "Standard_S1" # Standard tier for integration testing
signalr_sku_capacity = 1

# Device settings for staging environment
device_count       = 20     # Support more devices than dev
max_daily_messages = 100000 # Higher message volume for load testing

# Security - Slightly more restrictive than dev
allowed_ip_ranges = [
  "0.0.0.0/0" # Still open for staging, but could be restricted
]

# Backup and cost management
enable_backup         = true  # Enable backups for staging data protection
backup_retention_days = 7     # Shorter retention than production
auto_shutdown_enabled = false # Keep staging running for integration tests
budget_limit          = 75    # Reduced budget with lower throughput
