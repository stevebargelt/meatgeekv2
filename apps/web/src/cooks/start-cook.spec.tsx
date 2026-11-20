import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cook } from '../api/client';
import {
  BRISKET_BOX,
  OFFSET,
  apiPath,
  installFetch,
  jsonResponse,
  makeCook,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A fake API for the devices page: two devices, the given active cooks, and
 * `startCook` answering each POST /cooks. GET /cooks/{id} echoes the cook the
 * last successful start created, so the detail page renders after navigating.
 */
function fakeApi({
  activeCooks = [],
  startCook = () => jsonResponse(201, {}),
}: {
  activeCooks?: Cook[];
  startCook?: (req: RecordedRequest) => Response;
} = {}) {
  let started: Cook | undefined;
  return installFetch(req => {
    const path = apiPath(req);
    if (req.method === 'GET' && path === '/devices') {
      return jsonResponse(200, { devices: [BRISKET_BOX, OFFSET] });
    }
    if (req.method === 'GET' && path.startsWith('/cooks?')) {
      return jsonResponse(200, { cooks: activeCooks, limit: 100, hasMore: false });
    }
    if (req.method === 'POST' && path === '/cooks') {
      const answer = startCook(req);
      if (answer.status === 200 || answer.status === 201) {
        const body = req.body as Cook;
        started = makeCook({ ...body, status: 'active' });
        return jsonResponse(answer.status, started);
      }
      return answer;
    }
    if (req.method === 'GET' && started && path === `/cooks/${started.id}`) {
      return jsonResponse(200, started);
    }
    return jsonResponse(500, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected',
      requestId: 'r',
    });
  });
}

function posts(requests: RecordedRequest[]) {
  return requests.filter(r => r.method === 'POST');
}

async function openStartForm(deviceName = 'Brisket Box') {
  const row = (await screen.findByText(deviceName)).closest('tr') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: 'Start cook' }));
  return screen.getByRole('form', { name: `Start a cook on ${deviceName}` });
}

async function fill(form: HTMLElement, fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.type(within(form).getByLabelText(new RegExp(`^${label}`)), value);
  }
}

const twinFailed = () =>
  jsonResponse(503, {
    error: 'DEVICE_TWIN_UPDATE_FAILED',
    message: 'The cook was saved but the device twin could not be updated.',
    requestId: 'req-503',
    cookId: 'whatever',
    reason: 'TWIN_UPDATE_FAILED',
  });

describe('start a cook from a device', () => {
  it('sends the form as the body, with a UUID id, and goes to /cooks/<id> on 201', async () => {
    const { requests } = fakeApi();
    renderPages('/');

    const form = await openStartForm();
    await fill(form, {
      Name: '  Saturday brisket ',
      'Meat type': 'brisket',
      Weight: '12.5',
      'Grill target': '225',
      'Probe 1 target': '203',
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(posts(requests)).toHaveLength(1));
    const body = posts(requests)[0].body as { id: string };
    expect(apiPath(posts(requests)[0])).toBe('/cooks');
    expect(body).toEqual({
      id: expect.stringMatching(UUID),
      deviceId: 'meatgeek3',
      name: 'Saturday brisket',
      meatType: 'brisket',
      weight: 12.5,
      targetTemps: { grill: 225, probe1: 203 },
    });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(`/cooks/${body.id}`)
    );
    expect(await screen.findByRole('heading', { name: 'Saturday brisket' })).toBeTruthy();
  });

  it('leaves blank optional fields out of the body', async () => {
    const { requests } = fakeApi();
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(posts(requests)).toHaveLength(1));
    expect(Object.keys(posts(requests)[0].body as object).sort()).toEqual([
      'deviceId',
      'id',
      'meatType',
      'name',
    ]);
  });

  it('goes to the cook on a 200 replay too', async () => {
    const { requests } = fakeApi({ startCook: () => jsonResponse(200, {}) });
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(posts(requests)).toHaveLength(1));
    const { id } = posts(requests)[0].body as { id: string };
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/cooks/${id}`));
  });

  it('on 503 DEVICE_TWIN_UPDATE_FAILED says so, and Retry resends the same id and body', async () => {
    let calls = 0;
    const { requests } = fakeApi({
      startCook: () => (++calls === 1 ? twinFailed() : jsonResponse(200, {})),
    });
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork', Weight: '4' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('The cook was saved, but the device was not told');
    expect(alert.textContent).toContain('req-503');
    expect(screen.getByTestId('location').textContent).toBe('/');

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(posts(requests)).toHaveLength(2));
    const [first, retry] = posts(requests);
    expect(retry.body).toEqual(first.body);
    const { id } = first.body as { id: string };
    expect(id).toMatch(UUID);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/cooks/${id}`));
  });

  it('keeps the id when the same form is submitted again, and uses a new one after close and reopen', async () => {
    const { requests } = fakeApi({ startCook: twinFailed });
    renderPages('/');

    let form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));
    await within(form).findByRole('alert');
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posts(requests)).toHaveLength(2));

    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Start a cook on Brisket Box' })).toBeNull();

    form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(posts(requests)).toHaveLength(3));

    const ids = posts(requests).map(r => (r.body as { id: string }).id);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[2]).toMatch(UUID);
  });

  it('on 409 COOK_ALREADY_ACTIVE links to the active cook', async () => {
    fakeApi({
      startCook: () =>
        jsonResponse(409, {
          error: 'COOK_ALREADY_ACTIVE',
          message: 'Device already has an active cook',
          requestId: 'req-409',
          activeCookId: 'cook-already-going',
        }),
    });
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('This device already has an active cook.');
    expect(
      within(alert).getByRole('link', { name: 'Open the active cook' }).getAttribute('href')
    ).toBe('/cooks/cook-already-going');
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it.each([
    [403, 'DEVICE_NOT_OWNED', 'Device not owned by the caller'],
    [400, 'VALIDATION_ERROR', 'name must be at most 100 characters'],
    [422, 'COOK_ID_REUSED', 'A cook with this id exists with a different body'],
    [500, 'INTERNAL_SERVER_ERROR', 'Cosmos is having a day'],
  ])('on %i %s shows the problem message', async (status, error, message) => {
    fakeApi({
      startCook: () => jsonResponse(status, { error, message, requestId: `req-${status}` }),
    });
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: 'Ribs', 'Meat type': 'pork' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(`req-${status}`);
    expect(within(form).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('blocks an empty name and a weight of 0 before posting', async () => {
    const { requests } = fakeApi();
    renderPages('/');

    const form = await openStartForm();
    await fill(form, { Name: '   ', 'Meat type': 'pork', Weight: '0', 'Probe 2 target': '1001' });
    await userEvent.click(within(form).getByRole('button', { name: 'Start' }));

    expect(within(form).getByText('Name is required.')).toBeTruthy();
    expect(
      within(form).getByText('Weight must be a number greater than 0 and at most 1000.')
    ).toBeTruthy();
    expect(within(form).getByText('Probe 2 target must be a number from 0 to 1000.')).toBeTruthy();
    expect(posts(requests)).toHaveLength(0);
  });
});

describe('device row and active cooks', () => {
  it('shows "Cooking: <name>" for a device with an active cook, and one GET /cooks?status=active for the page', async () => {
    const cook = makeCook({ id: 'cook-on-brisket-box', name: 'Saturday brisket' });
    const { requests } = fakeApi({ activeCooks: [cook] });
    renderPages('/');

    const link = await screen.findByRole('link', { name: 'Cooking: Saturday brisket' });
    expect(link.getAttribute('href')).toBe('/cooks/cook-on-brisket-box');

    const busy = screen.getByText('Brisket Box').closest('tr') as HTMLElement;
    expect(within(busy).queryByRole('button', { name: 'Start cook' })).toBeNull();
    const idle = screen.getByText('Offset').closest('tr') as HTMLElement;
    expect(within(idle).getByRole('button', { name: 'Start cook' })).toBeTruthy();

    const cookCalls = requests.filter(r => apiPath(r).startsWith('/cooks'));
    expect(cookCalls).toHaveLength(1);
    expect(cookCalls[0].method).toBe('GET');
    expect(new URL(cookCalls[0].url).searchParams.get('status')).toBe('active');
  });

  it('still offers Start cook when the active-cook lookup fails, and says why', async () => {
    installFetch(req =>
      apiPath(req) === '/devices'
        ? jsonResponse(200, { devices: [BRISKET_BOX] })
        : jsonResponse(500, { error: 'INTERNAL_SERVER_ERROR', message: 'boom', requestId: 'req-x' })
    );
    renderPages('/');

    expect(await screen.findByRole('button', { name: 'Start cook' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not check which devices are cooking: boom'
    );
  });
});
