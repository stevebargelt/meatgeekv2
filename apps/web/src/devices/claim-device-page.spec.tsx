import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BRISKET_BOX,
  TEST_CLAIM_CODE,
  apiPath,
  errorResponse,
  installFetch,
  jsonResponse,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';
import { CLAIM_MESSAGES } from './claim-device-page';

/**
 * A fake API: `claim` answers each POST /devices/claim; a successful claim
 * puts BRISKET_BOX in the list GET /devices returns.
 */
function fakeApi(claim: (req: RecordedRequest) => Response) {
  let devices: unknown[] = [];
  return installFetch(req => {
    const path = apiPath(req);
    if (req.method === 'POST' && path === '/devices/claim') {
      const answer = claim(req);
      if (answer.ok) devices = [BRISKET_BOX];
      return answer;
    }
    if (req.method === 'GET' && path === '/devices') return jsonResponse(200, { devices });
    if (req.method === 'GET' && path.startsWith('/cooks?')) {
      return jsonResponse(200, { cooks: [], limit: 100, hasMore: false });
    }
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'unexpected', 'r');
  });
}

const form = () => screen.getByRole('form', { name: 'Claim a device' });
const field = (label: string) => within(form()).getByLabelText(new RegExp(`^${label}`));
const location = () => screen.getByTestId('location').textContent;

async function fillAndClaim(fields: Record<string, string>) {
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.type(field(label), value);
  }
  await userEvent.click(within(form()).getByRole('button', { name: 'Claim device' }));
}

const claims = (requests: RecordedRequest[]) =>
  requests.filter(r => r.method === 'POST' && apiPath(r) === '/devices/claim');

describe('the claim page', () => {
  it('is linked from the devices page, which has no register form', async () => {
    fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/');
    await screen.findByText(/You have no devices yet/);
    expect(screen.queryByRole('form', { name: 'Register a device' })).toBeNull();

    await userEvent.click(screen.getByRole('link', { name: 'Claim a device' }));

    expect(location()).toBe('/devices/claim');
    expect(screen.getByRole('heading', { name: 'Claim a device' })).toBeTruthy();
  });

  it('prefills the device ID from ?deviceId=', () => {
    fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim?deviceId=meatgeek-pi-7');

    expect((field('Device ID') as HTMLInputElement).value).toBe('meatgeek-pi-7');
    expect((field('Claim code') as HTMLInputElement).value).toBe('');
  });

  it('leaves the device ID empty with no query', () => {
    fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim');
    expect((field('Device ID') as HTMLInputElement).value).toBe('');
  });

  it('shows the code upper case in groups of four, whatever separators were typed', async () => {
    fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim');
    const code = field('Claim code') as HTMLInputElement;

    await userEvent.type(code, '7k3m 9qxr-2htv');
    expect(code.value).toBe('7K3M-9QXR-2HTV');

    await userEvent.clear(code);
    await userEvent.type(code, '7k3m9qxr2htv');
    expect(code.value).toBe('7K3M-9QXR-2HTV');
  });

  it('marks the code field as not for autocomplete or spell check', () => {
    fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim');
    const code = field('Claim code');
    expect(code.getAttribute('autocomplete')).toBe('off');
    expect(code.getAttribute('spellcheck')).toBe('false');
  });

  it.each([201, 200])(
    'on %i posts {deviceId, claimCode, name, location}, clears the code and shows the device',
    async status => {
      const { requests } = fakeApi(() => jsonResponse(status, BRISKET_BOX));
      renderPages(`/devices/claim?deviceId=${BRISKET_BOX.id}`);
      const code = field('Claim code') as HTMLInputElement;

      await fillAndClaim({
        'Claim code': '7k3m-9qxr 2htv',
        Name: '  Brisket Box ',
        Location: ' Backyard ',
      });

      expect(await screen.findByRole('table')).toBeTruthy();
      expect(location()).toBe('/');
      expect(screen.getByText(BRISKET_BOX.name)).toBeTruthy();
      // The field the code was typed in was blanked before the page went.
      expect(code.value).toBe('');
      expect(claims(requests).map(r => r.body)).toEqual([
        {
          deviceId: BRISKET_BOX.id,
          claimCode: '7K3M-9QXR-2HTV',
          name: 'Brisket Box',
          location: 'Backyard',
        },
      ]);
    }
  );

  it('leaves location out when it is blank, and sends no model', async () => {
    const { requests } = fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim');

    await fillAndClaim({ 'Device ID': 'meatgeek3', 'Claim code': TEST_CLAIM_CODE, Name: 'Box' });

    await waitFor(() => expect(location()).toBe('/'));
    expect(claims(requests).map(r => r.body)).toEqual([
      { deviceId: 'meatgeek3', claimCode: TEST_CLAIM_CODE, name: 'Box' },
    ]);
  });

  it.each([
    [
      403,
      errorResponse(403, 'CLAIM_REFUSED', 'Device could not be claimed with that code'),
      CLAIM_MESSAGES.refused,
    ],
    [
      409,
      errorResponse(409, 'DEVICE_CONFLICT', 'You already have a device with this name.'),
      CLAIM_MESSAGES.conflict,
    ],
    [
      400,
      errorResponse(
        400,
        'VALIDATION_ERROR',
        'claimCode must be the 12-symbol code the device shows'
      ),
      'claimCode must be the 12-symbol code the device shows',
    ],
    [
      503,
      errorResponse(503, 'DEVICE_TWIN_UPDATE_FAILED', 'The device twin could not be read.'),
      CLAIM_MESSAGES.busy,
    ],
  ])('on %i says so, keeps the form and its request id', async (status, answer, message) => {
    const { requests } = fakeApi(() => answer);
    renderPages('/devices/claim?deviceId=meatgeek3');

    await fillAndClaim({ 'Claim code': TEST_CLAIM_CODE, Name: 'Box' });

    const alert = await within(form()).findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(`req-${status}`);
    expect(location()).toBe('/devices/claim?deviceId=meatgeek3');
    expect(claims(requests)).toHaveLength(1);
  });

  it('checks the fields before posting', async () => {
    const { requests } = fakeApi(() => jsonResponse(201, BRISKET_BOX));
    renderPages('/devices/claim');

    await fillAndClaim({ 'Device ID': 'has spaces', Name: '   ' });

    expect(screen.getByText(/Device ID must be 1-128 characters/)).toBeTruthy();
    expect(screen.getByText('Claim code is required.')).toBeTruthy();
    expect(screen.getByText('Name is required.')).toBeTruthy();
    expect(claims(requests)).toHaveLength(0);
  });

  it('never puts the code in the URL', async () => {
    fakeApi(() => errorResponse(403, 'CLAIM_REFUSED', 'refused'));
    renderPages('/devices/claim?deviceId=meatgeek3');

    await fillAndClaim({ 'Claim code': TEST_CLAIM_CODE, Name: 'Box' });
    await within(form()).findByRole('alert');

    expect(location()).not.toContain(TEST_CLAIM_CODE.slice(0, 4));
  });
});
