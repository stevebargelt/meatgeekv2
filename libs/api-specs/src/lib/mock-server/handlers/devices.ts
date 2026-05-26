import type { Request, RequestHandler, Response, Router } from 'express';
import type { Device } from '@meatgeekv2/api-interfaces';

import { MOCK_DEVICES } from '../../mock-data';

interface ErrorEnvelope {
  error: string;
  message: string;
  requestId: string;
}

function requestId(req: Request): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' ? header : '';
}

function sendError(res: Response, status: number, code: string, message: string, reqId: string): void {
  const body: ErrorEnvelope = { error: code, message, requestId: reqId };
  res.status(status).json(body);
}

const deviceStore: Device[] = MOCK_DEVICES.map((d) => ({ ...d }));

function listDevices(req: Request, res: Response): void {
  const userId =
    (req.query['userId'] as string) ||
    (req.headers['x-user-id'] as string) ||
    '';
  if (!userId) {
    sendError(res, 400, 'VALIDATION_ERROR', 'User ID is required', requestId(req));
    return;
  }
  // Mirror the existing Functions handler quirk: GET /devices wraps the array
  // under `devices` (not a bare array) — see spec/paths/devices.yaml.
  const devices = deviceStore.filter((d) => d.userId === userId);
  res.status(200).json({ devices });
}

function getDevice(req: Request, res: Response): void {
  const device = deviceStore.find((d) => d.id === req.params['id']);
  if (!device) {
    sendError(res, 404, 'NOT_FOUND', `Device '${req.params['id']}' not found`, requestId(req));
    return;
  }
  // Bare Device, not wrapped — the {devices: [...]} envelope is unique to the
  // collection endpoint per the device-item spec.
  res.status(200).json(device);
}

function updateDevice(req: Request, res: Response): void {
  const idx = deviceStore.findIndex((d) => d.id === req.params['id']);
  if (idx === -1) {
    sendError(res, 404, 'NOT_FOUND', `Device '${req.params['id']}' not found`, requestId(req));
    return;
  }
  const current = deviceStore[idx];
  const patch = req.body as Partial<Device>;
  const merged: Device = {
    ...current,
    name: patch.name ?? current.name,
    location: patch.location ?? current.location,
    configuration: patch.configuration
      ? { ...current.configuration, ...patch.configuration }
      : current.configuration,
  };
  deviceStore[idx] = merged;
  res.status(200).json(merged);
}

export function registerDeviceRoutes(router: Router): void {
  const list: RequestHandler = (req, res) => listDevices(req, res);
  const getOne: RequestHandler = (req, res) => getDevice(req, res);
  const patchOne: RequestHandler = (req, res) => updateDevice(req, res);
  router.get('/devices', list);
  router.get('/devices/:id', getOne);
  router.patch('/devices/:id', patchOne);
}

/** Test-only: reset to the fixture set. */
export function __resetDeviceStoreForTests(): void {
  deviceStore.length = 0;
  for (const d of MOCK_DEVICES) deviceStore.push({ ...d });
}
