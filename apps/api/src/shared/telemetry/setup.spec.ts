// Mock the Azure Monitor distro so the suite runs WITHOUT a live endpoint — no
// telemetry is exported and `useAzureMonitor` is a spy we assert against.
jest.mock('@azure/monitor-opentelemetry', () => ({
  useAzureMonitor: jest.fn(),
}));

import { useAzureMonitor } from '@azure/monitor-opentelemetry';
import type { TokenCredential } from '@azure/core-auth';
import { ManagedIdentityCredential } from '@azure/identity';
import { initializeTelemetry, parseAuthenticationString } from './setup';

const mockUseAzureMonitor = useAzureMonitor as jest.Mock;

describe('initializeTelemetry', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fresh env per test; strip the two keys the SUT reads.
    process.env = { ...ORIGINAL_ENV };
    delete process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'];
    delete process.env['ENVIRONMENT'];
    delete process.env['APPLICATIONINSIGHTS_AUTHENTICATION_STRING'];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it('is a no-op when APPLICATIONINSIGHTS_CONNECTION_STRING is unset', () => {
    initializeTelemetry();
    expect(mockUseAzureMonitor).not.toHaveBeenCalled();
  });

  it('is a no-op when APPLICATIONINSIGHTS_CONNECTION_STRING is empty', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = '';
    initializeTelemetry();
    expect(mockUseAzureMonitor).not.toHaveBeenCalled();
  });

  it('reads the connection string only from the APPLICATIONINSIGHTS_CONNECTION_STRING env var', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] =
      'InstrumentationKey=test-key;IngestionEndpoint=https://example/';

    initializeTelemetry();

    expect(mockUseAzureMonitor).toHaveBeenCalledTimes(1);
    const options = mockUseAzureMonitor.mock.calls[0][0];
    expect(options.azureMonitorExporterOptions.connectionString).toBe(
      'InstrumentationKey=test-key;IngestionEndpoint=https://example/'
    );
  });

  it('calls useAzureMonitor with samplingRatio 0.5', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';

    initializeTelemetry();

    const options = mockUseAzureMonitor.mock.calls[0][0];
    expect(options.samplingRatio).toBe(0.5);
  });

  it('carries a resource with the static standard dimensions: service.name, component, and environment', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';
    process.env['ENVIRONMENT'] = 'staging';

    initializeTelemetry();

    const options = mockUseAzureMonitor.mock.calls[0][0];
    expect(options.resource.attributes['service.name']).toBe('meatgeek-api');
    expect(options.resource.attributes['component']).toBe('function');
    expect(options.resource.attributes['environment']).toBe('staging');
  });

  it('does NOT put per-span dimensions on the static resource', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';

    initializeTelemetry();

    const options = mockUseAzureMonitor.mock.calls[0][0];
    // device.id / cook.id / correlation.id / processing.path are per-request —
    // supplied per span by correlation.ts, never as static resource attributes.
    expect(options.resource.attributes['device.id']).toBeUndefined();
    expect(options.resource.attributes['cook.id']).toBeUndefined();
    expect(options.resource.attributes['correlation.id']).toBeUndefined();
    expect(options.resource.attributes['processing.path']).toBeUndefined();
  });

  it('defaults the environment attribute to "dev" when ENVIRONMENT is unset', () => {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';

    initializeTelemetry();

    const options = mockUseAzureMonitor.mock.calls[0][0];
    expect(options.resource.attributes['environment']).toBe('dev');
  });

  describe('Entra (AAD) ingestion', () => {
    const fakeCredential: TokenCredential = { getToken: async () => null };

    it('passes a managed-identity credential to the exporter when the authentication string asks for AAD', () => {
      // The deployed shape: modules/functions/main.tf sets both settings and the
      // App Insights resource rejects anything not AAD-authenticated.
      process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';
      process.env['APPLICATIONINSIGHTS_AUTHENTICATION_STRING'] = 'Authorization=AAD';
      const credentialFactory = jest.fn(() => fakeCredential);

      initializeTelemetry({ credentialFactory });

      expect(credentialFactory).toHaveBeenCalledWith(undefined);
      const options = mockUseAzureMonitor.mock.calls[0][0];
      expect(options.azureMonitorExporterOptions.credential).toBe(fakeCredential);
      expect(options.azureMonitorExporterOptions.connectionString).toBe('InstrumentationKey=test-key');
    });

    it('uses ManagedIdentityCredential by default', () => {
      process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';
      process.env['APPLICATIONINSIGHTS_AUTHENTICATION_STRING'] = 'Authorization=AAD';

      initializeTelemetry();

      const options = mockUseAzureMonitor.mock.calls[0][0];
      expect(options.azureMonitorExporterOptions.credential).toBeInstanceOf(ManagedIdentityCredential);
    });

    it('hands a user-assigned ClientId to the credential factory', () => {
      process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';
      process.env['APPLICATIONINSIGHTS_AUTHENTICATION_STRING'] =
        'Authorization=AAD;ClientId=00000000-0000-0000-0000-000000000001';
      const credentialFactory = jest.fn(() => fakeCredential);

      initializeTelemetry({ credentialFactory });

      expect(credentialFactory).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001');
    });

    it('sets no credential when the authentication string is absent', () => {
      process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = 'InstrumentationKey=test-key';
      const credentialFactory = jest.fn(() => fakeCredential);

      initializeTelemetry({ credentialFactory });

      expect(credentialFactory).not.toHaveBeenCalled();
      const options = mockUseAzureMonitor.mock.calls[0][0];
      expect(options.azureMonitorExporterOptions.credential).toBeUndefined();
    });
  });

  describe('parseAuthenticationString', () => {
    it.each([
      [undefined, undefined],
      ['', undefined],
      ['Authorization=None', undefined],
      ['ClientId=abc', undefined],
      ['Authorization=AAD', { clientId: undefined }],
      ['authorization=aad', { clientId: undefined }],
      [' Authorization = AAD ; ClientId = abc ', { clientId: 'abc' }],
      ['Authorization=AAD;ClientId=', { clientId: undefined }],
    ])('%p -> %p', (input, expected) => {
      expect(parseAuthenticationString(input)).toEqual(expected);
    });
  });
});
