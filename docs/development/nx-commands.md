# NX Development Commands

## Overview

This document provides a comprehensive reference for NX commands used in the MeatGeek V2 development workflow. The monorepo structure enables powerful development commands that work across all applications and libraries.

## Workspace Management

### Project Information
```bash
# List all projects in the workspace
nx show projects

# Show project details
nx show project api
nx show project mobile

# Show workspace configuration
nx show

# Generate dependency graph
nx dep-graph

# Show affected projects after changes
nx affected:graph
```

### Dependency Management
```bash
# Install dependencies for entire workspace
npm install

# Add dependency to specific project
npm install lodash --workspace=apps/api
npm install -D @types/lodash --workspace=apps/api

# Add shared dependency to workspace root
npm install typescript --save-dev
```

## Building Projects

### Individual Project Builds
```bash
# Build specific applications
nx build api                    # Azure Functions API
nx build web                    # React web application
nx build mobile                 # React Native mobile app
nx build device-controller      # Go device controller (calls make build)
nx build data-pusher           # Go IoT service (calls make build)

# Build with specific configurations
nx build mobile --configuration=production
nx build-arm device-controller # Cross-compile for Raspberry Pi (calls make build-arm)
nx build api --configuration=development
```

### Batch Operations
```bash
# Build all projects
nx run-many --target=build --all

# Build all projects in parallel
nx run-many --target=build --all --parallel=4

# Build only affected projects
nx affected:build

# Build with specific tag filter
nx run-many --target=build --projects=tag:type:app
```

### Environment-Specific Builds
```bash
# Production builds
nx build web --configuration=production
nx build mobile --configuration=production --platform=ios
nx build mobile --configuration=production --platform=android

# Development builds with source maps
nx build api --configuration=development
nx build web --configuration=development
```

## Development Servers

### Starting Development Servers
```bash
# Start individual development servers
nx serve web                    # Web app at http://localhost:3000
nx serve api                    # Azure Functions at http://localhost:7071
nx serve mobile                 # React Native metro bundler
nx serve device-simulator       # Device simulator for testing

# Start with specific configurations
nx serve web --port=3001
nx serve api --port=7072
nx serve mobile --platform=ios
```

### Multiple Services
```bash
# Start multiple services in parallel
nx run-many --target=serve --projects=web,api --parallel

# Start all development servers
nx run-many --target=serve --all --parallel
```

## Testing

### Unit Testing
```bash
# Run tests for specific projects
nx test api                     # API unit tests
nx test ui-components          # Component tests
nx test data-models           # Business logic tests
nx test device-controller     # Go unit tests

# Test with options
nx test api --watch            # Watch mode
nx test api --coverage         # Generate coverage report
nx test api --verbose          # Verbose output
```

### Batch Testing
```bash
# Run all tests
nx run-many --target=test --all

# Run tests for affected projects
nx affected:test

# Run tests in parallel
nx run-many --target=test --all --parallel=4

# Run specific test suites
nx run-many --target=test --projects=tag:type:lib
```

### End-to-End Testing
```bash
# Run E2E tests
nx e2e web-e2e                 # Web application E2E
nx e2e mobile-e2e              # Mobile application E2E

# Run E2E tests with specific browser
nx e2e web-e2e --browser=chrome
nx e2e web-e2e --browser=firefox
```

## Code Quality

### Linting
```bash
# Lint specific projects
nx lint api
nx lint web
nx lint ui-components
nx lint device-controller      # Go linting with golint

# Lint with auto-fix
nx lint api --fix
nx lint web --fix

# Lint all projects
nx run-many --target=lint --all

# Lint affected projects
nx affected:lint
```

### Formatting
```bash
# Format entire workspace
nx format:write

# Check formatting without changes
nx format:check

# Format specific files
nx format:write --files="apps/api/src/main.ts,libs/utils/src/index.ts"

# Format Go code
nx run device-controller:format  # Uses gofmt
```

## Device-Specific Commands

### Go Applications (Makefile-based)

Go projects use Makefiles for build logic, with NX providing orchestration:

```bash
# Build for local development (native architecture)
nx build device-controller      # Calls: make build
nx build data-pusher           # Calls: make build

# Cross-compile for Raspberry Pi (ARM64)
nx build-arm device-controller # Calls: make build-arm
nx build-arm data-pusher       # Calls: make build-arm

# Run Go tests
nx test device-controller      # Calls: make test
nx test data-pusher           # Calls: make test

# Go-specific linting and formatting
nx lint device-controller      # Calls: make lint (golangci-lint + go vet)
nx format device-controller    # Calls: make format (gofmt + goimports)
```

**Alternative: Direct Make commands** (useful for debugging):
```bash
# Navigate to project and use Make directly
cd apps/device-controller
make build                     # Local build
make build-arm                 # ARM cross-compile
make test                      # Run tests
make lint                      # Lint code
make format                    # Format code
make dev                       # Development server with mock sensors
make clean                     # Clean build artifacts

# Same commands available for data-pusher
cd apps/data-pusher
make build
make build-arm
# ... etc
```

### Mobile Applications
```bash
# Platform-specific builds
nx build mobile --platform=ios
nx build mobile --platform=android

# Development servers by platform
nx serve mobile --platform=ios
nx serve mobile --platform=android

# Device deployment
nx run mobile:deploy --platform=ios --device=simulator
nx run mobile:deploy --platform=android --device=emulator
```

## Infrastructure Management

### Terraform Operations
```bash
# Initialize Terraform against the remote backend. `nx init` binds only the
# backend-*.hcl and does NOT pass the derived storage_account_name, so init the
# remote backend directly (ARM_SUBSCRIPTION_ID must be exported):
#   cd apps/infrastructure && terraform init -reconfigure \
#     -backend-config=environments/backend-dev.hcl \
#     -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
nx init infrastructure   # hcl-only; insufficient for the remote backend on its own

# Plan infrastructure changes
nx plan infrastructure --env=dev
nx plan infrastructure --env=staging
nx plan infrastructure --env=prod

# Apply infrastructure changes
nx apply infrastructure --env=dev
nx apply infrastructure --env=prod

# Validate Terraform configuration
nx validate infrastructure

# Destroy infrastructure (careful!)
nx destroy infrastructure --env=dev
```

### Azure Deployment
```bash
# Deploy API to Azure Functions
nx deploy api --env=dev
nx deploy api --env=prod

# Deploy web app to Azure Static Web Apps (dev only)
nx deploy web --env=dev
```

> **Prod is API-only, and prod app deploys are CI-gated — not run by hand.** The `nx deploy api --env=prod` command above is what the `app-deploy-prod.yml` workflow runs; in normal operation you don't invoke it yourself. That workflow is triggered by `workflow_run` **after the CI/CD Pipeline completes green on a push to `main`**, and only when the repository variable `PROD_DEPLOY_ENABLED == 'true'`. It has **no `workflow_dispatch`** — retry a failed deploy via GitHub's **re-run**, not a manual command. Prod **infra** deploy (`infra-deploy-prod.yml`) is `workflow_dispatch`-only and **plan-only** (no `terraform apply`) pending MG-24. There is no production web/Static Web Apps deploy — `nx deploy web --env=prod` is not implemented; do not run it. See [CI/CD Pipeline → Prod](ci-cd.md#prod) for the full gating model.

## Library Development

### Code Generation
```bash
# Generate new library
nx generate @nx/js:library my-utils --directory=libs

# Generate React component library
nx generate @nx/react:library ui-components --directory=libs

# Generate Angular library (if needed)
nx generate @nx/angular:library data-access --directory=libs

# Generate specific components
nx generate @nx/react:component Button --project=ui-components
nx generate @nx/js:lib temperature-utils --project=data-models
```

> **After generating a new project**, add two things the generators don't scaffold for this workspace:
> 1. A local `.eslintrc.json` — the root config sets `ignorePatterns: ["**/*"]`, so a project without its own override is silently skipped by `nx lint`.
> 2. For a buildable library, a `package.json` whose `name` matches its `@meatgeekv2/*` alias in `tsconfig.base.json`, or dependents fail to build with `TS6059`.
>
> See [Local Setup → New project checklist](local-setup.md#new-project-checklist) and the [Buildable Library Pattern](../architecture/monorepo-structure.md#buildable-library-pattern).

### API Development
```bash
# Generate new Azure Function
nx generate @nx/azure:function process-temperature --project=api

# Generate OpenAPI client
nx run api-specs:generate-client --platform=typescript
nx run api-specs:generate-client --platform=react-native

# Validate OpenAPI specifications
nx run api-specs:validate
```

## Performance and Optimization

### Affected Project Detection
```bash
# Show what's affected by recent changes
nx affected:graph

# Show affected projects since specific commit
nx affected:graph --base=main

# Show affected projects between branches
nx affected:graph --base=develop --head=feature-branch
```

### Build Optimization
```bash
# Build only what's needed
nx affected:build --base=main

# Use distributed caching (NX Cloud)
nx connect-to-nx-cloud

# Clear NX cache
nx reset

# Print build timing information
nx build api --verbose
```

## Debugging and Development

### Development with Live Reload
```bash
# Start development with live reload
nx serve web --live-reload
nx serve api --live-reload

# Start with debugger attached
nx serve api --inspect=9229
```

### Production Simulation
```bash
# Build and serve production build locally
nx build web --configuration=production
nx serve web --configuration=production --port=8080

# Test production mobile build
nx build mobile --configuration=production
nx serve mobile --configuration=production
```

## Advanced Commands

### Custom Executors
```bash
# Run custom deployment scripts
nx run api:deploy-azure --env=prod
nx run mobile:deploy-appstore --platform=ios

# Run custom database operations
nx run api:migrate-database --env=dev
nx run api:seed-data --env=dev
```

### Workspace Maintenance
```bash
# Migrate to newer NX version
nx migrate @nx/workspace@latest

# Update all dependencies
nx migrate --run-migrations

# Check for outdated dependencies
nx report
```

## Common Workflows

### Daily Development
```bash
# 1. Start development environment
nx run-many --target=serve --projects=api,web --parallel

# 2. Make changes and test affected projects  
nx affected:test
nx affected:lint

# 3. Build affected projects
nx affected:build

# 4. Commit changes
git add .
git commit -m "feature: add new temperature chart"
```

### Feature Development
```bash
# 1. Create feature branch
git checkout -b feature/new-dashboard

# 2. Generate new components/libraries as needed
nx generate @nx/react:component Dashboard --project=web

# 3. Develop with live reload
nx serve web

# 4. Test continuously
nx test web --watch

# 5. Verify everything works before merging
nx affected:build --base=main
nx affected:test --base=main
```

### Production Deployment
```bash
# 1. Build production artifacts
nx run-many --target=build --configuration=production --all

# 2. Deploy infrastructure changes first
nx apply infrastructure --env=prod

# 3. Deploy applications (prod is API-only — no prod web deploy yet)
nx deploy api --env=prod

# 4. Deploy device updates  
nx build-arm device-controller   # Cross-compile for ARM
# Manual deployment to Raspberry Pi devices
```

---

> **Tip**: Use `nx --help` for general help, or `nx <command> --help` for specific command options. Many commands support `--dry-run` to preview changes without executing them.