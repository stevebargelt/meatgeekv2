# CosmosDB Cost Allocation Strategy for MeatGeek V2

## Overview

This document outlines the cost-optimized approach for using a single CosmosDB account across multiple environments for the MeatGeek V2 system.

## MG-54 Cleanup: Mandatory Two-Phase Apply (delete-before-limit)

> **Operational runbook — read before applying the MG-54 change.** This is the
> **second authorization point** in the dev cosmos migration. No live apply is
> performed by the code change itself; the orchestrator owns the recovery apply.

### What the MG-54 change does

The MG-54 edit to `apps/infrastructure/modules/cosmos-db/main.tf` is a **pure
destroy** of exactly six source resources plus **one in-place account attribute
add**:

- Deletes the five source containers and the source database:
  - `module.cosmos_db.azurerm_cosmosdb_sql_database.meatgeek`
  - `module.cosmos_db.azurerm_cosmosdb_sql_container.devices`
  - `module.cosmos_db.azurerm_cosmosdb_sql_container.temperatures`
  - `module.cosmos_db.azurerm_cosmosdb_sql_container.cooks`
  - `module.cosmos_db.azurerm_cosmosdb_sql_container.users`
  - `module.cosmos_db.azurerm_cosmosdb_sql_container.recipes`
- Adds a `capacity { total_throughput_limit = 1000 }` block to
  `azurerm_cosmosdb_account.main` (the free-tier account ceiling — dev already
  has `cosmos_enable_free_tier = true`). This is an **in-place update** of the
  account, never a replace.

The destination twins — `azurerm_cosmosdb_sql_database.meatgeek_shared` and the
five `*_shared` containers — and every `destination_*` output are left
**untouched** (MG-62 consumes them).

### Why a single `terraform apply` is unsafe

The account-level ceiling `total_throughput_limit = 1000` is **below the
~2400 RU/s currently provisioned** while the five source container-level offers
still exist. Azure **rejects** an account throughput ceiling that sits below the
sum of the account's currently provisioned offers.

A single `terraform apply` does **not** guarantee the ordering that would make
the ceiling safe:

- Terraform will destroy the source **children** (containers, then database)
  before it would touch the account.
- But the ceiling is an **in-place UPDATE on the parent account**, and there is
  **no graph edge** forcing that parent update to run _after_ the child destroys
  have settled at the service level. Dependency edges order create/destroy of
  the _tree_; they do not sequence an in-place parent-attribute update behind the
  service-side settling of child deletions.
- So within one apply the ceiling can land while ~2400 RU/s of source offers are
  still provisioned, and Azure rejects it — a failed, half-applied run.

Ordering therefore must be **enforced operationally as two applies**, not relied
upon inside a single plan.

### The procedure

**Phase 1 — targeted destroy of the six source resources.**
Destroy _only_ the six source resources, in isolation. **Never a bare
`terraform apply`** — a bare apply re-plans at apply time and discards the change
set the guard reviewed. Follow the same `plan -out` → destroy-guard →
`apply <saved-plan>` sequence the automatic reconciler uses, so the destructive
change set that is applied is exactly the one the guard authorized:

1. **Plan the six targeted destroys to a saved plan file** (run from
   `apps/infrastructure/`):

   ```
   terraform plan -input=false -lock-timeout=5m \
     -var-file=environments/dev.tfvars \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_database.meatgeek \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_container.devices \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_container.temperatures \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_container.cooks \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_container.users \
     -target=module.cosmos_db.azurerm_cosmosdb_sql_container.recipes \
     -out=tfplan-phase1.bin
   ```

2. **Pass the saved plan through the fail-closed destroy guard**, authorizing
   EXACTLY the six source `delete` tokens (see the token list below) and nothing
   else. The guard fails closed on any extra token, any missing token, or any
   `replace` (`-/+`) on the six:

   ```
   TF_DESTROY_GUARD_AUTHORIZED_CHANGES='delete:module.cosmos_db.azurerm_cosmosdb_sql_database.meatgeek,delete:module.cosmos_db.azurerm_cosmosdb_sql_container.devices,delete:module.cosmos_db.azurerm_cosmosdb_sql_container.temperatures,delete:module.cosmos_db.azurerm_cosmosdb_sql_container.cooks,delete:module.cosmos_db.azurerm_cosmosdb_sql_container.users,delete:module.cosmos_db.azurerm_cosmosdb_sql_container.recipes' \
     scripts/tf-plan-destroy-guard.sh tfplan-phase1.bin
   ```

   The guard must print `DESTRUCTIVE APPLY AUTHORIZED` (exit 0). If it prints any
   `planned but NOT authorized` / `authorized but NOT in this plan` line, or any
   `PROTECTED` token beyond the six above, **stop** — the plan is not the change
   set you reviewed.

3. **Only then apply the saved plan** — the exact reviewed `tfplan-phase1.bin`,
   never a re-plan:

   ```
   terraform apply -input=false -lock-timeout=5m -auto-approve tfplan-phase1.bin
   ```

Then **confirm the account settles to 400 RU/s provisioned** — the single
`meatgeek_shared` database-level offer — before proceeding. Do not start Phase 2
until the account is observed at 400 RU/s.

**Phase 2 — full apply of the account ceiling.**
Run the same `plan -out` → destroy-guard → `apply <saved-plan>` sequence, this
time with NO targeting and NO authorization override. With the source offers gone
and the account now at a 400 RU/s steady state, the plan lands the account's
**in-place capacity update** to `total_throughput_limit = 1000` — comfortably
above 400 — and Azure accepts it.

1. **Plan the full change to a saved plan file:**

   ```
   terraform plan -input=false -lock-timeout=5m \
     -var-file=environments/dev.tfvars \
     -out=tfplan-phase2.bin
   ```

2. **Pass the saved plan through the destroy guard with NO override.** Phase 2
   carries only the account's in-place `~ update` and **no destroy token at
   all**, so the guard's protected-change set is empty and it must PASS with no
   `TF_DESTROY_GUARD_AUTHORIZED_CHANGES` set. Any destructive token appearing
   here is a defect — **stop**:

   ```
   scripts/tf-plan-destroy-guard.sh tfplan-phase2.bin
   ```

   The guard must print `PASS — this plan destroys nothing and orphans nothing`
   (exit 0).

3. **Only then apply the saved plan:**

   ```
   terraform apply -input=false -lock-timeout=5m -auto-approve tfplan-phase2.bin
   ```

### Each phase's plan is gated by `scripts/tf-plan-destroy-guard.sh`

Both phase plans pass through the fail-closed destroy guard, and the expected
protected-change set differs per phase:

- **Phase 1** authorizes **exactly six `delete` tokens** — one per source
  resource — and no other destructive token:
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_database.meatgeek`
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_container.devices`
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_container.temperatures`
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_container.cooks`
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_container.users`
  - `delete:module.cosmos_db.azurerm_cosmosdb_sql_container.recipes`

  Each must be a **pure delete**, never a replace (`-/+`). Any replace on the
  six, or any `delete`/`replace`/`forget` token on any other resource (the
  account, the destination twins, IoT Hub routes/endpoints/consumer groups, role
  assignments, diagnostic settings), is a defect — **stop**.

- **Phase 2** shows the account as a single in-place `~ update` carrying
  `capacity { total_throughput_limit = 1000 }` and **no destroy token at all**.
  The guard's authorized-changes set for Phase 2 is therefore **empty** (an
  in-place update is not a protected change); any destructive token appearing in
  the Phase 2 plan is a defect.

### No live apply in the MG-54 code change

The MG-54 code deliverable is documentation + the single coherent final module
state. **No live `terraform apply` is performed by this change.** The
orchestrator executes the two-phase runbook above at recovery-apply time, under
a separate destroy authorization that also names the disposal of the synthetic
fixture documents.

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
