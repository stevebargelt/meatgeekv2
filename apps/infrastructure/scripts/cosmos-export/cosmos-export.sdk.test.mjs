// The SDK-dependent tier: the only tests here that belong here are the ones
// that take createRealClient's DEFAULT import thunks and therefore need a real
// node_modules. Everything else in this directory runs against the injected
// fakes and stays in the dependency-free tier.
//
// The split is not cosmetic. The dependency-free tier runs in CI's
// validate-infrastructure job, which installs nothing and holds no credentials
// on purpose; a test that resolves @azure/cosmos cannot run there. But the real
// import is also the one thing an agent container cannot check — its
// node_modules is a read-only mount that may predate @azure/identity — so
// deleting these would leave `import('@azure/identity')` unverified everywhere.
// Hence: same directory, separate file, separate CI step after `npm ci`
// (lint-and-test). Run via `run-tests.mjs --sdk`, which floors the counts so a
// rename cannot make this tier vacuously green.
//
// Nothing here may contact Azure. Constructing a client and constructing a
// credential are both offline; calling any client method is not, and is out of
// scope for this tier as much as for the other.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createRealClient } from './cosmos-export.mjs';

const ENDPOINT = 'https://meatgeek.documents.azure.com:443/';

describe('MG-49 real Azure SDK integration', () => {
  it('loads the installed Azure Identity SDK and constructs its default credential offline', async () => {
    const client = await createRealClient({
      endpoint: ENDPOINT,
      authMode: 'aad',
      key: '',
    });

    // Constructing a client/credential must not make a token request.  Calling
    // any client method is deliberately out of scope: that would contact Azure.
    assert.equal(client.constructor.name, 'CosmosClient');
  });

  it('the real CosmosClient accepts the key-mode options this tool builds', async () => {
    // The fake CosmosClient records whatever options it is handed, so the fake
    // tier cannot tell a well-formed option bag from a rejected one. Only the
    // real constructor can.
    const client = await createRealClient({
      endpoint: ENDPOINT,
      authMode: 'key',
      key: Buffer.from('sdk-tier-key-must-not-leak').toString('base64'),
    });

    assert.equal(client.constructor.name, 'CosmosClient');
  });
});
