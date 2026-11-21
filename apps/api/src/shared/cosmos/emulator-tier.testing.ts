/**
 * HAR-111 — where the Cosmos emulator tier (`*.emulator.spec.ts`) keeps its data.
 *
 * Every emulator spec, in every concurrent copy of the suite, uses ONE database:
 * a shared-throughput database, as the deployed one is (`meatgeek_shared` in
 * apps/infrastructure/modules/cosmos-db/main.tf: one 400 RU/s offer, containers
 * with no throughput of their own). Each spec file creates its containers inside
 * it under names unique to that file's run, and deletes them afterwards.
 *
 * Why not a database per file: the emulator runs with a small, fixed number of
 * partitions (AZURE_COSMOS_EMULATOR_PARTITION_COUNT in ci.yml and
 * test-repeat.yml). A dedicated-throughput container takes a partition of its
 * own, so eight copies of the suite at once ran it out ("high demand in this
 * region", 503) and repeated create/delete of whole databases brought it down.
 * Containers in one shared-throughput database share its partition.
 */
import { randomUUID } from 'crypto';

import type { CosmosClient, Database } from '@azure/cosmos';

/** The tier's one database. Never deleted: the CI emulator is thrown away with its job. */
export const EMULATOR_TIER_DATABASE = 'meatgeek-emulator-tier';

/** Same offer as the deployed shared database. */
const SHARED_THROUGHPUT = 400;

/** Unique to this spec file's module registry, so concurrent copies never share a container. */
const RUN_SUFFIX = randomUUID();

/** This file run's container id for a Terraform container name. Same input, same id. */
export function emulatorContainerId(terraformName: string): string {
  return `${terraformName}-${RUN_SUFFIX}`;
}

function statusCodeOf(error: unknown): unknown {
  return (
    (error as { code?: unknown; statusCode?: unknown }).code ??
    (error as { statusCode?: unknown }).statusCode
  );
}

/**
 * The tier's shared-throughput database, created if it is missing. Another copy
 * creating it between this copy's read and its create is a 409, which means it
 * now exists.
 */
export async function emulatorTierDatabase(client: CosmosClient): Promise<Database> {
  try {
    const { database } = await client.databases.createIfNotExists({
      id: EMULATOR_TIER_DATABASE,
      throughput: SHARED_THROUGHPUT,
    });
    return database;
  } catch (error) {
    if (statusCodeOf(error) === 409) {
      return client.database(EMULATOR_TIER_DATABASE);
    }
    throw error;
  }
}

/** Deletes this file run's containers; a container that is already gone is fine. */
export async function deleteEmulatorContainers(
  client: CosmosClient,
  terraformNames: readonly string[]
): Promise<void> {
  const database = client.database(EMULATOR_TIER_DATABASE);
  for (const name of terraformNames) {
    await database
      .container(emulatorContainerId(name))
      .delete()
      .catch(() => undefined);
  }
}
