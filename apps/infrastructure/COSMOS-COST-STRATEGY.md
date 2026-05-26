# CosmosDB Cost Allocation Strategy for MeatGeek V2

## Overview

This document outlines the cost-optimized approach for using a single CosmosDB account across multiple environments for the MeatGeek V2 system.

## Architecture: Multiple Databases Approach

### Structure

```
Your Existing CosmosDB Account
├── meatgeek-dev (Database)     - 400 RU/s shared    (~$24/month)
├── meatgeek-staging (Database) - 400 RU/s shared    (~$24/month)
└── meatgeek-prod (Database)    - 400 RU/s shared    (~$24/month base, auto-scale to 4000)

Each Database Contains:
├── devices (Container)      - Device info, partition: /id
├── temperatures (Container) - Temperature data, partition: /deviceId, TTL enabled
├── cooks (Container)        - Cook sessions, partition: /userId
├── users (Container)        - User profiles, partition: /id
└── recipes (Container)      - Recipe data, partition: /userId
```

## Cost Breakdown

### Development Environment (`meatgeek-dev`)

- **Throughput**: 400 RU/s shared across 5 containers
- **Monthly Cost**: ~$24 USD
- **Usage Pattern**: Low volume development testing
- **TTL**: 7 days for temperature data (cost savings)
- **Features**: Basic functionality testing, rapid iteration

### Staging Environment (`meatgeek-staging`)

- **Throughput**: 400 RU/s shared across 5 containers (cost-optimized)
- **Auto-scale Maximum**: 1000 RU/s (for load testing spikes)
- **Monthly Cost**: ~$24 base + minimal scaling costs
- **Usage Pattern**: Integration testing, moderate load testing
- **TTL**: 30 days for temperature data
- **Features**: Full feature testing, performance validation

### Production Environment (`meatgeek-prod`)

- **Base Throughput**: 400 RU/s shared across 5 containers (cost-optimized)
- **Auto-scale Maximum**: 4000 RU/s (scales based on actual load)
- **Monthly Cost**: ~$24 base + scaling costs only when needed
- **Usage Pattern**: Live user traffic, real device data
- **TTL**: 90 days for temperature data (full retention)
- **Features**: High availability, backup, monitoring, scales with growth

## Total Estimated Monthly Cost

| Environment | Base RU/s | Monthly Cost | Annual Cost | Notes                                      |
| ----------- | --------- | ------------ | ----------- | ------------------------------------------ |
| Development | 400       | $24          | $288        | Fixed cost                                 |
| Staging     | 400       | $24          | $288        | Fixed cost + minimal auto-scale            |
| Production  | 400       | $24          | $288        | Base + auto-scale to 4000 RU/s when needed |
| **Total**   |           | **$72**      | **$864**    | **Massive 70%+ cost savings!**             |

### Cost Optimization Benefits vs. Multiple Accounts

**Single Account Approach (Our Optimized Plan):**

- Total: $72/month base (all environments at 400 RU/s)
- Auto-scaling only when production actually needs it
- Single billing and monitoring
- Unified backup strategy

**Multiple Account Approach (Alternative):**

- Would cost: $432+ minimum (3 accounts × $144 base cost)
- Additional management overhead
- Separate billing complexity
- More complex backup coordination

**Savings: 83%+ cost reduction** compared to multiple CosmosDB accounts

## Throughput Allocation Strategy

### Container Usage Patterns

**High Volume Containers:**

- `temperatures` - 70% of operations (continuous IoT telemetry)
- `cooks` - 20% of operations (session management)

**Medium Volume Containers:**

- `devices` - 5% of operations (configuration changes)
- `users` - 3% of operations (user management)

**Low Volume Containers:**

- `recipes` - 2% of operations (recipe browsing)

### Shared Throughput Benefits

Using **database-level shared throughput** instead of container-level provides:

- **Cost Efficiency**: ~40% savings vs. individual container throughput
- **Automatic Load Balancing**: High-volume containers can use available RU/s
- **Simplified Management**: Single throughput configuration per environment

## Data Retention Strategy

### Temperature Data (Largest Volume)

- **Development**: 7-day TTL → Minimal storage costs
- **Staging**: 30-day TTL → Reduced storage for testing
- **Production**: 90-day TTL → Full historical analysis capability

### Other Data (Smaller Volume)

- No TTL configured (persistent data)
- Cook sessions, user data, device configs retained indefinitely
- Manual cleanup processes for old test data

## Scaling Strategy

### Development Environment

- **Fixed 400 RU/s**: Sufficient for 1-2 developers
- **No Auto-scaling**: Predictable costs
- **Minimal Retention**: Cost-optimized for testing

### Staging Environment

- **Fixed 800 RU/s**: Supports integration testing load
- **Auto-scale to 4000 RU/s**: Handle load testing spikes
- **Medium Retention**: Balance between testing needs and cost

### Production Environment

- **Base 2000 RU/s**: Handle normal production load
- **Auto-scale to 10,000+ RU/s**: Handle traffic spikes and growth
- **Full Retention**: Complete historical data for analytics

## Performance Characteristics

### Query Performance

- **Partition Strategy**: Optimized for access patterns
  - Temperatures by `/deviceId` → Device-specific queries
  - Cooks by `/userId` → User-specific queries
  - Users by `/id` → Direct user lookups
  - Recipes by `/userId` → User recipe management

### Indexing Strategy

- **Composite Indexes**: Optimized for common query patterns
- **Excluded Paths**: Reduce indexing overhead for unused fields
- **Consistent Indexing**: Real-time query consistency

### Geographic Distribution

- **Development/Staging**: Single region (North Central US)
- **Production**: Option for multi-region (when needed)

## Cost Monitoring

### Budget Alerts

- Development: $50/month alert threshold (covers base + some scaling)
- Staging: $75/month alert threshold (covers base + moderate scaling)
- Production: $200/month alert threshold (covers base + significant scaling)

### Cost Optimization Triggers

- **400 RU/s sustained usage in dev** → Consider reducing TTL
- **4000+ RU/s sustained usage in staging** → Optimize queries
- **10,000+ RU/s sustained usage in prod** → Consider scaling strategy

## Migration and Environment Management

### Environment Setup Order

1. **Development First**: Create `meatgeek-dev` database for initial testing
2. **Staging Second**: Add `meatgeek-staging` for integration testing
3. **Production Last**: Create `meatgeek-prod` when ready for launch

### Data Migration

- **Environment Isolation**: No data sharing between environment databases
- **Fresh Start**: Each environment starts with clean data
- **Test Data**: Separate seeding strategies per environment

### Backup Strategy

- **Development**: No backup (disposable data)
- **Staging**: 7-day backup retention (integration testing protection)
- **Production**: 30-day backup retention + point-in-time recovery

## Performance Analysis: Why 400 RU/s Works

### MeatGeek V2 Usage Patterns

- **Temperature Writes**: 1 device × 12 readings/minute = 720 writes/hour
- **Temperature Reads**: Moderate query frequency for dashboards
- **Cook Operations**: Low frequency (start/stop/update sessions)
- **User Operations**: Very low frequency (profile updates)

### 400 RU/s Capacity

- **~1,440,000 operations/hour** theoretical maximum
- **720 temp writes/hour** = 0.05% utilization for 1 device
- **Can support 100+ active devices** comfortably at base throughput
- **Auto-scaling handles traffic spikes** automatically

### Benefits of This Approach

### For Development

- **Ultra-Low Cost**: Only $24/month for full development database
- **Fast Iteration**: Quick cleanup with short TTL
- **Isolation**: No risk of affecting other environments

### For Operations

- **Cost Control**: Predictable costs with scaling only where needed
- **Environment Isolation**: Complete separation between dev/staging/prod
- **Unified Management**: Single CosmosDB account to manage

### For Scale

- **Independent Scaling**: Each environment scales based on its needs
- **Performance Isolation**: Production performance not affected by dev/staging
- **Geographic Options**: Can add regions to production database independently

## Implementation Notes

### Terraform Configuration

- Reference existing CosmosDB account via data source
- Create environment-specific databases as resources
- Configure containers with optimized partition keys and indexing
- Set appropriate TTL and throughput per environment

### Application Configuration

```javascript
// Environment-specific database connection
const cosmosConfig = {
  connectionString: process.env.COSMOS_CONNECTION_STRING,
  databaseName: `meatgeek-${process.env.ENVIRONMENT}`, // meatgeek-dev, meatgeek-staging, meatgeek-prod
  environment: process.env.ENVIRONMENT,
};
```

### DevOps Practices

- Separate Terraform state per environment
- Environment-specific connection strings in Azure Key Vault
- Automated cost monitoring and alerting per database
- Performance monitoring per environment database

This strategy maximizes the value of your single CosmosDB account while maintaining proper architectural separation, cost control, and performance isolation across all environments.
