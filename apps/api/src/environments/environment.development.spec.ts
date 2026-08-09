/**
 * MG-51 — COSMOSDB_DATABASE_NAME has no application default, and must not
 * regrow one.
 *
 * The removed fallback was `meatgeek-dev`, a database that has never existed in
 * this stack; the API answered requests against it for as long as the setting
 * was missing. Terraform owns the real name and MG-53 will change it during a
 * migration cutover, so any value spelled here is either wrong now or wrong
 * later. These tests hold the "fail loudly" decision in place.
 */
import * as fs from 'fs';
import * as path from 'path';

const DEV_ENV_FILE = path.join(__dirname, 'environment.development.ts');

function loadDevEnvironment(databaseName?: string) {
  jest.resetModules();
  if (databaseName === undefined) {
    delete process.env['COSMOSDB_DATABASE_NAME'];
  } else {
    process.env['COSMOSDB_DATABASE_NAME'] = databaseName;
  }
  return require('./environment.development') as typeof import('./environment.development');
}

describe('MG-51: the dev API refuses to guess its Cosmos database', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('throws when COSMOSDB_DATABASE_NAME is unset, naming infrastructure as the owner', () => {
    expect(() => loadDevEnvironment(undefined)).toThrow(/COSMOSDB_DATABASE_NAME/);
    expect(() => loadDevEnvironment(undefined)).toThrow(/Terraform/);
  });

  it('throws rather than accepting an empty setting', () => {
    expect(() => loadDevEnvironment('')).toThrow(/COSMOSDB_DATABASE_NAME/);
  });

  it('uses whatever Terraform published, with no rewriting', () => {
    const { environment } = loadDevEnvironment('meatgeek-v2-dev-db');
    expect(environment.cosmosDb.databaseName).toBe('meatgeek-v2-dev-db');

    // Deliberately a name this repo has never seen: the config layer must carry
    // the infrastructure value through, so MG-53's cutover is a Terraform edit
    // and nothing here needs to move with it.
    const { environment: migrated } = loadDevEnvironment('some-other-db');
    expect(migrated.cosmosDb.databaseName).toBe('some-other-db');
  });

  it('spells no database name of its own', () => {
    // Only the databaseName assignment is in question — the file legitimately
    // carries `meatgeek-dev-iothub` in an unrelated local fallback, and the
    // block comment above it quotes the removed default by name.
    const source = fs.readFileSync(DEV_ENV_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const assignment = source.match(/databaseName:.*$/m)?.[0] ?? '';
    expect(assignment).toBe("databaseName: requiredFromInfrastructure('COSMOSDB_DATABASE_NAME'),");
  });
});
