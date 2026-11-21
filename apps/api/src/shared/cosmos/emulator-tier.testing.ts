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
 * (AZURE_COSMOS_EMULATOR_PARTITION_COUNT in ci.yml and test-repeat.yml). A
 * database and container per spec file ran it out under eight concurrent copies
 * (503 "high demand in this region"), and the create/delete churn of repeated
 * runs brought the emulator down (ECONNREFUSED after a few runs). A fixed set of
 * containers costs the same partitions however many copies or runs use it.
 *
 * Sharing is safe because every case keys its data by a fresh random user or
 * device id (the partition key) and reads only inside it.
 */
import type { ContainerRequest, CosmosClient, Database } from '@azure/cosmos';

/** The tier's one database. */
export const EMULATOR_TIER_DATABASE = 'meatgeek-emulator-tier';

/** Same offer as the deployed shared database. */
const SHARED_THROUGHPUT = 400;

function isConflict(error: unknown): boolean {
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  return code === 409 || statusCode === 409;
}

/**
 * The tier's shared-throughput database, created if it is missing. Another copy
 * creating it between this copy's read and its create is a 409: it now exists.
 */
export async function emulatorTierDatabase(client: CosmosClient): Promise<Database> {
  try {
    const { database } = await client.databases.createIfNotExists({
      id: EMULATOR_TIER_DATABASE,
      throughput: SHARED_THROUGHPUT,
    });
    return database;
  } catch (error) {
    if (isConflict(error)) {
      return client.database(EMULATOR_TIER_DATABASE);
    }
    throw error;
  }
}

/**
 * Creates a container in the tier database if it is missing, with no throughput
 * of its own. A 409 means another copy created it first, with the same
 * Terraform-derived definition.
 */
export async function createEmulatorContainer(
  database: Database,
  request: ContainerRequest
): Promise<void> {
  try {
    await database.containers.createIfNotExists(request);
  } catch (error) {
    if (!isConflict(error)) {
      throw error;
    }
  }
}
