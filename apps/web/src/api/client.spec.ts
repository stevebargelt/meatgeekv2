import { createApiClient } from './client';
import { problemFromResponse } from './problem';
import { installFetch, jsonResponse } from '../test/fakes';

describe('createApiClient', () => {
  it('is typed by the OpenAPI spec: paths and methods it does not declare fail tsc', async () => {
    const { fetchMock } = installFetch(() => jsonResponse(404, {}));
    const client = createApiClient({ baseUrl: 'https://x.test/api', getToken: async () => 't' });

    // These lines exist for `tsc` (nx run web:typecheck, and ts-jest here):
    // if the generated types ever accepted them, the @ts-expect-error
    // directives would themselves become errors.
    // @ts-expect-error '/not-in-the-spec' is not a path in libs/api-specs/spec/openapi.yaml
    await client.GET('/not-in-the-spec');
    // @ts-expect-error /devices has no DELETE operation in the spec
    await client.DELETE('/devices');
    // @ts-expect-error RegisterDeviceRequest requires model
    await client.POST('/devices', { body: { deviceId: 'a', name: 'b' } });

    // A path the spec does declare type-checks.
    await client.GET('/devices');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('problemFromResponse', () => {
  it('keeps the flat error body message, code and requestId', () => {
    const body = { error: 'DEVICE_CONFLICT', message: 'taken', requestId: 'req-1' };
    expect(problemFromResponse(body, new Response(null, { status: 409 }))).toEqual({
      status: 409,
      code: 'DEVICE_CONFLICT',
      message: 'taken',
      requestId: 'req-1',
    });
  });

  it('explains a 401 with its reason, and takes the request id from the header', () => {
    const response = new Response(null, { status: 401, headers: { 'X-Request-ID': 'hdr-1' } });
    const problem = problemFromResponse(
      { error: 'UNAUTHENTICATED', reason: 'NO_PRINCIPAL' },
      response
    );
    expect(problem.message).toContain('NO_PRINCIPAL');
    expect(problem.requestId).toBe('hdr-1');
  });

  it('falls back to the HTTP status for a non-JSON body', () => {
    expect(problemFromResponse('Bad Gateway', new Response(null, { status: 502 })).message).toBe(
      'The request failed with HTTP 502.'
    );
  });
});
