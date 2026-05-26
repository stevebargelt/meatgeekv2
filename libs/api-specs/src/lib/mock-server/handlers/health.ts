import type { RequestHandler, Router } from 'express';

/**
 * Lightweight liveness probe. Returns 200 with a small JSON body — useful for
 * smoke testing and dev orchestration scripts. The endpoint is intentionally
 * NOT declared in openapi.yaml; it must therefore be registered BEFORE the
 * OpenAPI validator middleware so the validator does not reject it as an
 * unknown route.
 */
export function registerHealthRoute(router: Router): void {
  const health: RequestHandler = (_req, res) => {
    res.status(200).json({ status: 'ok', name: 'meatgeekv2-mock-api' });
  };
  router.get('/health', health);
}
