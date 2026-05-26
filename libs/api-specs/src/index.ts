// Mock data: deterministic BBQ temperature simulator + fixtures
// (implemented in sibling step #3 — libs/api-specs/src/lib/mock-data/)
export * from './lib/mock-data';

// OpenAPI request/response validation primitives + framework adapters
// (implemented in sibling step #4 — libs/api-specs/src/lib/validation/)
export * from './lib/validation';

// Express-based mock API server (dev-only)
// (implemented in sibling step #5 — libs/api-specs/src/lib/mock-server/)
export * from './lib/mock-server';

// Swagger UI mount helper for arbitrary Express apps
// (implemented in sibling step #5 — libs/api-specs/src/lib/swagger-ui/)
export * from './lib/swagger-ui';
