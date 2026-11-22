/**
 * HAR-111 — where the Cosmos emulator tier (`*.emulator.spec.ts`) keeps its data.
 *
 * Every emulator spec, in every run and every concurrent copy of the suite, uses
 * ONE database and ONE container per Terraform container: a shared-throughput
 * database, as the deployed one is (`meatgeek_shared` in
 * apps/infrastructure/modules/cosmos-db/main.tf: one 400 RU/s offer, containers
 * with no throughput of their own), holding containers under their Terraform
 * names. They are created on first use and never deleted; the CI emulator is
 * thrown away with its job.
 *
 * Why: the emulator runs with a small, fixed number of partitions
 * (PartitionCount in .github/scripts/cosmos-emulator.ps1, which ci.yml and
 * test-repeat.yml both use). A database and container per spec file ran it out
 * under eight concurrent copies (503 "high demand in this region"). A fixed set
 * of containers costs the same partitions however many copies or runs use it.
 * (The ECONNREFUSED after a few repeated runs was the classic Linux emulator
 * image crashing natively, not the layout: HAR-113, docs/development/ci-cd.md.)
 *
 * Sharing is safe because every case keys its data by a fresh random user or
 * device id (the partition key) and reads only inside it.
 *
 * HAR-124 — sharing also means a copy can lose the create race: its
 * `createIfNotExists` returns (or 409s) while the winner's create is still in
 * progress, and a read then answers 404 with sub-status 1013 ("Collection is not
 * yet available for read"). So both helpers return only once the resource is
 * readable: they await `read()` back to back while, and only while, the answer is
 * 404/1013. There is no deadline of their own; the hang guard is `testTimeout` in
 * jest.emulator.config.ts, and `closeEmulatorTier` (each spec's `afterAll`) names
 * the resource a timed-out wait was still waiting for.
 */
import type { ContainerRequest, CosmosClient, Database } from '@azure/cosmos';

/** The tier's one database. */
export const EMULATOR_TIER_DATABASE = 'meatgeek-emulator-tier';

/** Same offer as the deployed shared database. */
const SHARED_THROUGHPUT = 400;

/**
 * The emulator's answer to a read of a database or container whose create has
 * been accepted but not finished: 404 with sub-status 1013, "Collection create
 * operation is in progress" in
 * https://learn.microsoft.com/rest/api/cosmos-db/http-status-codes-for-cosmosdb.
 */
const NOT_FOUND = 404;
const CREATE_IN_PROGRESS_SUBSTATUS = 1013;

interface CosmosErrorShape {
  readonly code?: unknown;
  readonly statusCode?: unknown;
  readonly substatus?: unknown;
  readonly message?: unknown;
}

function statusOf(error: unknown): unknown {
  const { code, statusCode } = (error ?? {}) as CosmosErrorShape;
  return code ?? statusCode;
}

function isConflict(error: unknown): boolean {
  return statusOf(error) === 409;
}

/** True only for the emulator's "create still in progress" answer (404/1013). */
export function isCreateInProgress(error: unknown): boolean {
  const { substatus } = (error ?? {}) as CosmosErrorShape;
  return statusOf(error) === NOT_FOUND && Number(substatus) === CREATE_IN_PROGRESS_SUBSTATUS;
}

function describeCosmosError(error: unknown): string {
  const { substatus, message } = (error ?? {}) as CosmosErrorShape;
  const status = statusOf(error);
  const codes =
    status === undefined
      ? ''
      : substatus === undefined
        ? `${String(status)}: `
        : `${String(status)}/${String(substatus)}: `;
  return `${codes}${typeof message === 'string' ? message : String(error)}`;
}

interface ReadinessWait {
  readonly what: string;
  inProgressAnswers: number;
  abandoned: boolean;
}

/** Waits still running, so a hang-guard timeout can be reported by name. */
const pendingWaits = new Set<ReadinessWait>();

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Resolves once `read()` succeeds. Loops only on 404/1013, yielding a turn of
 * the event loop between reads; any other error rejects at once, naming `what`.
 */
export async function awaitReadable(what: string, read: () => Promise<unknown>): Promise<void> {
  const wait: ReadinessWait = { what, inProgressAnswers: 0, abandoned: false };
  pendingWaits.add(wait);
  try {
    for (;;) {
      try {
        await read();
        return;
      } catch (error) {
        if (wait.abandoned) {
          return;
        }
        if (!isCreateInProgress(error)) {
          throw new Error(
            `Cosmos emulator: ${what} did not become readable (${describeCosmosError(error)})`
          );
        }
        wait.inProgressAnswers += 1;
      }
      await nextTurn();
      if (wait.abandoned) {
        return;
      }
    }
  } finally {
    pendingWaits.delete(wait);
  }
}

/**
 * The tier's shared-throughput database, created if it is missing and readable
 * on return. Another copy creating it between this copy's read and its create
 * is a 409: it now exists, and may still be being created.
 */
export async function emulatorTierDatabase(client: CosmosClient): Promise<Database> {
  let database: Database;
  try {
    ({ database } = await client.databases.createIfNotExists({
      id: EMULATOR_TIER_DATABASE,
      throughput: SHARED_THROUGHPUT,
    }));
  } catch (error) {
    if (!isConflict(error)) {
      throw error;
    }
    database = client.database(EMULATOR_TIER_DATABASE);
  }
  await awaitReadable(`database ${EMULATOR_TIER_DATABASE}`, () => database.read());
  return database;
}

/**
 * Creates a container in the tier database if it is missing, with no throughput
 * of its own, and returns once it is readable. A 409 means another copy created
 * it first, with the same Terraform-derived definition, and may not have
 * finished: this copy waits for it all the same.
 */
export async function createEmulatorContainer(
  database: Database,
  request: ContainerRequest
): Promise<void> {
  const id = request.id;
  if (!id) {
    throw new Error('createEmulatorContainer needs a container id');
  }
  try {
    await database.containers.createIfNotExists(request);
  } catch (error) {
    if (!isConflict(error)) {
      throw error;
    }
  }
  await awaitReadable(`container ${id} in database ${database.id}`, () =>
    database.container(id).read()
  );
}

/**
 * Each emulator spec's `afterAll`. Disposes the client and, if a readiness wait
 * is still running (the hook that started it hit `testTimeout`), stops it and
 * fails naming what it was waiting for: Jest's own timeout message names no
 * container.
 */
export function closeEmulatorTier(client: CosmosClient | undefined): void {
  const stillWaiting = [...pendingWaits];
  for (const wait of stillWaiting) {
    wait.abandoned = true;
    pendingWaits.delete(wait);
  }
  client?.dispose();
  if (stillWaiting.length > 0) {
    const names = stillWaiting
      .map(wait => `${wait.what} (${wait.inProgressAnswers} "create in progress" answers so far)`)
      .join('; ');
    throw new Error(`Cosmos emulator: still waiting for ${names} when the hook timed out`);
  }
}
