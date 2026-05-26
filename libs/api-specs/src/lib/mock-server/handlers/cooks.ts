import type { Request, RequestHandler, Response, Router } from 'express';
import type {
  Cook,
  CookListResponse,
  StartCookRequest,
  UpdateCookRequest,
} from '@meatgeekv2/api-interfaces';

import { MOCK_COOKS, MOCK_USER_ID } from '../../mock-data';

interface ErrorEnvelope {
  error: string;
  message: string;
  requestId: string;
}

function requestId(req: Request): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' ? header : '';
}

function errorEnvelope(code: string, message: string, reqId: string): ErrorEnvelope {
  return { error: code, message, requestId: reqId };
}

function sendError(res: Response, status: number, code: string, message: string, reqId: string): void {
  res.status(status).json(errorEnvelope(code, message, reqId));
}

/**
 * In-memory cook store. The mock server is process-local and dev-only, so
 * a module-level mutable array is sufficient. Fixtures from MOCK_COOKS are
 * loaded once at module init; subsequent CRUD operations mutate this array.
 */
const cookStore: Cook[] = MOCK_COOKS.map((c) => ({ ...c }));

let counter = 0;
function nextCookId(): string {
  counter += 1;
  return `cook-${Date.now()}-${counter}`;
}

function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit);
}

function listCooks(req: Request, res: Response): void {
  const userId = (req.query['userId'] as string) || undefined;
  const status = (req.query['status'] as Cook['status']) || undefined;
  const limit = req.query['limit'] !== undefined ? Number(req.query['limit']) : 20;
  const offset = req.query['offset'] !== undefined ? Number(req.query['offset']) : 0;

  let filtered = cookStore;
  if (userId) filtered = filtered.filter((c) => c.userId === userId);
  if (status) filtered = filtered.filter((c) => c.status === status);

  const page = paginate(filtered, offset, limit);
  const body: CookListResponse = {
    cooks: page,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
  };
  res.status(200).json(body);
}

function createCook(req: Request, res: Response): void {
  const body = req.body as StartCookRequest;
  // Validation middleware has already enforced required fields, but defend
  // against a misconfigured route registration.
  if (!body || !body.name || !body.deviceId || !body.meatType) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Missing required fields: name, deviceId, meatType', requestId(req));
    return;
  }

  const cook: Cook = {
    id: nextCookId(),
    userId: MOCK_USER_ID,
    deviceId: body.deviceId,
    name: body.name,
    status: 'active',
    startTime: new Date().toISOString(),
    meatType: body.meatType,
    weight: body.weight,
    targetTemps: body.targetTemps,
    notes: body.notes,
  };
  cookStore.unshift(cook);
  res.status(201).json(cook);
}

function getCook(req: Request, res: Response): void {
  const cook = cookStore.find((c) => c.id === req.params['id']);
  if (!cook) {
    sendError(res, 404, 'NOT_FOUND', `Cook '${req.params['id']}' not found`, requestId(req));
    return;
  }
  res.status(200).json(cook);
}

function updateCook(req: Request, res: Response): void {
  const idx = cookStore.findIndex((c) => c.id === req.params['id']);
  if (idx === -1) {
    sendError(res, 404, 'NOT_FOUND', `Cook '${req.params['id']}' not found`, requestId(req));
    return;
  }
  const patch = req.body as UpdateCookRequest;
  const current = cookStore[idx];

  if (
    patch.status &&
    current.status === 'completed' &&
    patch.status !== 'completed'
  ) {
    res
      .status(400)
      .json(
        errorEnvelope(
          'VALIDATION_ERROR',
          `Cannot transition completed cook '${current.id}' back to '${patch.status}'`,
          requestId(req),
        ),
      );
    return;
  }

  const merged: Cook = {
    ...current,
    name: patch.name ?? current.name,
    status: patch.status ?? current.status,
    targetTemps: patch.targetTemps ?? current.targetTemps,
    notes: patch.notes ?? current.notes,
    rating: patch.rating ?? current.rating,
    endTime: patch.endTime ?? current.endTime,
  };
  cookStore[idx] = merged;
  res.status(200).json(merged);
}

function startExistingCook(req: Request, res: Response): void {
  const idx = cookStore.findIndex((c) => c.id === req.params['id']);
  if (idx === -1) {
    sendError(res, 404, 'NOT_FOUND', `Cook '${req.params['id']}' not found`, requestId(req));
    return;
  }
  const cook = cookStore[idx];
  if (cook.status === 'active') {
    res.status(200).json(cook);
    return;
  }
  if (cook.status === 'completed' || cook.status === 'cancelled') {
    sendError(res, 409, 'CONFLICT', `Cannot start cook in '${cook.status}' state`, requestId(req));
    return;
  }
  const next: Cook = { ...cook, status: 'active', startTime: new Date().toISOString() };
  cookStore[idx] = next;
  res.status(200).json(next);
}

function stopCook(req: Request, res: Response): void {
  const idx = cookStore.findIndex((c) => c.id === req.params['id']);
  if (idx === -1) {
    sendError(res, 404, 'NOT_FOUND', `Cook '${req.params['id']}' not found`, requestId(req));
    return;
  }
  const cook = cookStore[idx];
  if (cook.status === 'completed') {
    res.status(200).json(cook);
    return;
  }
  const next: Cook = { ...cook, status: 'completed', endTime: new Date().toISOString() };
  cookStore[idx] = next;
  res.status(200).json(next);
}

function getCookHistory(req: Request, res: Response): void {
  const cook = cookStore.find((c) => c.id === req.params['id']);
  if (!cook) {
    sendError(res, 404, 'NOT_FOUND', `Cook '${req.params['id']}' not found`, requestId(req));
    return;
  }
  if (cook.status !== 'completed') {
    sendError(res, 409, 'CONFLICT', `Cook '${cook.id}' is not yet completed`, requestId(req));
    return;
  }
  const startMs = new Date(cook.startTime).getTime();
  const endMs = cook.endTime ? new Date(cook.endTime).getTime() : Date.now();
  const totalMinutes = Math.max(0, (endMs - startMs) / 60_000);
  const avgGrill = cook.targetTemps?.grill ?? 225;
  res.status(200).json({
    cookId: cook.id,
    totalDuration: totalMinutes,
    averageGrillTemp: avgGrill,
    peakGrillTemp: cook.maxTemps?.grill ?? avgGrill + 20,
    averageProbeTemps: {
      probe1: cook.targetTemps?.probe1,
      probe2: cook.targetTemps?.probe2,
      probe3: cook.targetTemps?.probe3,
      probe4: cook.targetTemps?.probe4,
    },
    temperatureStability: 92,
  });
}

/**
 * Register cook-related routes on the supplied Express router. The router is
 * mounted at the application root in `server.ts`, so paths here are absolute.
 */
export function registerCookRoutes(router: Router): void {
  const list: RequestHandler = (req, res) => listCooks(req, res);
  const create: RequestHandler = (req, res) => createCook(req, res);
  const getOne: RequestHandler = (req, res) => getCook(req, res);
  const patchOne: RequestHandler = (req, res) => updateCook(req, res);
  const start: RequestHandler = (req, res) => startExistingCook(req, res);
  const stop: RequestHandler = (req, res) => stopCook(req, res);
  const history: RequestHandler = (req, res) => getCookHistory(req, res);

  router.get('/cooks', list);
  router.post('/cooks', create);
  router.post('/cooks/:id/start', start);
  router.post('/cooks/:id/stop', stop);
  router.get('/cooks/:id/history', history);
  router.get('/cooks/:id', getOne);
  router.patch('/cooks/:id', patchOne);
}

/** Test-only: reset the store to the initial fixture set. */
export function __resetCookStoreForTests(): void {
  cookStore.length = 0;
  for (const c of MOCK_COOKS) cookStore.push({ ...c });
  counter = 0;
}
