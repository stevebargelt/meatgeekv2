import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiProvider } from '../api/api-context';
import type { Device } from '../api/client';
import { BRISKET_BOX, apiPath, errorResponse, installFetch, jsonResponse } from '../test/fakes';
import { createTestClient } from '../test/render';
import { CONNECTION_TEXT, connectionText } from './connection';
import { DevicesPage } from './devices-page';

/**
 * HAR-143 — each device row says whether the device is connected and when IoT
 * Hub last heard from it. Every age here is measured on a fixed clock, NOW; no
 * test reads the wall clock.
 */
const NOW = Date.parse('2026-11-22T18:00:00.000Z');
/** NOW less `ms`, as the API sends lastActivityAt. */
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe('connectionText', () => {
  it('Connected, plus the age when the hub has heard from the device', () => {
    expect(connectionText({ state: 'connected', lastActivityAt: before(12_000) }, NOW)).toBe(
      'Connected · last heard 12 s ago'
    );
    expect(connectionText({ state: 'connected', lastActivityAt: null }, NOW)).toBe('Connected');
  });

  it('Offline · last heard <age> ago', () => {
    expect(connectionText({ state: 'disconnected', lastActivityAt: before(184_000) }, NOW)).toBe(
      'Offline · last heard 3 min 4 s ago'
    );
    expect(
      connectionText({ state: 'disconnected', lastActivityAt: before(26 * 3_600_000) }, NOW)
    ).toBe('Offline · last heard 26 h 0 min ago');
  });

  it('Offline · never heard from', () => {
    expect(connectionText({ state: 'disconnected', lastActivityAt: null }, NOW)).toBe(
      'Offline · never heard from'
    );
  });

  it('Status unknown, for an unknown state or no connection at all', () => {
    expect(connectionText({ state: 'unknown', lastActivityAt: null }, NOW)).toBe('Status unknown');
    expect(connectionText(undefined, NOW)).toBe('Status unknown');
  });

  it('a hub clock ahead of ours reads as 0 s, never a negative age', () => {
    expect(connectionText({ state: 'connected', lastActivityAt: before(-5_000) }, NOW)).toBe(
      'Connected · last heard 0 s ago'
    );
  });
});

describe('the devices page shows each device’s connection', () => {
  const devices: Device[] = [
    {
      ...BRISKET_BOX,
      id: 'on',
      name: 'On',
      connection: { state: 'connected', lastActivityAt: before(12_000) },
    },
    {
      ...BRISKET_BOX,
      id: 'off',
      name: 'Off',
      connection: { state: 'disconnected', lastActivityAt: before(184_000) },
    },
    {
      ...BRISKET_BOX,
      id: 'never',
      name: 'Never',
      connection: { state: 'disconnected', lastActivityAt: null },
    },
    {
      ...BRISKET_BOX,
      id: 'lost',
      name: 'Lost',
      connection: { state: 'unknown', lastActivityAt: null },
    },
  ];

  it('renders the four texts in a Status column, aged on the injected clock', async () => {
    const { requests } = installFetch(req => {
      const path = apiPath(req);
      if (req.method === 'GET' && path === '/devices') return jsonResponse(200, { devices });
      if (req.method === 'GET' && path.startsWith('/cooks?')) {
        return jsonResponse(200, { cooks: [], limit: 100, hasMore: false });
      }
      return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'unexpected', 'r');
    });
    const clock = jest.fn(() => NOW);

    render(
      <ApiProvider client={createTestClient()}>
        <MemoryRouter>
          <DevicesPage clock={clock} />
        </MemoryRouter>
      </ApiProvider>
    );

    const statusOf = async (name: string) =>
      within((await screen.findByText(name)).closest('tr') as HTMLElement).getByTestId(
        'device-connection'
      ).textContent;
    expect(await statusOf('On')).toBe('Connected · last heard 12 s ago');
    expect(await statusOf('Off')).toBe('Offline · last heard 3 min 4 s ago');
    expect(await statusOf('Never')).toBe(CONNECTION_TEXT.neverHeard);
    expect(await statusOf('Lost')).toBe(CONNECTION_TEXT.unknown);
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy();
    // The clock is read once, when the list answered; the list is read once.
    expect(clock).toHaveBeenCalledTimes(1);
    expect(requests.filter(r => r.method === 'GET' && apiPath(r) === '/devices')).toHaveLength(1);
  });
});
