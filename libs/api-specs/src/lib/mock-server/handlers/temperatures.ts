import type { Request, RequestHandler, Response, Router } from 'express';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import { TemperatureSeries, findDeviceById, MOCK_COOK_IDS } from '../../mock-data';

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

/**
 * One `TemperatureSeries` per device. Created on first access with a synthetic
 * start time 30 minutes in the past so the very first reading is already past
 * the simulator's warmup ramp — keeps the smoke-test assertion (`grillTemp ∈
 * [200, 300]`) stable across the first curl after server start.
 */
const seriesByDevice = new Map<string, TemperatureSeries>();

function getSeries(deviceId: string): TemperatureSeries {
  const existing = seriesByDevice.get(deviceId);
  if (existing) return existing;
  const warmupOffsetMs = 30 * 60 * 1000;
  const series = new TemperatureSeries({
    seed: `device-${deviceId}`,
    deviceId,
    cookId: MOCK_COOK_IDS.active,
    setpoint: 225,
    startTimeMs: Date.now() - warmupOffsetMs,
  });
  // Backfill an hour of history so /temperatures/history has rows immediately
  // and `current()` is not the first sample (avoids cold-start oscillation).
  series.backfill(60, 5);
  seriesByDevice.set(deviceId, series);
  return series;
}

function getCurrent(req: Request, res: Response): void {
  const deviceId = req.params['deviceId'];
  if (!deviceId) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Device ID is required', requestId(req));
    return;
  }
  if (!findDeviceById(deviceId) && !deviceId.startsWith('meatgeek')) {
    // Allow any meatgeek* id for permissive curl smoke tests; reject obviously
    // malformed ids so spec compliance stays tight.
    sendError(res, 404, 'NOT_FOUND', `Unknown device '${deviceId}'`, requestId(req));
    return;
  }
  const reading = getSeries(deviceId).current();
  res.status(200).json(reading);
}

function getHistory(req: Request, res: Response): void {
  const deviceId = (req.query['deviceId'] as string) || '';
  if (!deviceId) {
    sendError(res, 400, 'VALIDATION_ERROR', 'deviceId query parameter is required', requestId(req));
    return;
  }
  const cookFilter = (req.query['cookId'] as string) || undefined;
  const startTime = req.query['startTime'] ? new Date(String(req.query['startTime'])).getTime() : undefined;
  const endTime = req.query['endTime'] ? new Date(String(req.query['endTime'])).getTime() : undefined;
  const limit = req.query['limit'] !== undefined ? Number(req.query['limit']) : 100;
  const offset = req.query['offset'] !== undefined ? Number(req.query['offset']) : 0;

  const series = getSeries(deviceId);
  let readings = series.history();

  // STRICT tag-match: cookId filter compares the reading's tag, never the time
  // window. See spec/paths/temperatures.yaml for the load-bearing semantics.
  if (cookFilter !== undefined) {
    readings = readings.filter((r) => r.cookId === cookFilter);
  }
  if (startTime !== undefined) {
    readings = readings.filter((r) => new Date(r.timestamp).getTime() >= startTime);
  }
  if (endTime !== undefined) {
    readings = readings.filter((r) => new Date(r.timestamp).getTime() < endTime);
  }

  const page: TemperatureReading[] = readings.slice(offset, offset + limit);
  res.status(200).json({
    readings: page,
    total: readings.length,
    offset,
    limit,
    hasMore: offset + page.length < readings.length,
  });
}

export function registerTemperatureRoutes(router: Router): void {
  const current: RequestHandler = (req, res) => getCurrent(req, res);
  const history: RequestHandler = (req, res) => getHistory(req, res);
  router.get('/temperatures/current/:deviceId', current);
  router.get('/temperatures/history', history);
}

/** Test-only: drop cached series so each test starts deterministic. */
export function __resetTemperatureStateForTests(): void {
  seriesByDevice.clear();
}
