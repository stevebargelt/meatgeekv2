/**
 * HAR-86 — rollupTemperatures registration, through the REAL app wiring.
 *
 * main.ts's app.cosmosDB() registration is captured by mocking the Functions
 * `app` object. The suite holds what the deployed trigger depends on and no
 * unit test of the handler can see: the identity-based connection prefix, the
 * Terraform-made lease container (never created by the trigger), reading from
 * the beginning, the batch and poll settings, and that every `%SETTING%` the
 * registration names is an app setting the functions Terraform module
 * publishes. A setting the host cannot resolve would stop the trigger at
 * start-up, and no HTTP route would notice.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { InvocationContext } from '@azure/functions';

import {
  ROLLUP_TRIGGER_SETTINGS,
  rollupTemperaturesHandler,
} from '../functions/temperatures/rollup-temperatures';

interface CosmosDBRegistration {
  connection: string;
  databaseName: string;
  containerName: string;
  leaseContainerName?: string;
  createLeaseContainerIfNotExists?: boolean;
  startFromBeginning?: boolean;
  maxItemsPerInvocation?: number;
  feedPollDelay?: number;
  handler: (documents: unknown[], context: InvocationContext) => Promise<unknown>;
}

const mockCosmosDBRegistrations: Record<string, CosmosDBRegistration> = {};

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      cosmosDB: (name: string, config: CosmosDBRegistration) => {
        mockCosmosDBRegistrations[name] = config;
      },
      http: () => undefined,
      timer: () => undefined,
      eventHub: () => undefined,
    },
  };
});

const FUNCTIONS_MAIN_TF = path.resolve(
  __dirname,
  '../../../../apps/infrastructure/modules/functions/main.tf'
);

/** The app setting names the functions module publishes. */
function publishedAppSettings(): Set<string> {
  const source = fs.readFileSync(FUNCTIONS_MAIN_TF, 'utf8');
  return new Set([...source.matchAll(/^\s*"([A-Za-z0-9_]+)"\s*=/gm)].map(match => match[1]));
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
});

describe('rollupTemperatures registration (main.ts)', () => {
  it('is the only Cosmos DB trigger', () => {
    expect(Object.keys(mockCosmosDBRegistrations)).toEqual(['rollupTemperatures']);
  });

  it('reads the temperatures change feed, identity-based, into the Terraform lease container', () => {
    const reg = mockCosmosDBRegistrations['rollupTemperatures'];
    expect(reg).toMatchObject({
      connection: 'COSMOSDB',
      databaseName: '%COSMOSDB_DATABASE_NAME%',
      containerName: '%COSMOSDB_TEMPERATURES_CONTAINER_NAME%',
      leaseContainerName: '%COSMOSDB_LEASES_CONTAINER_NAME%',
      createLeaseContainerIfNotExists: false,
      startFromBeginning: true,
      maxItemsPerInvocation: ROLLUP_TRIGGER_SETTINGS.maxItemsPerInvocation,
      feedPollDelay: ROLLUP_TRIGGER_SETTINGS.feedPollDelay,
    });
    expect(reg.handler).toBe(rollupTemperaturesHandler);
  });

  it('names only app settings the functions Terraform module publishes', () => {
    const reg = mockCosmosDBRegistrations['rollupTemperatures'];
    const published = publishedAppSettings();
    // Identity-based connection: the host reads <connection>__accountEndpoint.
    expect(published.has(`${reg.connection}__accountEndpoint`)).toBe(true);
    // The rollups container the handler writes, read by the shared adapter.
    expect(published.has('COSMOSDB_TEMPERATURE_ROLLUPS_CONTAINER_NAME')).toBe(true);
    for (const value of [reg.databaseName, reg.containerName, reg.leaseContainerName]) {
      const setting = /^%([A-Za-z0-9_]+)%$/.exec(value ?? '')?.[1];
      expect({ value, published: setting !== undefined && published.has(setting) }).toEqual({
        value,
        published: true,
      });
    }
  });
});
