# MeatGeek V2 System Architecture Plan

## Overview

Design a cloud-based BBQ temperature monitoring system that:

- Collects temperature data from the existing device controller
- Stores data in Azure CosmosDB
- Provides mobile (React Native) and web (React) interfaces
- Manages cooking sessions with historical data tracking
- Enables real-time temperature monitoring

## Current Device Controller Analysis

The existing Go-based device controller provides:

- Temperature monitoring from 5 RTD sensors (grill + 4 probes)
- Local API on port 3000 with endpoints:
  - `/api/robots/MeatGeekBot/commands/get_status` - Full device status
  - `/api/robots/MeatGeekBot/commands/get_temps` - Temperature readings only
- Real-time LCD display
- Temperature averaging with 100-sample queues
- Azure Application Insights integration for monitoring and telemetry

Data structures available:

```json
{
  "temps": {
    "grillTemp": 225.0,
    "probe1Temp": 160.0,
    "probe2Temp": 145.0,
    "probe3Temp": null,
    "probe4Temp": 200.0
  },
  "status": {
    "smokerid": "meatgeek3",
    "augerOn": false,
    "blowerOn": false,
    "igniterOn": false,
    "fireHealthy": true,
    "mode": "test",
    "setPoint": 200,
    "currentTime": "2025-01-XX:XX:XX"
  }
}
```

## System Architecture

### Monorepo Architecture (NX Workspace)

#### Repository: `meatgeekv2`

The entire MeatGeek V2 system is organized as an NX monorepo hosted at `https://github.com/stevebargelt/meatgeekv2`. This structure provides unified development, build, and deployment workflows while enabling code reuse and consistency across all applications.

#### NX Workspace Structure

```
meatgeekv2/
├── apps/
│   ├── api/                     # Azure Functions API (TypeScript)
│   │   ├── src/
│   │   │   ├── functions/       # Individual Azure Functions
│   │   │   ├── shared/          # Shared function utilities
│   │   │   └── main.ts          # Function app entry point
│   │   ├── host.json
│   │   ├── local.settings.json
│   │   └── project.json
│   ├── mobile/                  # React Native mobile app
│   │   ├── src/
│   │   │   ├── screens/
│   │   │   ├── components/
│   │   │   ├── navigation/
│   │   │   └── services/
│   │   ├── android/
│   │   ├── ios/
│   │   └── project.json
│   ├── web/                     # React web application
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   └── services/
│   │   ├── public/
│   │   └── project.json
│   ├── device-controller/       # Current Raspberry Pi device controller (Go)
│   │   ├── main.go
│   │   ├── goqueue/
│   │   ├── go.mod
│   │   ├── go.sum
│   │   ├── build.sh
│   │   ├── README.md
│   │   └── project.json
│   ├── data-pusher/            # New Go service for cloud integration
│   │   ├── cmd/
│   │   ├── internal/
│   │   ├── pkg/
│   │   ├── go.mod
│   │   └── project.json
│   └── device-simulator/        # Development and testing tool
│       ├── src/
│       └── project.json
├── libs/
│   ├── api-interfaces/          # Shared TypeScript types and interfaces
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── temperature.ts
│   │   │   │   ├── cook.ts
│   │   │   │   ├── device.ts
│   │   │   │   └── user.ts
│   │   │   └── index.ts
│   │   └── project.json
│   ├── ui-components/           # Shared React/React Native components
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── TemperatureDisplay/
│   │   │   │   ├── CookCard/
│   │   │   │   ├── DeviceStatus/
│   │   │   │   └── ChartComponents/
│   │   │   └── index.ts
│   │   └── project.json
│   ├── data-models/             # Domain models and business logic
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── temperature-calculator.ts
│   │   │   │   ├── cook-manager.ts
│   │   │   │   └── validation.ts
│   │   │   └── index.ts
│   │   └── project.json
│   ├── azure-client/            # Azure service clients and utilities
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── cosmos-client.ts
│   │   │   │   ├── iot-client.ts
│   │   │   │   ├── signalr-client.ts
│   │   │   │   └── auth-client.ts
│   │   │   └── index.ts
│   │   └── project.json
│   ├── realtime/                # SignalR client logic and real-time utilities
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── connection-manager.ts
│   │   │   │   ├── temperature-hub.ts
│   │   │   │   └── cook-hub.ts
│   │   │   └── index.ts
│   │   └── project.json
│   ├── charts/                  # Chart components and data visualization
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── TemperatureChart/
│   │   │   │   ├── CookHistoryChart/
│   │   │   │   └── LiveChart/
│   │   │   └── index.ts
│   │   └── project.json
│   ├── tracing/                 # OpenTelemetry tracing and observability
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── trace-context.ts
│   │   │   │   ├── correlation.ts
│   │   │   │   ├── react-hooks.ts
│   │   │   │   ├── azure-exporter.ts
│   │   │   │   └── trace-helpers.ts
│   │   │   └── index.ts
│   │   └── project.json
│   ├── api-specs/               # OpenAPI 3.0 specifications and tooling
│   │   ├── specs/
│   │   │   ├── meatgeek-api.yaml        # Main OpenAPI specification
│   │   │   ├── components/
│   │   │   │   ├── schemas.yaml         # Shared data models
│   │   │   │   ├── responses.yaml       # Common responses
│   │   │   │   ├── parameters.yaml      # Reusable parameters
│   │   │   │   └── security.yaml        # Authentication schemes
│   │   │   ├── paths/
│   │   │   │   ├── cooks.yaml           # Cook management endpoints
│   │   │   │   ├── temperatures.yaml    # Temperature data endpoints
│   │   │   │   ├── devices.yaml         # Device management endpoints
│   │   │   │   ├── recipes.yaml         # Recipe endpoints
│   │   │   │   └── auth.yaml            # Authentication endpoints
│   │   │   └── webhooks/
│   │   │       ├── temperature-alerts.yaml
│   │   │       └── cook-completed.yaml
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── spec-loader.ts       # Load and merge OpenAPI specs
│   │   │   │   ├── validation.ts        # Runtime request/response validation
│   │   │   │   ├── type-generator.ts    # Generate TypeScript types
│   │   │   │   └── client-generator.ts  # Generate API clients
│   │   │   └── index.ts
│   │   ├── tools/
│   │   │   ├── generate-types.js        # Build script for type generation
│   │   │   ├── generate-clients.js      # Generate API client SDKs
│   │   │   ├── validate-specs.js        # Validate OpenAPI specifications
│   │   │   ├── serve-docs.js            # Serve Swagger UI locally
│   │   │   ├── bundle-specs.js          # Bundle multi-file specs into single file
│   │   │   ├── mock-server.js           # Create mock API server from specs
│   │   │   └── watch-and-rebuild.js     # Development mode file watcher
│   │   ├── generated/                   # Auto-generated files (gitignored)
│   │   │   ├── types/                   # Generated TypeScript interfaces
│   │   │   ├── clients/                 # Generated API clients
│   │   │   └── docs/                    # Generated documentation
│   │   ├── jest.config.js               # Jest configuration for spec validation tests
│   │   ├── package.json                 # Node.js dependencies for tooling
│   │   └── project.json                 # NX project configuration
│   └── utils/                   # Shared utilities and helpers
│       ├── src/
│       │   ├── lib/
│       │   │   ├── date-utils.ts
│       │   │   ├── temperature-utils.ts
│       │   │   ├── formatting.ts
│       │   │   └── constants.ts
│       │   └── index.ts
│       └── project.json
├── tools/
│   ├── scripts/
│   │   ├── deploy-api.sh
│   │   ├── build-mobile.sh
│   │   └── setup-azure.sh
│   └── generators/
│       ├── azure-function/
│       └── react-component/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-api.yml
│       ├── deploy-web.yml
│       └── build-mobile.yml
├── nx.json                      # NX workspace configuration (each project self-configured via its own project.json)
├── package.json                 # Root package.json with shared dependencies
├── tsconfig.base.json           # Base TypeScript configuration
├── .eslintrc.json              # Shared ESLint configuration
├── jest.config.js              # Jest test configuration
└── README.md
```

#### Benefits of NX Monorepo Architecture

**Code Reuse and Consistency**

- Shared TypeScript interfaces ensure type safety across all applications
- Common UI components reduce duplication between web and mobile apps
- Unified business logic in `data-models` library
- Consistent coding standards and linting rules

**Efficient Development Workflow**

- Single `npm install` for entire workspace
- Parallel execution of builds, tests, and lints
- Incremental builds - only rebuild affected projects
- Integrated dependency graph visualization
- Shared tooling configuration

**Build and Deployment Optimization**

- NX affected commands identify changed projects
- Distributed caching with NX Cloud
- Optimized CI/CD pipelines
- Environment-specific build configurations

**Developer Experience**

- IntelliSense and auto-completion across all projects
- Unified debugging and testing experience
- Consistent project structure and conventions
- Easy code navigation between related projects

#### NX Commands for Common Tasks

```bash
# Install dependencies for all projects
npm install

# Build all projects
nx run-many --target=build --all

# Build only affected projects
nx affected:build

# Test all projects
nx run-many --target=test --all

# Run mobile app in development
nx serve mobile

# Run web app in development
nx serve web

# Deploy API to Azure
nx deploy api

# Lint all projects
nx run-many --target=lint --all

# Generate dependency graph
nx dep-graph
```

### 1. Data Ingestion Layer

#### Device Controller (apps/device-controller)

**Purpose**: Hardware interface and local temperature monitoring
**Technology**: Existing Go application running on Raspberry Pi
**Key Features**:

- Direct hardware communication with RTD sensors via MCP3008 ADC
- LCD display output for local monitoring
- HTTP API on port 3000 providing:
  - `/api/robots/MeatGeekBot/commands/get_status` - Full device status
  - `/api/robots/MeatGeekBot/commands/get_temps` - Temperature readings
- Temperature averaging with 100-sample queues
- Azure Application Insights integration for monitoring and telemetry
- Runs independently of cloud connectivity

**Integration with Monorepo**:

- Maintained as a standalone Go app within the monorepo
- Can be built and deployed using NX custom executors
- Shares common Go utilities with data-pusher service
- Version controlled alongside all other system components

#### Temperature Data Pusher Service (apps/data-pusher)

**Purpose**: Bridge between device controller and Azure cloud
**Technology**: New Go service running alongside device controller on Raspberry Pi
**Key Features**:

- Polls device controller's local API every 5-10 seconds
- Pushes data to Azure IoT Hub using MQTT or HTTPS
- Local buffering with SQLite for network outages
- Device authentication with connection strings
- Configurable polling intervals
- Health monitoring and auto-restart
- Runs as systemd service alongside device controller

**Implementation Details**:

```go
type TemperatureReading struct {
    DeviceID    string    `json:"deviceId"`
    Timestamp   time.Time `json:"timestamp"`
    GrillTemp   *float64  `json:"grillTemp"`
    Probe1Temp  *float64  `json:"probe1Temp"`
    Probe2Temp  *float64  `json:"probe2Temp"`
    Probe3Temp  *float64  `json:"probe3Temp"`
    Probe4Temp  *float64  `json:"probe4Temp"`
    CookID      *string   `json:"cookId,omitempty"`
}

type DeviceStatus struct {
    DeviceID     string    `json:"deviceId"`
    Timestamp    time.Time `json:"timestamp"`
    AugerOn      bool      `json:"augerOn"`
    BlowerOn     bool      `json:"blowerOn"`
    IgniterOn    bool      `json:"igniterOn"`
    FireHealthy  bool      `json:"fireHealthy"`
    Mode         string    `json:"mode"`
    SetPoint     int       `json:"setPoint"`
}
```

### 2. Azure Infrastructure

#### Core Services

- **Azure IoT Hub**:
  - Ingests telemetry from devices
  - Device-to-cloud messaging
  - Device twins for configuration
  - Connection state monitoring

- **Azure Functions**:
  - Serverless compute for API endpoints
  - Event-driven data processing
  - Auto-scaling based on demand

- **CosmosDB (SQL API)**:
  - Multi-region replication
  - Automatic scaling
  - Change feed for real-time updates

- **Azure SignalR Service**:
  - Real-time temperature updates
  - Cook status notifications
  - Client connection management

- **Azure Storage**:
  - Cook photos and charts
  - Data exports (CSV, JSON)
  - Static website hosting for web app

- **Azure AD B2C**:
  - User authentication
  - Social login providers
  - Multi-tenant support

#### Benefits of Azure Monitor over NewRelic

**Unified Azure Ecosystem**:

- Single billing and management portal
- Seamless integration with all Azure services
- No need for separate monitoring subscriptions
- Native correlation between IoT data and cloud services

**Cost Efficiency**:

- Application Insights included in Azure consumption model
- No per-host or per-transaction pricing
- Pay only for data ingested and retained
- Free tier available for development and testing

**Enhanced Integration**:

- Direct connection from Raspberry Pi to Azure Monitor
- Real-time correlation of device metrics with cloud performance
- Unified dashboards showing entire system health
- Cross-service dependency mapping

**Advanced Analytics**:

- Kusto Query Language (KQL) for powerful data analysis
- Custom workbooks for specialized BBQ analytics
- Machine learning integration for predictive maintenance
- Export to Power BI for advanced reporting

**Better Alerting**:

- Smart detection for anomaly identification
- Multi-dimensional metrics and alerting
- Integration with Azure Action Groups
- Mobile app notifications through Azure Notification Hubs

### 3. Data Model (CosmosDB)

#### Collection: `devices`

```json
{
  "id": "meatgeek3",
  "userId": "user123",
  "name": "Backyard Smoker",
  "model": "MeatGeek V1",
  "location": "Austin, TX",
  "connectionString": "encrypted-connection-string",
  "lastSeen": "2025-01-26T10:30:00Z",
  "isActive": true,
  "configuration": {
    "grillProbeCorrection": -6.0,
    "probe1Correction": -8.0,
    "probe2Correction": 2.0,
    "probe3Correction": -1.0,
    "probe4Correction": -5.0
  }
}
```

#### Collection: `temperatures`

**Partition Key**: `/deviceId`

```json
{
  "id": "meatgeek3-2025-01-26-10-30-15-123",
  "deviceId": "meatgeek3",
  "timestamp": "2025-01-26T10:30:15.123Z",
  "grillTemp": 225.5,
  "probe1Temp": 165.2,
  "probe2Temp": 145.8,
  "probe3Temp": null,
  "probe4Temp": 200.1,
  "cookId": "cook-456",
  "ttl": 7776000
}
```

#### Collection: `cooks`

**Partition Key**: `/userId`

```json
{
  "id": "cook-456",
  "userId": "user123",
  "deviceId": "meatgeek3",
  "name": "Weekend Brisket",
  "meatType": "brisket",
  "weight": 12.5,
  "startTime": "2025-01-26T06:00:00Z",
  "endTime": "2025-01-26T20:00:00Z",
  "status": "completed",
  "targetTemps": {
    "grill": 225,
    "probe1": 203,
    "probe2": null,
    "probe3": null,
    "probe4": null
  },
  "actualDuration": 14.0,
  "maxTemps": {
    "grill": 245,
    "probe1": 205,
    "probe2": null,
    "probe3": null,
    "probe4": null
  },
  "notes": "Perfect bark, pulled at 203°F",
  "photos": ["cook-456-before.jpg", "cook-456-after.jpg"],
  "rating": 5,
  "isPublic": false
}
```

#### Collection: `users`

**Partition Key**: `/id`

```json
{
  "id": "user123",
  "email": "bbq@example.com",
  "name": "John Pitmaster",
  "preferences": {
    "temperatureUnit": "fahrenheit",
    "notifications": {
      "tempAlerts": true,
      "cookComplete": true,
      "deviceOffline": true
    },
    "defaultTargetTemps": {
      "brisket": { "grill": 225, "meat": 203 },
      "pork": { "grill": 225, "meat": 195 },
      "chicken": { "grill": 325, "meat": 165 }
    }
  },
  "devices": ["meatgeek3"],
  "createdAt": "2025-01-15T10:00:00Z",
  "lastLogin": "2025-01-26T08:00:00Z"
}
```

#### Collection: `recipes`

**Partition Key**: `/userId`

```json
{
  "id": "recipe-789",
  "userId": "user123",
  "name": "Texas Style Brisket",
  "meatType": "brisket",
  "description": "Low and slow brisket with coffee rub",
  "estimatedDuration": 14.0,
  "temperatures": {
    "grill": 225,
    "targetMeat": 203
  },
  "phases": [
    {
      "name": "Initial Smoke",
      "duration": 6.0,
      "grillTemp": 225,
      "notes": "Heavy smoke for first 6 hours"
    },
    {
      "name": "Wrap",
      "targetMeatTemp": 165,
      "notes": "Wrap in butcher paper"
    },
    {
      "name": "Final Cook",
      "targetMeatTemp": 203,
      "notes": "Cook until probe tender"
    }
  ],
  "isPublic": true,
  "rating": 4.8,
  "cookCount": 15
}
```

### 4. Azure Functions API

#### NX Integration

The Azure Functions API is built as the `api` app within the NX monorepo, leveraging shared libraries for consistency and type safety across the entire system.

**Shared Library Dependencies:**

- `@meatgeekv2/api-interfaces` - TypeScript types and interfaces (generated from OpenAPI specs)
- `@meatgeekv2/api-specs` - OpenAPI 3.0 specifications and validation middleware
- `@meatgeekv2/data-models` - Business logic and validation
- `@meatgeekv2/azure-client` - CosmosDB and Azure service clients
- `@meatgeekv2/utils` - Common utilities and helpers

#### Function App Structure (apps/api)

```
apps/api/
├── src/
│   ├── functions/
│   │   ├── auth/
│   │   │   ├── login.ts
│   │   │   ├── register.ts
│   │   │   └── refresh.ts
│   │   ├── cooks/
│   │   │   ├── start-cook.ts
│   │   │   ├── stop-cook.ts
│   │   │   ├── get-cook.ts
│   │   │   ├── update-cook.ts
│   │   │   ├── list-cooks.ts
│   │   │   └── delete-cook.ts
│   │   ├── temperatures/
│   │   │   ├── get-current.ts
│   │   │   ├── get-history.ts
│   │   │   └── get-realtime.ts
│   │   ├── devices/
│   │   │   ├── register-device.ts
│   │   │   ├── get-devices.ts
│   │   │   └── update-device.ts
│   │   ├── recipes/
│   │   │   ├── create-recipe.ts
│   │   │   ├── get-recipes.ts
│   │   │   └── update-recipe.ts
│   │   └── telemetry/
│   │       ├── process-temperature.ts
│   │       └── process-status.ts
│   ├── shared/
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── cors.ts
│   │   │   ├── validation.ts
│   │   │   ├── openapi-validation.ts        # OpenAPI request/response validation
│   │   │   ├── error-handling.ts            # Standardized error handling
│   │   │   ├── rate-limiting.ts             # API rate limiting
│   │   │   └── request-logging.ts           # Structured request logging
│   │   ├── services/
│   │   │   ├── cosmos-service.ts
│   │   │   ├── iot-service.ts
│   │   │   └── signalr-service.ts
│   │   └── utils/
│   │       ├── response-builder.ts
│   │       └── error-handler.ts
│   └── main.ts
├── host.json
├── local.settings.json
├── function.json (per function)
└── project.json
```

**OpenAPI-Driven Azure Functions with Comprehensive Integration:**

_OpenAPI Validation Middleware_ (`apps/api/src/shared/middleware/openapi-validation.ts`):

```typescript
import { HttpRequest, Context } from '@azure/functions';
import { OpenAPIValidator } from '@meatgeekv2/api-specs';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CorrelationHelper } from '@meatgeekv2/tracing';

export class OpenAPIMiddleware {
  private static validator = new OpenAPIValidator();

  static async validateAndExecute<TRequest, TResponse>(
    context: Context,
    req: HttpRequest,
    config: {
      method: string;
      path: string;
      successStatusCode: number;
      operationId: string;
    },
    handler: (validatedRequest: TRequest, context: Context) => Promise<TResponse>
  ): Promise<any> {
    const span = trace.getActiveSpan();
    const correlationId = CorrelationHelper.getOrCreateCorrelationId(req);

    span?.setAttributes({
      'http.method': config.method,
      'http.route': config.path,
      'meatgeek.operation_id': config.operationId,
      'meatgeek.correlation_id': correlationId,
    });

    try {
      // Validate incoming request against OpenAPI spec
      const validatedRequest = await this.validator.validateRequest(
        config.method,
        config.path,
        req.body,
        req.query,
        req.params
      );

      context.log.info(`✅ Request validation passed for ${config.operationId}`, {
        correlationId,
        operationId: config.operationId,
        requestId: context.invocationId,
      });

      // Execute business logic with validated data
      const response = await handler(validatedRequest as TRequest, context);

      // Validate outgoing response against OpenAPI spec
      const validatedResponse = await this.validator.validateResponse(
        config.method,
        config.path,
        config.successStatusCode,
        response
      );

      span?.setStatus({ code: SpanStatusCode.OK });

      return {
        status: config.successStatusCode,
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': correlationId,
          'X-Response-Time': Date.now() - req.startTime,
        },
        body: validatedResponse,
      };
    } catch (error) {
      span?.recordException(error as Error);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });

      context.log.error(`❌ OpenAPI validation failed for ${config.operationId}`, {
        error: (error as Error).message,
        correlationId,
        operationId: config.operationId,
        requestId: context.invocationId,
      });

      return {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': correlationId,
        },
        body: {
          error: 'VALIDATION_ERROR',
          message: (error as Error).message,
          operationId: config.operationId,
          traceId: span?.spanContext().traceId,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }
}
```

_Contract-First Azure Function Example_ (`apps/api/src/functions/cooks/start-cook.ts`):

```typescript
import { AzureFunction, Context, HttpRequest } from '@azure/functions';
import { StartCookRequest, Cook } from '@meatgeekv2/api-interfaces';
import { CookManager } from '@meatgeekv2/data-models';
import { CosmosClient } from '@meatgeekv2/azure-client';
import { OpenAPIMiddleware } from '../../shared/middleware/openapi-validation';
import { SignalRService } from '../../shared/services/signalr-service';
import { trace } from '@opentelemetry/api';

// Business logic handler - pure function that operates on validated data
async function startCookHandler(request: StartCookRequest, context: Context): Promise<Cook> {
  const span = trace.getActiveSpan();

  try {
    const cookManager = new CookManager(new CosmosClient());
    const signalRService = new SignalRService();

    // Create the cook with validated data
    const newCook = await cookManager.startCook(request);

    // Notify connected clients via SignalR
    await signalRService.sendToGroup(`device-${request.deviceId}`, 'CookStarted', {
      cookId: newCook.id,
      deviceId: request.deviceId,
      startTime: newCook.startTime,
    });

    span?.setAttributes({
      'meatgeek.cook_id': newCook.id,
      'meatgeek.device_id': request.deviceId,
      'meatgeek.meat_type': request.meatType,
    });

    context.log.info('Cook started successfully', {
      cookId: newCook.id,
      deviceId: request.deviceId,
      meatType: request.meatType,
    });

    return newCook;
  } catch (error) {
    context.log.error('Failed to start cook', {
      error: (error as Error).message,
      deviceId: request.deviceId,
    });
    throw error;
  }
}

// Azure Function entry point with OpenAPI integration
const httpTrigger: AzureFunction = async (context: Context, req: HttpRequest) => {
  return await OpenAPIMiddleware.validateAndExecute<StartCookRequest, Cook>(
    context,
    req,
    {
      method: 'POST',
      path: '/cooks',
      successStatusCode: 201,
      operationId: 'startCook',
    },
    startCookHandler
  );
};

export default httpTrigger;
```

_Function Configuration with OpenAPI Metadata_ (`apps/api/src/functions/cooks/start-cook/function.json`):

```json
{
  "bindings": [
    {
      "authLevel": "anonymous",
      "type": "httpTrigger",
      "direction": "in",
      "name": "req",
      "methods": ["post"],
      "route": "cooks"
    },
    {
      "type": "http",
      "direction": "out",
      "name": "res"
    }
  ],
  "extensions": {
    "openapi": {
      "operationId": "startCook",
      "summary": "Start a new cooking session",
      "tags": ["Cooks"],
      "specificationPath": "../../../../../../libs/api-specs/specs/paths/cooks.yaml#/cooks/post"
    }
  }
}
```

_Advanced Query Function with Filtering_ (`apps/api/src/functions/cooks/list-cooks.ts`):

```typescript
import { AzureFunction, Context, HttpRequest } from '@azure/functions';
import { ListCooksRequest, CookListResponse } from '@meatgeekv2/api-interfaces';
import { CookManager, QueryBuilder } from '@meatgeekv2/data-models';
import { CosmosClient } from '@meatgeekv2/azure-client';
import { OpenAPIMiddleware } from '../../shared/middleware/openapi-validation';
import { trace } from '@opentelemetry/api';

async function listCooksHandler(
  request: ListCooksRequest,
  context: Context
): Promise<CookListResponse> {
  const span = trace.getActiveSpan();

  try {
    const cookManager = new CookManager(new CosmosClient());

    // Build query from validated request parameters
    const query = new QueryBuilder()
      .forUser(request.userId)
      .withStatus(request.status)
      .withMeatType(request.meatType)
      .withDateRange(request.startDate, request.endDate)
      .orderBy(request.sortBy || 'startTime', request.sortOrder || 'desc')
      .paginate(request.offset || 0, request.limit || 20)
      .build();

    const { cooks, total } = await cookManager.listCooks(query);

    span?.setAttributes({
      'meatgeek.query.status': request.status || 'all',
      'meatgeek.query.meat_type': request.meatType || 'all',
      'meatgeek.results.count': cooks.length,
      'meatgeek.results.total': total,
    });

    return {
      cooks,
      total,
      offset: request.offset || 0,
      limit: request.limit || 20,
      hasMore: (request.offset || 0) + cooks.length < total,
    };
  } catch (error) {
    context.log.error('Failed to list cooks', {
      error: (error as Error).message,
      userId: request.userId,
    });
    throw error;
  }
}

const httpTrigger: AzureFunction = async (context: Context, req: HttpRequest) => {
  // Extract query parameters and convert to typed request
  const queryRequest: ListCooksRequest = {
    userId: req.query.userId || req.headers['x-user-id'],
    status: req.query.status,
    meatType: req.query.meatType,
    sortBy: req.query.sortBy,
    sortOrder: req.query.sortOrder as 'asc' | 'desc',
    limit: req.query.limit ? parseInt(req.query.limit) : undefined,
    offset: req.query.offset ? parseInt(req.query.offset) : undefined,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  };

  return await OpenAPIMiddleware.validateAndExecute<ListCooksRequest, CookListResponse>(
    context,
    { ...req, body: queryRequest },
    {
      method: 'GET',
      path: '/cooks',
      successStatusCode: 200,
      operationId: 'listCooks',
    },
    listCooksHandler
  );
};

export default httpTrigger;
```

_API Documentation Generation from Functions_ (`apps/api/tools/generate-openapi-docs.js`):

```javascript
const fs = require('fs');
const path = require('path');
const glob = require('glob');

class FunctionDocsGenerator {
  async generateOpenAPIFromFunctions() {
    const functionPaths = glob.sync('./src/functions/**/function.json');
    const openAPIOperations = {};

    for (const functionPath of functionPaths) {
      const functionConfig = JSON.parse(fs.readFileSync(functionPath, 'utf8'));

      if (functionConfig.extensions?.openapi) {
        const httpBinding = functionConfig.bindings.find(b => b.type === 'httpTrigger');
        const route = httpBinding.route || 'api/' + path.dirname(functionPath).split('/').pop();
        const method = httpBinding.methods[0].toLowerCase();

        openAPIOperations[`${method.toUpperCase()} /${route}`] = {
          operationId: functionConfig.extensions.openapi.operationId,
          summary: functionConfig.extensions.openapi.summary,
          tags: functionConfig.extensions.openapi.tags,
          specRef: functionConfig.extensions.openapi.specificationPath,
        };
      }
    }

    console.log('🔍 Found OpenAPI operations in Azure Functions:');
    Object.entries(openAPIOperations).forEach(([endpoint, config]) => {
      console.log(`  ${endpoint} -> ${config.operationId}`);
    });

    // Generate summary document
    const summary = {
      generatedAt: new Date().toISOString(),
      totalOperations: Object.keys(openAPIOperations).length,
      operations: openAPIOperations,
    };

    fs.writeFileSync('./generated/function-openapi-mapping.json', JSON.stringify(summary, null, 2));
  }
}

if (require.main === module) {
  new FunctionDocsGenerator().generateOpenAPIFromFunctions();
}
```

````

**OpenAPI Validation Middleware** (`libs/api-specs/src/lib/validation.ts`):
```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { OpenAPIV3 } from 'openapi-types';
import { loadOpenAPISpec } from './spec-loader';

export class OpenAPIValidator {
  private ajv: Ajv;
  private spec: OpenAPIV3.Document;

  constructor() {
    this.ajv = new Ajv({ allErrors: true });
    addFormats(this.ajv);
    this.spec = loadOpenAPISpec();
  }

  async validateRequest(method: string, path: string, body: any): Promise<any> {
    const operation = this.getOperation(method, path);
    if (!operation?.requestBody) return body;

    const schema = this.resolveSchema(operation.requestBody);
    const valid = this.ajv.validate(schema, body);

    if (!valid) {
      throw new Error(`Request validation failed: ${this.ajv.errorsText()}`);
    }

    return body;
  }

  async validateResponse(method: string, path: string, statusCode: number, response: any): Promise<any> {
    const operation = this.getOperation(method, path);
    const responseSpec = operation?.responses?.[statusCode];

    if (!responseSpec) return response;

    const schema = this.resolveSchema(responseSpec);
    const valid = this.ajv.validate(schema, response);

    if (!valid) {
      throw new Error(`Response validation failed: ${this.ajv.errorsText()}`);
    }

    return response;
  }

  private getOperation(method: string, path: string): OpenAPIV3.OperationObject | undefined {
    return this.spec.paths?.[path]?.[method.toLowerCase()];
  }

  private resolveSchema(schemaRef: any): any {
    // Implementation to resolve $ref schemas
    // Returns the actual JSON schema for validation
  }
}

export const openAPIValidator = new OpenAPIValidator();
````

**API Documentation and Tooling**:

_Swagger UI Integration_ (`libs/api-specs/tools/serve-docs.js`):

```javascript
// Generate interactive API documentation
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const express = require('express');

const app = express();
const swaggerSpec = YAML.load('./specs/meatgeek-api.yaml');

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'MeatGeek V2 API Documentation',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
    },
  })
);

app.listen(3001, () => {
  console.log('📚 API Documentation available at http://localhost:3001/api-docs');
});
```

_Client SDK Generation_ (`libs/api-specs/tools/generate-clients.js`):

```javascript
// Auto-generate TypeScript client SDK
const { generateApi } = require('swagger-typescript-api');
const path = require('path');

generateApi({
  name: 'meatgeek-client.ts',
  url: 'http://localhost:3001/api-docs/swagger.json',
  output: path.resolve('./src/generated'),
  httpClientType: 'axios',
  generateResponses: true,
  generateRouteTypes: false,
  generateClient: true,
  modular: false,
  extractRequestParams: true,
  extractRequestBody: true,
  extractEnums: true,
}).then(({ files }) => {
  console.log('✅ Generated API client SDK');
  files.forEach(file => console.log(`   - ${file.name}`));
});
```

#### OpenAPI 3.0 Specifications

**Contract-First Development**:
All APIs are defined using OpenAPI 3.0 specifications before implementation, ensuring consistency, type safety, and excellent developer experience. The `@meatgeekv2/api-specs` library manages all API specifications and generates TypeScript types, client SDKs, and documentation.

**Main OpenAPI Specification** (`libs/api-specs/specs/meatgeek-api.yaml`):

```yaml
openapi: 3.0.3
info:
  title: MeatGeek V2 API
  description: BBQ temperature monitoring and cook management API
  version: 1.0.0
  contact:
    name: MeatGeek Support
    url: https://github.com/stevebargelt/meatgeekv2
  license:
    name: MIT

servers:
  - url: https://api.meatgeek.com/v1
    description: Production server
  - url: https://dev-api.meatgeek.com/v1
    description: Development server

security:
  - bearerAuth: []

paths:
  # Cook Management
  /cooks:
    $ref: './paths/cooks.yaml#/cooks'
  /cooks/{cookId}:
    $ref: './paths/cooks.yaml#/cook-by-id'
  /cooks/{cookId}/stop:
    $ref: './paths/cooks.yaml#/stop-cook'

  # Temperature Data
  /temperatures/current/{deviceId}:
    $ref: './paths/temperatures.yaml#/current-temperatures'
  /temperatures/history/{cookId}:
    $ref: './paths/temperatures.yaml#/temperature-history'

  # Device Management
  /devices:
    $ref: './paths/devices.yaml#/devices'
  /devices/{deviceId}:
    $ref: './paths/devices.yaml#/device-by-id'

  # Recipe Management
  /recipes:
    $ref: './paths/recipes.yaml#/recipes'
  /recipes/{recipeId}:
    $ref: './paths/recipes.yaml#/recipe-by-id'

components:
  $ref: './components/schemas.yaml'

webhooks:
  temperatureAlert:
    $ref: './webhooks/temperature-alerts.yaml#/temperatureAlert'
  cookCompleted:
    $ref: './webhooks/cook-completed.yaml#/cookCompleted'
```

**Cook Management Schema Example** (`libs/api-specs/specs/components/schemas.yaml`):

```yaml
Cook:
  type: object
  required:
    - id
    - userId
    - deviceId
    - name
    - status
    - startTime
  properties:
    id:
      type: string
      format: uuid
      example: '550e8400-e29b-41d4-a716-446655440000'
    userId:
      type: string
      format: uuid
    deviceId:
      type: string
      example: 'meatgeek3'
    name:
      type: string
      minLength: 1
      maxLength: 100
      example: 'Weekend Brisket'
    meatType:
      type: string
      enum: [beef, pork, chicken, fish, vegetarian, other]
      example: 'beef'
    weight:
      type: number
      minimum: 0.1
      maximum: 50.0
      example: 12.5
    status:
      type: string
      enum: [planning, active, paused, completed, cancelled]
      example: 'active'
    startTime:
      type: string
      format: date-time
      example: '2025-01-26T06:00:00Z'
    endTime:
      type: string
      format: date-time
      nullable: true
    targetTemps:
      $ref: '#/TargetTemperatures'
    actualDuration:
      type: number
      minimum: 0
      description: 'Duration in hours'
    notes:
      type: string
      maxLength: 1000
    rating:
      type: integer
      minimum: 1
      maximum: 5
      nullable: true

StartCookRequest:
  type: object
  required:
    - deviceId
    - name
    - meatType
  properties:
    deviceId:
      type: string
    name:
      type: string
    meatType:
      $ref: '#/Cook/properties/meatType'
    weight:
      type: number
      minimum: 0.1
    targetTemps:
      $ref: '#/TargetTemperatures'
    notes:
      type: string
```

**API Endpoints with Full Specifications**:

_Cook Management_ (`libs/api-specs/specs/paths/cooks.yaml`):

```yaml
cooks:
  get:
    summary: List user's cooks
    tags: [Cooks]
    parameters:
      - name: status
        in: query
        schema:
          type: string
          enum: [planning, active, paused, completed, cancelled]
      - name: limit
        in: query
        schema:
          type: integer
          minimum: 1
          maximum: 100
          default: 20
      - name: offset
        in: query
        schema:
          type: integer
          minimum: 0
          default: 0
    responses:
      '200':
        description: List of cooks
        content:
          application/json:
            schema:
              type: object
              properties:
                cooks:
                  type: array
                  items:
                    $ref: '../components/schemas.yaml#/Cook'
                total:
                  type: integer
                  example: 45
      '401':
        $ref: '../components/responses.yaml#/Unauthorized'

  post:
    summary: Start a new cook
    tags: [Cooks]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '../components/schemas.yaml#/StartCookRequest'
    responses:
      '201':
        description: Cook started successfully
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Cook'
      '400':
        $ref: '../components/responses.yaml#/BadRequest'
      '401':
        $ref: '../components/responses.yaml#/Unauthorized'

cook-by-id:
  get:
    summary: Get cook details
    tags: [Cooks]
    parameters:
      - name: cookId
        in: path
        required: true
        schema:
          type: string
          format: uuid
    responses:
      '200':
        description: Cook details
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Cook'
      '404':
        $ref: '../components/responses.yaml#/NotFound'
```

**Generated TypeScript Types**:
The OpenAPI specifications automatically generate TypeScript types used across the entire system:

```typescript
// Generated from OpenAPI specs in @meatgeekv2/api-specs
export interface Cook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  meatType: 'beef' | 'pork' | 'chicken' | 'fish' | 'vegetarian' | 'other';
  weight?: number;
  status: 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';
  startTime: string;
  endTime?: string;
  targetTemps?: TargetTemperatures;
  actualDuration?: number;
  notes?: string;
  rating?: number;
}

export interface StartCookRequest {
  deviceId: string;
  name: string;
  meatType: Cook['meatType'];
  weight?: number;
  targetTemps?: TargetTemperatures;
  notes?: string;
}
```

**Temperature Data Endpoints** (`libs/api-specs/specs/paths/temperatures.yaml`):

```yaml
current-temperatures:
  get:
    summary: Get current temperature readings for a device
    tags: [Temperatures]
    parameters:
      - name: deviceId
        in: path
        required: true
        schema:
          type: string
    responses:
      '200':
        description: Current temperature readings
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/TemperatureReading'
      '404':
        description: Device not found
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/ErrorResponse'

temperature-history:
  get:
    summary: Get temperature history for a cook
    tags: [Temperatures]
    parameters:
      - name: cookId
        in: path
        required: true
        schema:
          type: string
          format: uuid
      - name: startTime
        in: query
        schema:
          type: string
          format: date-time
      - name: endTime
        in: query
        schema:
          type: string
          format: date-time
      - name: interval
        in: query
        schema:
          type: string
          enum: [1m, 5m, 15m, 1h]
          default: 5m
    responses:
      '200':
        description: Temperature history data
        content:
          application/json:
            schema:
              type: object
              properties:
                readings:
                  type: array
                  items:
                    $ref: '../components/schemas.yaml#/TemperatureReading'
                aggregation:
                  type: string
                  enum: [raw, averaged]
                interval:
                  type: string
```

**Device Management Endpoints** (`libs/api-specs/specs/paths/devices.yaml`):

```yaml
devices:
  get:
    summary: List user's devices
    tags: [Devices]
    parameters:
      - name: status
        in: query
        schema:
          type: string
          enum: [online, offline, unknown]
    responses:
      '200':
        description: List of devices
        content:
          application/json:
            schema:
              type: object
              properties:
                devices:
                  type: array
                  items:
                    $ref: '../components/schemas.yaml#/Device'

  post:
    summary: Register a new device
    tags: [Devices]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '../components/schemas.yaml#/RegisterDeviceRequest'
    responses:
      '201':
        description: Device registered successfully
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Device'
      '400':
        description: Invalid device registration data
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/ErrorResponse'

device-by-id:
  get:
    summary: Get device details
    tags: [Devices]
    parameters:
      - name: deviceId
        in: path
        required: true
        schema:
          type: string
    responses:
      '200':
        description: Device details
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Device'
      '404':
        description: Device not found

  put:
    summary: Update device configuration
    tags: [Devices]
    parameters:
      - name: deviceId
        in: path
        required: true
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '../components/schemas.yaml#/UpdateDeviceRequest'
    responses:
      '200':
        description: Device updated successfully
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Device'
```

**Recipe Management Endpoints** (`libs/api-specs/specs/paths/recipes.yaml`):

```yaml
recipes:
  get:
    summary: List user's recipes
    tags: [Recipes]
    parameters:
      - name: meatType
        in: query
        schema:
          type: string
          enum: [beef, pork, chicken, fish, vegetarian, other]
      - name: cookMethod
        in: query
        schema:
          type: string
          enum: [smoke, grill, roast, braise]
      - name: search
        in: query
        schema:
          type: string
          description: Search in recipe name and description
    responses:
      '200':
        description: List of recipes
        content:
          application/json:
            schema:
              type: object
              properties:
                recipes:
                  type: array
                  items:
                    $ref: '../components/schemas.yaml#/Recipe'

  post:
    summary: Create a new recipe
    tags: [Recipes]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: '../components/schemas.yaml#/CreateRecipeRequest'
    responses:
      '201':
        description: Recipe created successfully
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Recipe'

recipe-by-id:
  get:
    summary: Get recipe details
    tags: [Recipes]
    parameters:
      - name: recipeId
        in: path
        required: true
        schema:
          type: string
          format: uuid
    responses:
      '200':
        description: Recipe details
        content:
          application/json:
            schema:
              $ref: '../components/schemas.yaml#/Recipe'
      '404':
        description: Recipe not found
```

**Additional Schema Components** (`libs/api-specs/specs/components/schemas.yaml`):

```yaml
TemperatureReading:
  type: object
  required:
    - deviceId
    - timestamp
    - grillTemp
  properties:
    deviceId:
      type: string
      example: 'meatgeek3'
    timestamp:
      type: string
      format: date-time
    grillTemp:
      type: number
      nullable: true
      example: 225.0
    probe1Temp:
      type: number
      nullable: true
      example: 160.0
    probe2Temp:
      type: number
      nullable: true
      example: 145.0
    probe3Temp:
      type: number
      nullable: true
    probe4Temp:
      type: number
      nullable: true
      example: 200.0
    cookId:
      type: string
      format: uuid
      nullable: true
      description: 'Associated cook ID if device is actively cooking'

Device:
  type: object
  required:
    - id
    - userId
    - name
    - status
    - lastSeen
  properties:
    id:
      type: string
      example: 'meatgeek3'
    userId:
      type: string
      format: uuid
    name:
      type: string
      example: 'Main Smoker'
    status:
      type: string
      enum: [online, offline, unknown]
      example: 'online'
    lastSeen:
      type: string
      format: date-time
    firmware:
      type: string
      example: '1.2.5'
    location:
      type: string
      example: 'Backyard Deck'
    probeCount:
      type: integer
      minimum: 1
      maximum: 8
      example: 4

Recipe:
  type: object
  required:
    - id
    - userId
    - name
    - meatType
    - targetTemps
  properties:
    id:
      type: string
      format: uuid
    userId:
      type: string
      format: uuid
    name:
      type: string
      example: 'Perfect Brisket'
    description:
      type: string
      example: 'Low and slow Texas-style brisket'
    meatType:
      type: string
      enum: [beef, pork, chicken, fish, vegetarian, other]
    cookMethod:
      type: string
      enum: [smoke, grill, roast, braise]
    targetTemps:
      $ref: '#/TargetTemperatures'
    estimatedDuration:
      type: number
      description: 'Estimated cook time in hours'
      example: 12.0
    instructions:
      type: array
      items:
        type: string
    tags:
      type: array
      items:
        type: string
      example: ['bbq', 'beef', 'competition']
    isPublic:
      type: boolean
      default: false
    createdAt:
      type: string
      format: date-time
    updatedAt:
      type: string
      format: date-time

TargetTemperatures:
  type: object
  properties:
    grill:
      type: number
      minimum: 100
      maximum: 500
      example: 225
    probe1:
      type: number
      minimum: 80
      maximum: 220
      example: 203
      description: 'Internal temperature target'
    probe2:
      type: number
      minimum: 80
      maximum: 220
      nullable: true
    probe3:
      type: number
      minimum: 80
      maximum: 220
      nullable: true
    probe4:
      type: number
      minimum: 80
      maximum: 220
      nullable: true

ErrorResponse:
  type: object
  required:
    - error
    - message
  properties:
    error:
      type: string
      example: 'VALIDATION_ERROR'
    message:
      type: string
      example: 'Invalid temperature value'
    details:
      type: object
      additionalProperties: true
    traceId:
      type: string
      example: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    timestamp:
      type: string
      format: date-time
```

**OpenAPI Tooling and Development Commands**:

```bash
# NX commands for API specification development
nx run api-specs:validate-specs          # Validate all OpenAPI specs
nx run api-specs:generate-types          # Generate TypeScript interfaces
nx run api-specs:generate-client-sdk     # Generate API client SDK
nx run api-specs:serve-docs              # Serve Swagger UI documentation
nx run api-specs:bundle-specs            # Bundle specifications into single file
nx run api-specs:mock-server             # Start mock API server for development

# Generate API clients for different platforms
nx run api-specs:generate-react-query    # Generate React Query hooks
nx run api-specs:generate-axios-client   # Generate Axios-based client
nx run api-specs:generate-fetch-client   # Generate fetch-based client
```

**Runtime Validation Integration**:
The Azure Functions API uses the generated schemas for runtime request/response validation:

```typescript
// apps/api/src/functions/cooks/create-cook.ts
import { createAzureFunction } from '@azure/functions';
import { OpenAPIValidator } from '@meatgeekv2/api-specs';
import { CreateCookRequest } from '@meatgeekv2/api-interfaces';

const validator = new OpenAPIValidator();

export const createCook = createAzureFunction({
  methods: ['POST'],
  route: 'cooks',
  handler: async (request, context) => {
    const span = trace.getActiveSpan();
    span?.setAttributes({
      'meatgeek.function': 'create-cook',
      'http.method': 'POST',
    });

    try {
      // Validate request against OpenAPI schema
      const body = await validator.validateRequest('POST', '/cooks', await request.json());

      // Process the validated request
      const cook = await cookService.createCook(body as CreateCookRequest);

      // Validate response against schema
      const validatedResponse = await validator.validateResponse('POST', '/cooks', 201, cook);

      return {
        status: 201,
        jsonBody: validatedResponse,
      };
    } catch (error) {
      span?.recordException(error);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      return {
        status: 400,
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: error.message,
          traceId: span?.spanContext().traceId,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
});
```

**NX Project Configuration for API Specifications** (`libs/api-specs/project.json`):

```json
{
  "name": "api-specs",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/api-specs/src",
  "projectType": "library",
  "tags": ["scope:shared", "type:lib"],
  "targets": {
    "validate-specs": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/validate-specs.js",
        "cwd": "libs/api-specs"
      }
    },
    "generate-types": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/generate-types.js",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/types"]
    },
    "generate-client-sdk": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/generate-clients.js",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/clients"]
    },
    "generate-react-query": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/generate-clients.js --type=react-query",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/clients/react-query"]
    },
    "generate-axios-client": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/generate-clients.js --type=axios",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/clients/axios"]
    },
    "generate-fetch-client": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/generate-clients.js --type=fetch",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/clients/fetch"]
    },
    "serve-docs": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/serve-docs.js",
        "cwd": "libs/api-specs"
      }
    },
    "bundle-specs": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/bundle-specs.js",
        "cwd": "libs/api-specs"
      },
      "outputs": ["{projectRoot}/generated/bundled"]
    },
    "mock-server": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/mock-server.js",
        "cwd": "libs/api-specs"
      }
    },
    "watch": {
      "executor": "nx:run-commands",
      "options": {
        "command": "node tools/watch-and-rebuild.js",
        "cwd": "libs/api-specs"
      }
    },
    "build": {
      "executor": "@nx/js:tsc",
      "outputs": ["{options.outputPath}"],
      "options": {
        "outputPath": "dist/libs/api-specs",
        "main": "libs/api-specs/src/index.ts",
        "tsConfig": "libs/api-specs/tsconfig.lib.json"
      }
    },
    "test": {
      "executor": "@nx/jest:jest",
      "outputs": ["{workspaceRoot}/coverage/{projectRoot}"],
      "options": {
        "jestConfig": "libs/api-specs/jest.config.ts"
      }
    },
    "lint": {
      "executor": "@nx/linter:eslint",
      "outputs": ["{options.outputFile}"],
      "options": {
        "lintFilePatterns": ["libs/api-specs/**/*.{ts,tsx,js,jsx}"]
      }
    }
  }
}
```

**Advanced Tooling Scripts**:

_Mock Server with Data Generation_ (`libs/api-specs/tools/mock-server.js`):

```javascript
const express = require('express');
const { MockServerGenerator } = require('swagger-mock-validator');
const { faker } = require('@faker-js/faker');
const YAML = require('yamljs');

class MeatGeekMockServer {
  constructor() {
    this.app = express();
    this.spec = YAML.load('./specs/meatgeek-api.yaml');
    this.setupMiddleware();
    this.generateMockData();
  }

  generateMockData() {
    // Generate realistic BBQ temperature data
    this.mockCooks = Array.from({ length: 10 }, () => ({
      id: faker.string.uuid(),
      name: faker.helpers.arrayElement([
        'Weekend Brisket',
        'Perfect Ribs',
        'Smoked Chicken',
        'Competition Pork Butt',
        'Holiday Turkey',
      ]),
      meatType: faker.helpers.arrayElement(['beef', 'pork', 'chicken']),
      status: faker.helpers.arrayElement(['planning', 'active', 'completed']),
      startTime: faker.date.recent({ days: 30 }),
      targetTemps: {
        grill: faker.number.int({ min: 200, max: 275 }),
        probe1: faker.number.int({ min: 190, max: 210 }),
      },
    }));

    this.mockTemperatures = Array.from({ length: 100 }, () => ({
      deviceId: 'meatgeek3',
      timestamp: faker.date.recent(),
      grillTemp: faker.number.float({ min: 220, max: 250, precision: 0.1 }),
      probe1Temp: faker.number.float({ min: 140, max: 203, precision: 0.1 }),
      probe2Temp: faker.helpers.maybe(
        () => faker.number.float({ min: 140, max: 203, precision: 0.1 }),
        { probability: 0.7 }
      ),
    }));
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      // Add realistic response delays for testing
      setTimeout(next, faker.number.int({ min: 50, max: 200 }));
    });

    // Custom mock endpoints with realistic data
    this.app.get('/api/v1/cooks', (req, res) => {
      const { status, limit = 20 } = req.query;
      let filteredCooks = this.mockCooks;

      if (status) {
        filteredCooks = filteredCooks.filter(cook => cook.status === status);
      }

      res.json({
        cooks: filteredCooks.slice(0, parseInt(limit)),
        total: filteredCooks.length,
      });
    });

    this.app.get('/api/v1/temperatures/current/:deviceId', (req, res) => {
      const latest = this.mockTemperatures[this.mockTemperatures.length - 1];
      res.json({ ...latest, deviceId: req.params.deviceId });
    });
  }

  start(port = 3002) {
    this.app.listen(port, () => {
      console.log(`🔥 MeatGeek Mock API Server running on http://localhost:${port}`);
      console.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
      console.log(
        `🎯 Generated ${this.mockCooks.length} mock cooks and ${this.mockTemperatures.length} temperature readings`
      );
    });
  }
}

if (require.main === module) {
  new MeatGeekMockServer().start();
}

module.exports = MeatGeekMockServer;
```

_Specification Bundle Tool_ (`libs/api-specs/tools/bundle-specs.js`):

```javascript
const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');
const $RefParser = require('@apidevtools/json-schema-ref-parser');

class SpecificationBundler {
  async bundleSpecs() {
    try {
      console.log('🔄 Bundling OpenAPI specifications...');

      const mainSpecPath = path.join(__dirname, '../specs/meatgeek-api.yaml');
      const bundledSpec = await $RefParser.bundle(mainSpecPath);

      // Output bundled specification in multiple formats
      const outputDir = path.join(__dirname, '../generated/bundled');
      fs.mkdirSync(outputDir, { recursive: true });

      // YAML format
      const yamlContent = YAML.stringify(bundledSpec, 4);
      fs.writeFileSync(path.join(outputDir, 'meatgeek-api.bundled.yaml'), yamlContent);

      // JSON format
      fs.writeFileSync(
        path.join(outputDir, 'meatgeek-api.bundled.json'),
        JSON.stringify(bundledSpec, null, 2)
      );

      console.log('✅ Specifications bundled successfully');
      console.log(`📁 Output: ${outputDir}`);

      // Generate bundle statistics
      const stats = this.generateBundleStats(bundledSpec);
      fs.writeFileSync(path.join(outputDir, 'bundle-stats.json'), JSON.stringify(stats, null, 2));

      return bundledSpec;
    } catch (error) {
      console.error('❌ Bundle failed:', error.message);
      process.exit(1);
    }
  }

  generateBundleStats(spec) {
    const pathCount = Object.keys(spec.paths || {}).length;
    const schemaCount = Object.keys(spec.components?.schemas || {}).length;
    const operationCount = Object.values(spec.paths || {}).reduce((count, pathItem) => {
      return (
        count +
        Object.keys(pathItem).filter(key => ['get', 'post', 'put', 'delete', 'patch'].includes(key))
          .length
      );
    }, 0);

    return {
      version: spec.info.version,
      title: spec.info.title,
      paths: pathCount,
      operations: operationCount,
      schemas: schemaCount,
      bundledAt: new Date().toISOString(),
    };
  }
}

if (require.main === module) {
  new SpecificationBundler().bundleSpecs();
}

module.exports = SpecificationBundler;
```

_Development Watcher_ (`libs/api-specs/tools/watch-and-rebuild.js`):

```javascript
const chokidar = require('chokidar');
const { execSync } = require('child_process');
const path = require('path');

class SpecificationWatcher {
  constructor() {
    this.isBuilding = false;
    this.buildQueue = new Set();
  }

  watch() {
    console.log('👀 Watching OpenAPI specifications for changes...');

    const watcher = chokidar.watch(['./specs/**/*.yaml', './specs/**/*.yml'], {
      ignoreInitial: false,
      persistent: true,
    });

    watcher
      .on('add', path => this.handleChange('added', path))
      .on('change', path => this.handleChange('changed', path))
      .on('unlink', path => this.handleChange('removed', path));
  }

  async handleChange(event, filePath) {
    console.log(`📝 Specification ${event}: ${filePath}`);

    if (this.isBuilding) {
      this.buildQueue.add(filePath);
      return;
    }

    this.isBuilding = true;

    try {
      // Validate specifications
      console.log('🔍 Validating specifications...');
      execSync('node tools/validate-specs.js', { stdio: 'inherit' });

      // Generate types
      console.log('🏗️ Generating TypeScript types...');
      execSync('node tools/generate-types.js', { stdio: 'inherit' });

      // Generate clients
      console.log('📦 Generating API clients...');
      execSync('node tools/generate-clients.js', { stdio: 'inherit' });

      // Bundle specifications
      console.log('📋 Bundling specifications...');
      execSync('node tools/bundle-specs.js', { stdio: 'inherit' });

      console.log('✅ Rebuild complete!');
    } catch (error) {
      console.error('❌ Rebuild failed:', error.message);
    } finally {
      this.isBuilding = false;

      // Process queued changes
      if (this.buildQueue.size > 0) {
        console.log(`🔄 Processing ${this.buildQueue.size} queued changes...`);
        this.buildQueue.clear();
        setTimeout(() => this.handleChange('queued', 'multiple files'), 1000);
      }
    }
  }
}

if (require.main === module) {
  new SpecificationWatcher().watch();
}

module.exports = SpecificationWatcher;
```

### 5. Real-time Communication

#### SignalR Implementation

**Hubs**:

- `TemperatureHub` - Real-time temperature updates
- `CookHub` - Cook status and notifications
- `DeviceHub` - Device connection status

**Client Methods**:

```typescript
// Temperature updates
connection.on('TemperatureUpdate', (data: TemperatureReading) => {
  updateTemperatureDisplay(data);
});

// Cook notifications
connection.on('CookAlert', (alert: CookAlert) => {
  showNotification(alert);
});

// Device status
connection.on('DeviceStatus', (status: DeviceStatus) => {
  updateDeviceIcon(status);
});
```

### 6. Client Applications

#### Shared Code Architecture

Both mobile and web applications leverage the NX monorepo structure for maximum code reuse and consistency:

**Shared Library Dependencies:**

- `@meatgeekv2/api-interfaces` - TypeScript types and API contracts
- `@meatgeekv2/api-specs` - OpenAPI 3.0 specifications and tooling
- `@meatgeekv2/ui-components` - Cross-platform UI components
- `@meatgeekv2/data-models` - Business logic and validation
- `@meatgeekv2/realtime` - SignalR connection management
- `@meatgeekv2/charts` - Data visualization components
- `@meatgeekv2/tracing` - OpenTelemetry tracing and observability helpers
- `@meatgeekv2/utils` - Common utilities and helpers

#### React Native Mobile App (Primary) - apps/mobile

**Technology Stack**:

- React Native 0.74+
- TypeScript
- React Native Navigation
- React Query for API state
- SignalR for real-time updates
- Shared chart components from `@meatgeekv2/charts`
- Push notifications (Firebase/APNs)

**Key Features**:

- Real-time temperature dashboard using shared components
- Cook session management with shared business logic
- Temperature history charts from shared chart library
- Push notifications for alerts
- Offline support with data sync
- Camera integration for cook photos
- Export cook data (share functionality)

**App Structure (apps/mobile)**:

```
apps/mobile/
├── src/
│   ├── screens/
│   │   ├── auth/
│   │   │   ├── LoginScreen.tsx
│   │   │   ├── RegisterScreen.tsx
│   │   │   └── ForgotPasswordScreen.tsx
│   │   ├── dashboard/
│   │   │   ├── TemperatureOverview.tsx
│   │   │   ├── CurrentCookStatus.tsx
│   │   │   └── QuickActions.tsx
│   │   ├── cooks/
│   │   │   ├── CookListScreen.tsx
│   │   │   ├── CookDetailScreen.tsx
│   │   │   ├── StartCookScreen.tsx
│   │   │   └── CookHistoryScreen.tsx
│   │   ├── charts/
│   │   │   ├── LiveTemperatureScreen.tsx
│   │   │   └── CookHistoryScreen.tsx
│   │   ├── devices/
│   │   │   ├── DeviceListScreen.tsx
│   │   │   └── DeviceSettingsScreen.tsx
│   │   └── profile/
│   │       ├── UserProfileScreen.tsx
│   │       ├── PreferencesScreen.tsx
│   │       └── RecipeManagerScreen.tsx
│   ├── components/
│   │   ├── navigation/
│   │   └── mobile-specific/
│   ├── services/
│   │   ├── api-client.ts
│   │   ├── push-notifications.ts
│   │   └── offline-storage.ts
│   └── App.tsx
├── android/
├── ios/
└── project.json
```

**Example Screen Using Shared Components:**

```typescript
// apps/mobile/src/screens/dashboard/TemperatureOverview.tsx
import React from 'react';
import { View } from 'react-native';
import { TemperatureDisplay, DeviceStatus } from '@meatgeekv2/ui-components';
import { LiveChart } from '@meatgeekv2/charts';
import { useRealtime } from '@meatgeekv2/realtime';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';

export const TemperatureOverview: React.FC = () => {
  const { temperatureData } = useRealtime<TemperatureReading>('temperature');

  return (
    <View>
      <TemperatureDisplay data={temperatureData} />
      <DeviceStatus deviceId="meatgeek3" />
      <LiveChart data={temperatureData} />
    </View>
  );
};
```

#### React Web App (Secondary) - apps/web

**Technology Stack**:

- React 18+
- TypeScript
- Material-UI or Chakra UI
- React Query
- React Router
- Shared chart components from `@meatgeekv2/charts`
- SignalR

**Additional Features**:

- Responsive design for desktop/tablet
- Advanced analytics and reporting
- Bulk data export (CSV, JSON, PDF)
- Recipe sharing community
- Multi-device management dashboard

### 7. Data Processing Pipeline

#### Temperature Data Processing

```
IoT Hub → Event Hub → Azure Function → CosmosDB
                   ↓
            SignalR Hub → Connected Clients
                   ↓
            Alert Processing → Push Notifications
```

#### Cook Analytics

- Temperature trend analysis
- Cooking efficiency metrics
- Predictive cook completion times
- Recipe optimization suggestions
- Comparative cook analysis

### 8. Security Implementation

#### Authentication & Authorization

- Azure AD B2C for user management
- JWT tokens for API authentication
- Device-specific connection strings for IoT Hub
- Role-based access control (RBAC)
- API rate limiting and throttling

#### Data Protection

- TLS 1.3 for all communications
- Data encryption at rest (CosmosDB)
- PII data anonymization for analytics
- GDPR compliance for user data
- Secure device provisioning

### 9. Deployment & Operations

#### Device Deployment (Raspberry Pi)

**Device Controller (apps/device-controller)**:

```bash
# Build for ARM architecture
nx build device-controller --configuration=production

# Deploy to Raspberry Pi
scp dist/apps/device-controller/MeatGeek-DeviceController pi@192.168.1.37:/home/pi/
ssh pi@192.168.1.37 'sudo systemctl restart meatgeek-controller'
```

**Data Pusher (apps/data-pusher)**:

```bash
# Build for ARM architecture
nx build data-pusher --configuration=production

# Deploy alongside device controller
scp dist/apps/data-pusher/meatgeek-pusher pi@192.168.1.37:/home/pi/
ssh pi@192.168.1.37 'sudo systemctl restart meatgeek-pusher'
```

**Systemd Service Configuration**:

```ini
# /etc/systemd/system/meatgeek-controller.service
[Unit]
Description=MeatGeek Device Controller
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/home/pi/MeatGeek-DeviceController
Restart=always

[Install]
WantedBy=multi-user.target

# /etc/systemd/system/meatgeek-pusher.service
[Unit]
Description=MeatGeek Data Pusher
After=network.target meatgeek-controller.service
Requires=meatgeek-controller.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/home/pi/meatgeek-pusher
Restart=always

[Install]
WantedBy=multi-user.target
```

#### Cloud Infrastructure as Code

- Terraform for infrastructure provisioning and management
- Environment-specific configurations using Terraform workspaces
- Automated deployment pipelines with state management
- Blue-green deployment strategy

## Infrastructure as Code with Terraform

### NX Monorepo Structure

The infrastructure is managed as a dedicated NX application within the monorepo:

```
apps/infrastructure/
├── environments/
│   ├── dev.tfvars
│   ├── staging.tfvars
│   └── prod.tfvars
├── modules/
│   ├── iot-hub/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── cosmos-db/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── functions/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── signalr/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── monitoring/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── networking/
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── main.tf
├── variables.tf
├── outputs.tf
├── backend.tf
├── versions.tf
├── project.json
└── README.md
```

### Core Configuration Files

**backend.tf** - Remote State Management:

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

**versions.tf** - Provider Constraints:

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

**main.tf** - Root Module:

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

### Environment Management

**Environment Variables** (dev.tfvars):

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
```

**Production Variables** (prod.tfvars):

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
function_app_service_plan_sku = "EP1"  # Premium plan

# SignalR Configuration
signalr_sku = "Standard_S1"
```

### NX Integration

**project.json** for Infrastructure App:

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
        "command": "terraform plan -var-file=environments/{args.env}.tfvars -out=tfplan",
        "cwd": "apps/infrastructure"
      }
    },
    "apply": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform apply tfplan",
        "cwd": "apps/infrastructure"
      }
    },
    "destroy": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform destroy -var-file=environments/{args.env}.tfvars",
        "cwd": "apps/infrastructure"
      }
    },
    "validate": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform validate",
        "cwd": "apps/infrastructure"
      }
    },
    "format": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform fmt -recursive",
        "cwd": "apps/infrastructure"
      }
    },
    "output": {
      "executor": "nx:run-commands",
      "options": {
        "command": "terraform output",
        "cwd": "apps/infrastructure"
      }
    }
  },
  "tags": ["type:app", "scope:infrastructure", "platform:terraform"]
}
```

### CI/CD Pipeline Integration

**GitHub Actions Workflow** (.github/workflows/infrastructure.yml):

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

### Module Examples

**IoT Hub Module** (modules/iot-hub/main.tf):

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

resource "azurerm_iothub_device" "meatgeek_devices" {
  count               = var.device_count
  name                = "meatgeek${count.index + 1}"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  authentication_type = "sas"
}

# Consumer group for Azure Functions
resource "azurerm_iothub_consumer_group" "functions" {
  name                   = "azure-functions"
  iothub_name            = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name
}
```

This Terraform configuration provides:

- **Modular architecture** with reusable components
- **Environment separation** using workspaces and variable files
- **State management** with Azure Storage backend
- **NX integration** for consistent tooling
- **CI/CD ready** with GitHub Actions support
- **Scalable structure** for adding new Azure resources

#### Monitoring & Observability

**Azure Monitor Platform with OpenTelemetry**:
The complete MeatGeek V2 system uses Azure Monitor as the central observability platform, replacing NewRelic and providing unified monitoring from the Raspberry Pi device to cloud services. OpenTelemetry (OTEL) is used as the standard instrumentation framework to enable end-to-end distributed tracing and observability.

**Distributed Tracing Strategy**:
Every operation in the system generates a unique trace that flows from the device sensor reading through to the mobile app display, enabling complete front-to-back traceability:

```
Temperature Sensor Reading
    ↓ (TraceID: 4f2a8b1c-3d5e-6f7g-8h9i-0j1k2l3m4n5o)
Device Controller (Go + OTEL)
    ↓ (HTTP Headers: traceparent, tracestate)
Data Pusher Service
    ↓ (IoT Hub Message Properties)
Azure IoT Hub
    ↓ (Event Properties)
Azure Functions API
    ↓ (Auto-instrumented)
CosmosDB / SignalR
    ↓ (Real-time Updates)
Mobile/Web Applications
```

**OpenTelemetry Integration**:

- **Device Controller**: OTEL Go SDK generates initial traces for temperature readings
- **Data Pusher**: Propagates trace context via W3C Trace Context headers to IoT Hub
- **Azure Functions**: Native OTEL support with automatic dependency tracking
- **Mobile/Web Apps**: OTEL JavaScript SDK completes client-side tracing
- **Shared Library**: `@meatgeekv2/tracing` provides consistent instrumentation across all TypeScript/JavaScript components

**End-to-End Tracing Implementation**:

_Device Controller (apps/device-controller)_:

```go
// OpenTelemetry + Azure Monitor integration
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
    "github.com/Azure/azure-sdk-for-go/sdk/monitor/azappinsights"
)

var tracer = otel.Tracer("meatgeek.device-controller")

func readTemperatureWithTracing(rtd *RTD) (float64, error) {
    // Start a new trace for temperature reading
    ctx, span := tracer.Start(context.Background(), "temperature.read",
        trace.WithAttributes(
            attribute.String("device.id", "meatgeek3"),
            attribute.String("probe.name", rtd.title),
            attribute.Int("probe.channel", rtd.channel),
        ),
    )
    defer span.End()

    // Read temperature (existing logic)
    temp, err := rtd.ReadTemperature()
    if err != nil {
        span.RecordError(err)
        return 0, err
    }

    // Add temperature to span
    span.SetAttributes(
        attribute.Float64("temperature.value", temp),
        attribute.String("temperature.unit", "fahrenheit"),
    )

    // Track metric with trace context
    otel.GetMeterProvider().Meter("meatgeek").
        Float64ObservableGauge("temperature.reading",
            metric.WithFloat64Callback(func(ctx context.Context, o metric.Float64Observer) error {
                o.Observe(temp, attribute.String("probe", rtd.title))
                return nil
            }))

    return temp, nil
}
```

_Data Pusher Service (apps/data-pusher)_:

```go
func sendToIoTHub(temperatureData TemperatureReading, traceCtx context.Context) error {
    // Extract trace context and propagate to IoT Hub
    span := trace.SpanFromContext(traceCtx)
    traceID := span.SpanContext().TraceID().String()

    message := &iothub.Message{
        Body: json.Marshal(temperatureData),
        Properties: map[string]string{
            "traceparent": fmt.Sprintf("00-%s-%s-01", traceID, span.SpanContext().SpanID().String()),
            "device.id":   temperatureData.DeviceID,
            "cook.id":     temperatureData.CookID,
        },
    }

    return iotClient.SendMessage(message)
}
```

_Azure Functions API (apps/api)_:

**EventData Adapter for Telemetry Processing:**

```typescript
// libs/azure-client/src/event-data-adapter.ts
import { EventData } from '@azure/event-hubs';
import { trace, context as otelContext } from '@opentelemetry/api';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { TracingHelper } from '@meatgeekv2/tracing';

export class EventDataAdapter {
  static extractTemperatureData(eventData: EventData): TemperatureReading {
    const body = eventData.body;
    if (typeof body === 'string') {
      return JSON.parse(body);
    }
    return body as TemperatureReading;
  }

  static extractTraceContext(eventData: EventData): any {
    // Extract traceparent from system properties or application properties
    const traceParent =
      eventData.systemProperties?.['traceparent'] ||
      eventData.properties?.['traceparent'] ||
      eventData.applicationProperties?.['traceparent'];

    return TracingHelper.extractTraceContext(traceParent);
  }

  static getDeviceMetadata(eventData: EventData): { deviceId: string; cookId?: string } {
    return {
      deviceId:
        eventData.systemProperties?.['iothub-connection-device-id'] ||
        eventData.properties?.['device.id'] ||
        eventData.applicationProperties?.['device.id'],
      cookId: eventData.properties?.['cook.id'] || eventData.applicationProperties?.['cook.id'],
    };
  }
}
```

**IoT Hub Telemetry Processing Function:**

```typescript
// apps/api/src/functions/temperatures/process-temperature.ts
import { AzureFunction, Context } from '@azure/functions';
import { EventData } from '@azure/event-hubs';
import { trace } from '@opentelemetry/api';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { EventDataAdapter } from '@meatgeekv2/azure-client';
import { processTemperatureData } from '../shared/business-logic/temperature-processor';

// Event Hub trigger for IoT Hub telemetry (NOT HTTP)
const eventHubTrigger: AzureFunction = async (context: Context, eventHubMessages: EventData[]) => {
  const tracer = trace.getTracer('meatgeek.api.telemetry');

  // Process each message from the Event Hub
  for (const eventData of eventHubMessages) {
    // Extract trace context from EventData properties
    const activeContext = EventDataAdapter.extractTraceContext(eventData);

    await tracer.startActiveSpan('temperature.process', { parent: activeContext }, async span => {
      try {
        // Use adapter to extract typed payload from EventData
        const tempData: TemperatureReading = EventDataAdapter.extractTemperatureData(eventData);
        const deviceMetadata = EventDataAdapter.getDeviceMetadata(eventData);

        // Enrich span with telemetry metadata
        span.setAttributes({
          'device.id': deviceMetadata.deviceId,
          'cook.id': deviceMetadata.cookId || tempData.cookId || 'none',
          'temperature.grill': tempData.grillTemp || 0,
          'message.enqueuedTime': eventData.enqueuedTimeUtc?.toISOString() || '',
          'eventhub.partitionKey': eventData.partitionKey || '',
        });

        // Call shared business logic (used by both telemetry and REST APIs)
        await processTemperatureData(tempData, deviceMetadata, context);

        span.setStatus({ code: SpanStatusCode.OK });
        span.addEvent('temperature.processed');
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        context.log.error('Temperature processing failed:', error);
        // Don't throw - continue processing other messages
      } finally {
        span.end();
      }
    });
  }
};

export default eventHubTrigger;
```

**Shared Business Logic Layer:**

```typescript
// apps/api/src/functions/shared/business-logic/temperature-processor.ts
import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { CosmosClient } from '@meatgeekv2/azure-client';
import { SignalRService } from '../services/signalr-service';
import { Context } from '@azure/functions';

export async function processTemperatureData(
  tempData: TemperatureReading,
  deviceMetadata: { deviceId: string; cookId?: string },
  context: Context
): Promise<void> {
  // Merge device metadata with temperature data
  const enrichedData: TemperatureReading = {
    ...tempData,
    deviceId: deviceMetadata.deviceId,
    cookId: deviceMetadata.cookId || tempData.cookId,
  };

  // Save to CosmosDB
  const cosmosClient = new CosmosClient();
  await cosmosClient.saveTemperatureReading(enrichedData);

  // Send real-time updates via SignalR
  const signalRService = new SignalRService();
  await signalRService.sendToGroup(
    `device-${enrichedData.deviceId}`,
    'TemperatureUpdate',
    enrichedData
  );

  // Send to cook-specific group if active cook
  if (enrichedData.cookId) {
    await signalRService.sendToGroup(
      `cook-${enrichedData.cookId}`,
      'TemperatureUpdate',
      enrichedData
    );
  }

  context.log.info(
    `Temperature processed for device ${enrichedData.deviceId}, cook ${enrichedData.cookId || 'none'}`
  );
}
```

**Function Configuration (function.json):**

```json
{
  "bindings": [
    {
      "type": "eventHubTrigger",
      "name": "eventHubMessages",
      "direction": "in",
      "eventHubName": "iothub-ehub-meatgeek-12345-abcdef",
      "connection": "EventHubConnectionString",
      "cardinality": "many",
      "consumerGroup": "$Default"
    }
  ],
  "scriptFile": "../dist/temperatures/process-temperature.js",
  "entryPoint": "default"
}
```

**Architecture Pattern Summary:**

This corrected implementation shows the proper separation between two distinct data paths in Azure Functions:

1. **REST API Endpoints** (HTTP Triggers):
   - Use `HttpRequest` and `HttpTrigger`
   - Apply OpenAPI validation middleware via `validateAndExecute`
   - Extract traceparent from HTTP headers
   - Examples: `/cooks` (POST), `/cooks/{id}` (GET), `/temperatures/history/{cookId}` (GET)

2. **IoT Hub Telemetry Processing** (Event Hub Triggers):
   - Use `EventData[]` and `eventHubTrigger`
   - Apply EventDataAdapter to extract payload and metadata
   - Extract traceparent from EventData system/application properties
   - Process device telemetry messages from IoT Hub's Event Hub-compatible endpoint

3. **Shared Business Logic**:
   - Both paths call the same `processTemperatureData` function
   - Maintains consistent behavior regardless of entry point
   - Enables code reuse and simplified testing

The key insight is that IoT Hub telemetry arrives as EventData, not HTTP requests, so the middleware patterns differ while maintaining the same observability and business logic.

_Mobile App (apps/mobile)_:

```typescript
// React Native with OTEL
import { trace } from '@opentelemetry/api';
import { useTracing } from '@meatgeekv2/tracing';

export const TemperatureDisplay: React.FC = () => {
  const { temperatureData } = useRealtime<TemperatureReading>('temperature');
  const tracer = useTracing('meatgeek.mobile');

  useEffect(() => {
    // Complete the trace when temperature is displayed
    const span = tracer.startSpan('temperature.display', {
      attributes: {
        'ui.component': 'TemperatureDisplay',
        'device.id': temperatureData?.deviceId,
        'temperature.count': Object.keys(temperatureData || {}).length,
      },
    });

    span.addEvent('temperature.rendered');
    span.end();
  }, [temperatureData]);

  return <TemperatureChart data={temperatureData} />;
};
```

**Log Analytics Workspace**:

- Centralized logging for all system components
- Custom Kusto queries for temperature data analysis
- Correlation of device events with cloud service logs
- Long-term data retention for historical analysis

**Azure Dashboards**:

1. **Real-time System Overview**:
   - Live temperature readings from all devices
   - System health indicators
   - Active cook sessions
   - API response times

2. **Device Health Dashboard**:
   - Device connectivity status
   - Hardware metrics (CPU, memory, disk usage)
   - Network connectivity quality
   - Sensor calibration status

3. **Cook Analytics Dashboard**:
   - Temperature trends over time
   - Cook duration statistics
   - Most popular cook types
   - Temperature accuracy metrics

4. **System Performance Dashboard**:
   - API endpoint performance
   - Database query performance
   - SignalR connection metrics
   - Mobile app crash rates

**Custom Azure Workbooks & Distributed Tracing Analysis**:

_Temperature Trend Analysis:_

```kusto
// Temperature metrics with tracing context
customMetrics
| where name in ("temperature.grill", "temperature.probe1", "temperature.probe2", "temperature.probe3", "temperature.probe4")
| where timestamp > ago(24h)
| summarize avg(value), min(value), max(value) by name, bin(timestamp, 5m)
| render timechart
```

_End-to-End Trace Analysis:_

```kusto
// Find all operations for a specific cook session
let cookId = "cook-abc123";
let timeRange = ago(4h);
union traces, requests, dependencies, customEvents
| where timestamp > timeRange
| where customDimensions["cook.id"] == cookId or
        customDimensions["cook_id"] == cookId or
        tostring(customDimensions.cook_id) == cookId
| project timestamp, operation_Id, name, duration, success, customDimensions
| order by timestamp asc
```

_Temperature Reading Trace Flow:_

```kusto
// Trace a temperature reading from device to display
let traceId = "4f2a8b1c-3d5e-6f7g-8h9i-0j1k2l3m4n5o";
union traces, requests, dependencies
| where operation_Id == traceId
| project
    timestamp,
    name,
    duration,
    success,
    cloud_RoleName,
    customDimensions["device.id"],
    customDimensions["temperature.value"],
    customDimensions["probe.name"]
| order by timestamp asc
```

_Performance Analysis - Slow Temperature Updates:_

```kusto
// Find slow end-to-end temperature processing
traces
| where name == "temperature.read"
| join kind=inner (
    requests
    | where name == "temperature.process"
) on operation_Id
| project
    DeviceReadTime = timestamp,
    APIProcessTime = timestamp1,
    TotalDuration = datetime_diff('millisecond', timestamp1, timestamp),
    DeviceId = tostring(customDimensions["device.id"]),
    Temperature = toreal(customDimensions["temperature.value"])
| where TotalDuration > 5000  // Slower than 5 seconds
| order by TotalDuration desc
```

_Cook Session Tracing Dashboard:_

```kusto
// Complete cook session analysis
let cookId = "cook-abc123";
traces
| where customDimensions["cook.id"] == cookId
| summarize
    TotalOperations = count(),
    AvgTempReadDuration = avg(duration),
    MinTemp = min(toreal(customDimensions["temperature.value"])),
    MaxTemp = max(toreal(customDimensions["temperature.value"])),
    ErrorCount = sumif(1, success == false)
    by bin(timestamp, 10m), tostring(customDimensions["probe.name"])
| render timechart
```

**Correlation ID Strategy**:

To simplify debugging and support tracing, every request includes human-readable correlation IDs alongside OpenTelemetry trace IDs:

_Cook-Based Correlation:_

```
cook-2025-01-26-brisket-abc123
├── temp-reading-probe1-14:30:15-xyz789
├── temp-reading-probe2-14:30:15-def456
├── api-update-14:30:16-ghi789
└── mobile-display-14:30:17-jkl012
```

_Device-Based Correlation:_

```
device-meatgeek3-session-20250126
├── sensor-read-grill-14:30:15
├── sensor-read-probe1-14:30:15
├── iot-message-14:30:16
└── api-process-14:30:17
```

_Implementation in Shared Tracing Library:_

```typescript
// libs/tracing/src/lib/correlation.ts
export class CorrelationHelper {
  static generateCookCorrelationId(cookId: string, operation: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${cookId}-${operation}-${timestamp}`;
  }

  static generateDeviceCorrelationId(deviceId: string, operation: string): string {
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `device-${deviceId}-${operation}-${timestamp}`;
  }

  static extractCookIdFromCorrelation(correlationId: string): string | null {
    const match = correlationId.match(/^cook-.*?-(.+?)-/);
    return match ? match[1] : null;
  }
}
```

_Usage Example:_

```typescript
// In any component
import { CorrelationHelper } from '@meatgeekv2/tracing';

const correlationId = CorrelationHelper.generateCookCorrelationId(
  'cook-abc123',
  'temperature-update'
);
// Results in: "cook-abc123-temperature-update-2025-01-26T14-30-15-123Z"

span.setAttributes({
  'correlation.id': correlationId,
  'correlation.cook_id': 'cook-abc123',
  'correlation.operation': 'temperature-update',
});
```

**Benefits of This Approach**:

- **Human Readable**: Easy to identify related operations in logs
- **Hierarchical**: Shows parent-child relationships
- **Time-Based**: Includes timestamp for chronological ordering
- **Searchable**: Simple text search finds all related operations
- **Standards Compliant**: Works alongside W3C Trace Context

**Proactive Alerting**:

- **Device Connectivity**: Alert when device hasn't reported in > 5 minutes
- **Temperature Anomalies**: Alert on sudden temperature spikes or drops
- **API Performance**: Alert on response times > 2 seconds
- **Database Issues**: Alert on CosmosDB throttling or errors
- **Function Failures**: Alert on Azure Function execution failures
- **Mobile App Issues**: Alert on high crash rates or ANR events

**Alert Channels**:

- Azure Monitor Action Groups
- Email notifications to administrators
- SMS for critical alerts
- Push notifications to mobile app
- Slack/Teams integration for development team

**Performance Monitoring**:

- End-to-end transaction tracing from device to mobile app
- Dependency mapping showing system component relationships
- Live metrics stream for real-time troubleshooting
- Application Map visualizing system architecture

**Custom Metrics and Events**:

```go
// Track cook session events
client.TrackEvent("cook.started", map[string]string{
    "device_id": deviceID,
    "cook_type": "brisket",
    "target_temp": "203",
})

// Track temperature readings with context
client.TrackMetric("temperature.reading", temp, map[string]string{
    "probe": "grill",
    "cook_id": cookID,
    "device_id": deviceID,
})
```

#### Backup & Disaster Recovery

- CosmosDB automatic backups
- Cross-region replication
- Point-in-time recovery
- Disaster recovery testing

### 10. Implementation Phases

#### Phase 0: Monorepo Setup (Week 1)

1. Create new GitHub repository `meatgeekv2`
   - Initialize NX workspace with React, React Native, and Node.js presets
   - Configure NX Cloud for distributed caching
   - Set up shared TypeScript configurations
   - Add custom NX executor for Go projects

2. Migrate existing device controller
   - Copy current MeatGeek-DeviceController to `apps/device-controller`
   - Create NX project.json configuration for Go builds
   - Set up cross-compilation for ARM (Raspberry Pi)
   - Maintain existing functionality while integrating with NX

3. Set up core shared libraries
   - `@meatgeekv2/api-specs` - OpenAPI 3.0 specifications and validation tooling
   - `@meatgeekv2/api-interfaces` - TypeScript types and interfaces (generated from specs)
   - `@meatgeekv2/tracing` - OpenTelemetry instrumentation and trace helpers
   - `@meatgeekv2/utils` - Common utilities
   - Configure import paths and dependency boundaries

4. Development environment setup
   - Configure ESLint and Prettier for TypeScript projects
   - Set up Go linting and formatting tools
   - Set up Jest testing framework for TypeScript
   - Create NX generators for common patterns
   - Configure CI/CD pipeline templates

#### Phase 1: Foundation (Weeks 2-5)

1. Set up Azure infrastructure
   - Create resource group and services
   - Configure IoT Hub and CosmosDB
   - Set up Azure Functions runtime
   - Configure Application Insights and Log Analytics Workspace
   - Set up Azure Monitor dashboards and alert rules
   - Set up Terraform state management in Azure Storage
   - Create Terraform modules for each Azure service
   - Deploy infrastructure using Terraform with dev environment
   - Validate infrastructure deployment and connectivity

2. Develop shared libraries and API specifications
   - Create comprehensive OpenAPI 3.0 specifications in `@meatgeekv2/api-specs`
   - Set up API validation middleware and tooling (Swagger UI, client generation)
   - Implement mock API server with realistic BBQ temperature data for development
   - Configure automated spec validation and contract testing
   - Set up NX commands for spec bundling, type generation, and client SDK creation
   - Generate `@meatgeekv2/api-interfaces` TypeScript types from OpenAPI specs
   - Implement `@meatgeekv2/data-models` with business logic
   - Create `@meatgeekv2/azure-client` for service integrations
   - Build `@meatgeekv2/tracing` with OpenTelemetry helpers and correlation utilities
   - Build `@meatgeekv2/utils` with common helpers

3. Develop data pusher service (apps/data-pusher)
   - Go service for temperature polling
   - IoT Hub integration using shared interfaces
   - Local buffering implementation
   - NX build configuration for Go projects
   - Systemd service configuration

4. Integrate OpenTelemetry and Azure monitoring
   - Replace NewRelic with OpenTelemetry Go SDK for device controller
   - Configure Azure Monitor exporter for Application Insights
   - Implement distributed tracing with W3C Trace Context
   - Add custom temperature and device health metrics with trace correlation
   - Implement structured logging to Log Analytics with trace IDs
   - Set up correlation ID generation for human-readable debugging

5. Basic Azure Functions API (apps/api)
   - Implement contract-first Azure Functions using OpenAPI middleware for validation
   - Temperature ingestion function with automated request/response validation
   - Basic CRUD operations for cooks using generated types from OpenAPI specs
   - Authentication setup with OpenAPI security schemes (JWT validation)
   - NX deployment configuration with auto-generated API documentation
   - Integration testing using mock server generated from OpenAPI specifications
   - Function metadata linking to OpenAPI operation definitions

#### Phase 2: Core API & Shared Components (Weeks 6-9)

1. Complete Azure Functions API (apps/api)
   - All cook management endpoints using shared data models
   - Temperature query APIs with shared interfaces
   - Device management with shared validation
   - User profile management using shared business logic
   - Comprehensive API contract testing using OpenAPI specifications
   - Automated integration tests with mock data generation
   - OpenAPI specification compliance validation in CI/CD pipeline

2. Real-time infrastructure
   - `@meatgeekv2/realtime` library with SignalR client logic
   - Event-driven architecture using shared interfaces
   - Push notification setup with shared utilities

3. UI component library development
   - `@meatgeekv2/ui-components` with cross-platform components
   - `@meatgeekv2/charts` for data visualization
   - Storybook setup for component documentation
   - Unit tests for all shared components

4. Data model refinement
   - Performance optimization in `@meatgeekv2/data-models`
   - CosmosDB indexing strategy
   - TTL policies configuration

#### Phase 3: Mobile App (Weeks 10-17)

1. React Native project setup (apps/mobile)
   - NX React Native application configuration
   - Navigation structure using React Native Navigation
   - State management with React Query
   - Integration with all shared libraries

2. Core features implementation using shared libraries
   - Authentication flow with `@meatgeekv2/azure-client`
   - Temperature dashboard with `@meatgeekv2/ui-components`
   - Cook management interface using `@meatgeekv2/data-models`
   - Real-time updates with `@meatgeekv2/realtime`

3. Advanced features
   - Temperature charts from `@meatgeekv2/charts`
   - Push notifications using shared notification logic
   - Offline support with local caching
   - Camera integration for cook photos
   - Unit and integration testing

#### Phase 4: Web App & Advanced Features (Weeks 18-21)

1. React web application (apps/web)
   - NX React application setup
   - Responsive design using shared UI components
   - Same feature set as mobile app
   - Advanced analytics dashboard

2. Enhanced features across all apps
   - Recipe management using shared business logic
   - Data export capabilities with shared utilities
   - Social features and community aspects
   - Admin dashboard for system management

3. Performance optimization
   - NX build optimization and caching
   - Bundle splitting and lazy loading
   - CDN integration for static assets
   - Lighthouse performance auditing
   - CDN integration

### 11. Development Workflow with NX

#### Daily Development Commands

```bash
# Install dependencies for entire workspace
npm install

# Start development servers
nx serve mobile          # React Native mobile app
nx serve web            # React web application
nx serve api            # Azure Functions (local development)
nx serve api-docs       # Start Swagger UI documentation server

# API Specification Development
nx generate-types api-specs    # Generate TypeScript types from OpenAPI specs
nx validate-specs api-specs    # Validate OpenAPI specifications
nx generate-clients api-specs  # Generate client SDKs for mobile/web

# Build projects
nx build api            # Build Azure Functions
nx build web            # Build React web app
nx build mobile --platform=ios  # Build iOS app
nx build device-controller  # Build device controller (Go)
nx build data-pusher    # Build data pusher service (Go)

# Cross-compile Go projects for Raspberry Pi
nx build device-controller --configuration=arm
nx build data-pusher --configuration=arm

# Infrastructure management
nx init infrastructure         # Initialize Terraform
nx plan infrastructure --env=dev   # Plan infrastructure changes
nx apply infrastructure --env=dev  # Apply infrastructure changes
nx destroy infrastructure --env=dev # Destroy infrastructure
nx validate infrastructure     # Validate Terraform configuration

# Run tests
nx test api             # Test Azure Functions
nx test ui-components   # Test shared UI components
nx test device-controller  # Test device controller (Go)
nx run-many --target=test --all  # Test all projects

# Lint and format
nx lint api             # Lint specific project
nx lint device-controller  # Lint Go code with golint
nx run-many --target=lint --all  # Lint all projects
nx format:write         # Format all files

# Build only affected projects (after changes)
nx affected:build       # Build only changed projects
nx affected:test        # Test only affected projects
nx affected:lint        # Lint only affected projects

# Deploy to Raspberry Pi
nx deploy device-controller --target=pi
nx deploy data-pusher --target=pi
```

#### Dependency Graph and Project Relationships

```bash
# Visualize project dependencies
nx dep-graph

# Show affected projects after changes
nx print-affected --select=projects

# Show what depends on a specific library
nx print-affected --select=projects --base=main~1
```

#### Library Development Workflow

```bash
# Generate new shared library
nx g @nrwl/workspace:lib my-new-lib

# Generate new React component in ui-components
nx g @nrwl/react:component MyComponent --project=ui-components

# Generate new Azure Function
nx g @nrwl/node:function MyFunction --project=api

# Generate new React Native screen
nx g @nrwl/react-native:component MyScreen --project=mobile
```

#### CI/CD Integration

The monorepo structure enables efficient CI/CD with NX:

**Pull Request Workflow:**

```yaml
# .github/workflows/ci.yml
name: CI
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - run: npm ci

      - name: Run affected tests
        run: npx nx affected:test --base=origin/main

      - name: Run affected builds
        run: npx nx affected:build --base=origin/main

      - name: Run affected lints
        run: npx nx affected:lint --base=origin/main
```

**Deployment Workflow:**

> **Historical design note — superseded.** The single `deploy.yml` example below (one workflow, every push to `main`, conditionally building/deploying the web app) reflects the original plan and is **not** what shipped. The shipped model splits prod deploy into two standalone workflows: `infra-deploy-prod.yml` (Terraform infrastructure, `workflow_dispatch`-only and **plan-only** — `terraform init` binding the per-env `azurerm` remote backend + `terraform plan`, no `apply`; the per-env remote backend (`backend-dev.hcl`/`backend-prod.hcl` with a derived state account) has since **shipped** under MG-24, but auto-apply-on-merge and the apply step stay deferred **by design** — a live greenfield apply is the operator's out-of-band acceptance step, not blocked on the backend) and `app-deploy-prod.yml` (Functions **API only** via `nx deploy api --env=prod`). The app deploy is **CI-gated**: it triggers on `workflow_run` *after* the CI/CD Pipeline completes green on a push to `main`, and only when the repository variable `PROD_DEPLOY_ENABLED == 'true'` — there is **no** push trigger and **no** `workflow_dispatch` (retry via GitHub re-run). It builds its own artifact, verifies the Functions package, pins Azure Functions Core Tools, and authenticates via **per-environment OIDC** — `azure/login@v2` with a GitHub-Environment-scoped federated credential (subject `environment:production`) and the `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` `production` Environment variables — **not** the retired long-lived `AZURE_CREDENTIALS_PROD` service-principal secret. A stale-SHA guard skips (green) if `main` has advanced past the CI'd commit. There is **no** prod web / Static Web Apps deploy — the web app is deployed to dev only. Dev deployment (`deploy-dev`) still lives in `ci.yml`. See [CI/CD Pipeline](development/ci-cd.md) for the current, authoritative description. The YAML below is retained only as a record of the original intent.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - run: npm ci

      - name: Deploy affected apps
        run: |
          if nx print-affected --select=projects | grep -q "api"; then
            nx deploy api
          fi

          if nx print-affected --select=projects | grep -q "web"; then
            nx build web
            # Deploy to Azure Static Web Apps or CDN
          fi
```

#### Shared Library Best Practices

1. **Import Boundaries**: Use NX enforce-module-boundaries to prevent inappropriate dependencies
2. **Barrel Exports**: Use index.ts files for clean API surfaces
3. **Versioning**: Use NX implicit dependencies for automatic rebuilds
4. **Documentation**: Maintain README files for each library
5. **Testing**: Write comprehensive tests for shared code

#### Development Environment Setup

```bash
# Clone the repository
git clone https://github.com/stevebargelt/meatgeekv2.git
cd meatgeekv2

# Install dependencies
npm install

# Set up development environment
cp .env.example .env.local
# Edit .env.local with your Azure connection strings

# Start all development services
npm run start:all

# Or start individual services
nx serve api     # Starts Azure Functions locally
nx serve mobile  # Starts React Native with Expo
nx serve web     # Starts React development server
```

### 12. Cost Estimation (Monthly)

#### Azure Services

- IoT Hub (Basic): $10
- CosmosDB (400 RU/s): $24
- Azure Functions (Consumption): $15
- SignalR Service (Free tier): $0
- Storage Account: $5
- Application Insights: $10
- **Total Azure**: ~$65/month for single-device usage

#### Scaling Considerations

- 10 devices: ~$150/month
- 100 devices: ~$500/month
- 1000 devices: ~$2,000/month

### 12. Success Metrics

#### Technical KPIs

- Device uptime: >99.5%
- API response time: <500ms (95th percentile)
- Data ingestion latency: <10 seconds
- Real-time update latency: <2 seconds

#### User Experience KPIs

- Mobile app crash rate: <0.1%
- Cook completion rate: >90%
- User retention (30-day): >70%
- Temperature accuracy: ±2°F

### 13. Future Enhancements

#### Advanced Features

- Machine learning for cook prediction
- Weather integration for outdoor cooking
- Recipe recommendation engine
- Social cooking community
- Integration with smart home systems

#### Commercial Opportunities

- Multi-tenant SaaS platform
- White-label solutions for BBQ equipment manufacturers
- API marketplace for third-party integrations
- Premium analytics and reporting features

---

### 14. Benefits of Complete System in Monorepo

#### Unified System Management

**Hardware and Cloud Together**:

- Device controller and cloud services in one repository
- Synchronized versioning across all components
- Single source of truth for entire MeatGeek ecosystem
- Simplified dependency management

**Development Benefits**:

- Test device controller changes alongside API changes
- Ensure compatibility across all system layers
- Shared CI/CD pipeline for all components
- Unified deployment strategies

**Operational Advantages**:

- Single repository to monitor and maintain
- Coordinated releases of device and cloud updates
- Simplified troubleshooting with complete system visibility
- Consistent logging and monitoring across all services

**Team Collaboration**:

- Frontend, backend, and embedded developers work in same codebase
- Shared code review process
- Better understanding of full system architecture
- Reduced communication overhead

---

This comprehensive plan provides a roadmap for building MeatGeek V2 as a scalable, feature-rich BBQ temperature monitoring and cook management system. By organizing everything in a single NX monorepo—from the Raspberry Pi device controller to the Azure cloud services and client applications—the system benefits from maximum code reuse, consistent development practices, and simplified maintenance. The architecture can evolve from a personal project to a commercial platform while maintaining a clean, organized codebase.
