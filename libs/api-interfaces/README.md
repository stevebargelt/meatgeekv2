# API Interfaces Library

TypeScript interfaces and types for the MeatGeek V2 API, providing type safety across all applications and libraries.

## Overview

This library contains all the shared TypeScript interfaces used throughout the MeatGeek V2 system, ensuring consistent data structures between:

- Azure Functions API
- React web application  
- React Native mobile application
- Shared business logic libraries

## Interface Categories

### Temperature (`temperature.ts`)
- `TemperatureReading` - Individual temperature measurements
- `TemperatureHistoryRequest/Response` - Historical data queries
- `LiveTemperatureUpdate` - Real-time temperature updates
- `TemperatureAlert` - Temperature alerting configuration

### Cook Management (`cook.ts`)
- `Cook` - Cook session data model
- `StartCookRequest/UpdateCookRequest` - Cook management operations
- `ListCooksRequest/CookListResponse` - Cook querying and pagination
- `CookSummary` - Cook analytics and statistics
- `CookStatusUpdate` - Real-time cook status updates

### Device Management (`device.ts`)
- `Device` - BBQ device information and configuration
- `DeviceConfiguration` - Device settings and calibration
- `DeviceStatus` - Hardware status from device controller
- `DeviceCommand/DeviceCommandResponse` - Remote device control
- `DeviceTelemetryBatch` - Efficient telemetry batching

### User Management (`user.ts`)
- `User` - User account and profile information
- `UserPreferences` - User settings and preferences
- `AuthResponse` - Authentication and authorization
- `UserActivity` - User statistics and achievements
- `NotificationPreferences` - Notification settings

### Common Types (`common.ts`)
- `ApiResponse<T>` - Standard API response wrapper
- `PaginatedResponse<T>` - Paginated data responses
- `ErrorResponse` - Standardized error responses
- `HealthCheck` - System health monitoring
- `WebSocketMessage<T>` - Real-time messaging structure

## Usage

### In TypeScript Applications

```typescript
import { 
  Cook, 
  StartCookRequest, 
  TemperatureReading,
  ApiResponse 
} from '@meatgeekv2/api-interfaces';

// Type-safe API responses
const createCook = async (request: StartCookRequest): Promise<ApiResponse<Cook>> => {
  // Implementation
};

// Type-safe data structures
const handleTemperatureUpdate = (reading: TemperatureReading) => {
  // Implementation
};
```

### In Azure Functions

```typescript
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { StartCookRequest, Cook, ApiResponse } from '@meatgeekv2/api-interfaces';

export async function startCookHandler(request: HttpRequest): Promise<HttpResponseInit> {
  const body = await request.json() as StartCookRequest;
  
  // Type-safe request handling
  const cook: Cook = await createCookSession(body);
  
  const response: ApiResponse<Cook> = {
    data: cook,
    success: true,
    metadata: {
      requestId: context.invocationId,
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    }
  };
  
  return { status: 201, jsonBody: response };
}
```

### In React Components

```typescript
import React from 'react';
import { TemperatureReading, Cook } from '@meatgeekv2/api-interfaces';

interface Props {
  cook: Cook;
  currentTemps: TemperatureReading;
}

const CookMonitor: React.FC<Props> = ({ cook, currentTemps }) => {
  // Type-safe component props
  return (
    <div>
      <h2>{cook.name}</h2>
      <p>Grill: {currentTemps.grillTemp}°F</p>
    </div>
  );
};
```

## Development

### Building

```bash
# Build the library
nx build api-interfaces

# Watch for changes during development
nx build api-interfaces --watch
```

### Testing

```bash
# Run tests
nx test api-interfaces

# Run tests in watch mode
nx test api-interfaces --watch
```

### Linting

```bash
# Lint the library
nx lint api-interfaces

# Auto-fix linting issues
nx lint api-interfaces --fix
```

## API Design Principles

### Consistency
- All timestamps use ISO 8601 format strings
- All IDs are strings (UUIDs or readable identifiers)
- Optional fields are marked with `?` operator
- Arrays are consistently named (e.g., `cooks`, `devices`, `readings`)

### Type Safety
- No `any` types - everything is properly typed
- Union types for enums (e.g., `'active' | 'paused' | 'completed'`)
- Generic types for reusable patterns (e.g., `ApiResponse<T>`)

### Extensibility
- Interfaces can be extended without breaking changes
- Optional metadata fields for future features
- Flexible configuration objects

### Real-time Support
- WebSocket message types for SignalR integration
- Live update interfaces for streaming data
- Event-driven data structures

## Integration with OpenAPI

These interfaces serve as the source of truth for OpenAPI specification generation, ensuring consistency between:

- TypeScript type definitions
- OpenAPI schema documentation  
- Runtime request/response validation
- Auto-generated client SDKs

## Versioning

Interface changes follow semantic versioning:
- **Major**: Breaking changes to existing interfaces
- **Minor**: New interfaces or optional fields added
- **Patch**: Documentation updates or internal refactoring

## Dependencies

This library has minimal dependencies to avoid version conflicts:
- Only development dependencies for testing and linting
- No runtime dependencies - pure TypeScript interfaces
- Compatible with all Node.js versions supporting TypeScript

## Contributing

When adding new interfaces:
1. Follow existing naming conventions
2. Add comprehensive JSDoc comments
3. Include example usage in README
4. Add unit tests for complex types
5. Update the main index.ts export