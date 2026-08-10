#!/usr/bin/env node
// MeatGeek — V1 Cosmos DB export CLI (MG-48).
//
//   node apps/infrastructure/scripts/cosmos-export/cosmos-export.mjs \
//     --account meatgeek --out ./v1-export
//   node apps/infrastructure/scripts/cosmos-export/cosmos-export.mjs \
//     --account meatgeek --out ./v1-export --verify
//
// Plain ESM, no build step: this runs once, from an operator's workstation,
// immediately before an irreversible deletion. `node <file>` with the
// repo's already-present @azure/cosmos is the shortest path between the
// operator and the data, and nothing to transpile is one fewer thing to be
// wrong at the moment it matters. There is deliberately NO shell wrapper —
// this repo has already shipped two bash 3.2 parse defects, and a wrapper
// would add that risk for nothing.
//
// Exit codes (the operator scripts around these):
//   0  verified-complete       3  throttling abort (429, retries exhausted)
//   1  usage error             4  auth failure
//   2  reconciliation failure  5  transport/IO abort
//
// See --help for auth. The account key is read from COSMOS_EXPORT_KEY and is
// never accepted as a CLI argument, never logged, and never written to disk.

import { pathToFileURL } from 'node:url';
import {
  EXIT,
  ExportError,
  TOOL_NAME,
  TOOL_VERSION,
  classifyError,
  defaultLog,
  describeError,
  exitLabel,
  readManifestFilters,
  runExport,
  runVerify,
} from './export-core.mjs';

const USAGE = `${TOOL_NAME} ${TOOL_VERSION} — read-only, count-reconciled export of a Cosmos DB (SQL/Core) account.

USAGE
  cosmos-export.mjs --account <name> --out <dir> [--database <id>]... [--container <id>]...
  cosmos-export.mjs --account <name> --out <dir> --verify

ACCOUNT
  --account <name>     Account name; endpoint is derived as https://<name>.documents.azure.com:443/
  --endpoint <url>     Full endpoint, instead of --account
                       (env: COSMOS_EXPORT_ACCOUNT / COSMOS_EXPORT_ENDPOINT)

MODE
  --out <dir>          Output directory. Required. Holds one JSONL file per
                       container plus manifest.json.
  --verify             Re-check an existing export in --out against the live
                       account: on-disk hashes, byte sizes and line counts
                       against the manifest, and live counts against what was
                       exported. This is what you run immediately before the
                       deletion.
  --force              Replace a completed export already present in --out.

SCOPE
  --database <id>      Only this database. Repeatable. Default: every database.
                       A filtered run addresses the database directly and makes
                       no account-level call, so it needs only a /dbs/<id>-scoped
                       role assignment — see RBAC SCOPE under AUTH.
  --container <id>     Only this container. Repeatable. Default: every container.
                       Passed WITH --database, the container is addressed
                       directly too. Passed alone it still costs account scope:
                       finding a container in an unnamed database means listing
                       the account's databases.
  --page-size <n>      Documents per page request (default 1000).

AUTH
  --auth key           Account key from the COSMOS_EXPORT_KEY environment
                       variable. The default when that variable is set, and the
                       pragmatic choice for V1 (disableLocalAuth is false).
                       The key is NEVER a CLI argument — arguments leak into
                       shell history and into 'ps' output for every user on the
                       box — and is never written to the manifest or the logs.

                         export COSMOS_EXPORT_KEY="$(az cosmosdb keys list \\
                           -n meatgeek -g MeatGeek-Shared \\
                           --query primaryReadonlyMasterKey -o tsv)"

                       Prefer the READ-ONLY key: this tool only reads, and a
                       read-only key makes that true of the credential too.
  --auth aad           Azure Entra ID via DefaultAzureCredential (az login,
                       managed identity, env service principal). The default
                       when COSMOS_EXPORT_KEY is unset, and the ONLY mode that
                       works against an account with disableLocalAuth: true,
                       where the service refuses key auth outright.

                       Cosmos data-plane access is NOT granted by control-plane
                       RBAC. Subscription Owner is not sufficient — with Owner
                       and no data-plane assignment every request here comes
                       back 403. That 403 reads like a tool bug and is not;
                       assign yourself a data-plane role:

                         az cosmosdb sql role assignment create \\
                           --account-name <account-name> \\
                           --resource-group <resource-group> \\
                           --role-definition-id \\
                             00000000-0000-0000-0000-000000000001 \\
                           --principal-id <principal-object-id> \\
                           --scope "<see RBAC SCOPE below>"

                       ...0001 is the built-in Cosmos DB Data READER, which is
                       all this tool needs. Your own principal id is
                       'az ad signed-in-user show --query id -o tsv'.
                       Assignments take a minute or two to propagate.

                       Any authorization failure — a 403 from a missing
                       assignment, or a credential that cannot be acquired at
                       all — exits 4, the same as a key-auth 401.

  RBAC SCOPE           The --scope of that assignment is part of this tool's
                       contract, because what the tool reads depends on how the
                       run is filtered. Grant the NARROWEST that covers the run:

                         no --database          "/"
                           A full-account export lists the account's databases,
                           which only account scope permits.

                         --database <db>        "/dbs/<db>"
                           Repeat the --scope per database if you pass more than
                           one --database. The run addresses each database by id
                           and never asks the account what it holds.

                         --database <db>
                           --container <c>      "/dbs/<db>/colls/<c>"
                           With both flags the run addresses the container
                           directly and makes no database- or account-level call
                           — until a container metadata read comes back 404. An
                           absence is then corroborated against the database's
                           container list (see BEHAVIOUR), which that scope does
                           not cover, so a container that is NOT there under this
                           grant exits 4 rather than 1. Grant /dbs/<db> if you
                           need a missing container reported as a usage error.
                           This is proven against the test fake, NOT yet against
                           a live account — if a container-scoped grant 403s,
                           widen to /dbs/<db> and file it.

                       A scope too narrow for the run fails fast with exit 4 and
                       reads 'Request blocked by Auth ... on any scope'; it does
                       NOT silently fall back to a wider read.

BEHAVIOUR
  Every container's count is read (SELECT VALUE COUNT(1) FROM c) before export
  and compared against the documents actually written. A mismatch, a 429 whose
  retries are exhausted, or any transport error mid-pagination ABORTS with a
  non-zero exit. Nothing is skipped to keep going, and a container that did not
  reconcile is left as a *.jsonl.partial file that no manifest vouches for.

  Nothing is skipped applies to metadata reads too. A container named with
  --database/--container is passed over ONLY when the service proves it is not
  there: an unambiguous 404 — that HTTP status AND the not-found resource code
  — which the parent database's own container list then confirms. Anything else
  ABORTS with no manifest written: a 403 or 401 carrying a not-found code (exit
  4), a throttle (3), a 404 the database contradicts by still listing the
  container, and a 404 whose absence cannot be corroborated (5, or the failure's
  own code). A single 404 is never taken as proof on its own.

  The manifest records what the run was ASKED for and every requested target it
  proved absent, so --verify holds the export to that request: a manifest that
  neither exports a requested container nor records it as absent FAILS
  verification, even when the account no longer holds the container either.

  This tool never creates, updates, upserts, patches or deletes anything.

EXIT CODES
  0 verified-complete   1 usage error   2 reconciliation failure
  3 throttling abort    4 auth failure  5 transport/IO abort
`;

const FLAGS_WITH_VALUES = new Set([
  '--out',
  '--database',
  '--container',
  '--endpoint',
  '--account',
  '--auth',
  '--page-size',
]);

export function parseArgs(argv) {
  const cfg = {
    out: null,
    databases: [],
    containers: [],
    endpoint: null,
    account: null,
    auth: null,
    pageSize: 1000,
    verify: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let flag = arg;
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    if (flag === '--key' || flag === '--account-key' || flag === '--master-key') {
      throw new ExportError(
        EXIT.USAGE,
        `${flag} is not accepted — a key passed as an argument lands in shell history and in 'ps' output. Set COSMOS_EXPORT_KEY instead.`
      );
    }

    let value = inlineValue;
    if (FLAGS_WITH_VALUES.has(flag) && value === null) {
      value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith('--')) {
        throw new ExportError(EXIT.USAGE, `${flag} needs a value`);
      }
    }

    switch (flag) {
      case '--out':
        cfg.out = value;
        break;
      case '--database':
        cfg.databases.push(value);
        break;
      case '--container':
        cfg.containers.push(value);
        break;
      case '--endpoint':
        cfg.endpoint = value;
        break;
      case '--account':
        cfg.account = value;
        break;
      case '--auth':
        if (value !== 'key' && value !== 'aad') {
          throw new ExportError(EXIT.USAGE, `--auth must be 'key' or 'aad', got '${value}'`);
        }
        cfg.auth = value;
        break;
      case '--page-size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new ExportError(
            EXIT.USAGE,
            `--page-size must be a positive integer, got '${value}'`
          );
        }
        cfg.pageSize = n;
        break;
      }
      case '--verify':
        cfg.verify = true;
        break;
      case '--force':
        cfg.force = true;
        break;
      case '--help':
      case '-h':
        cfg.help = true;
        break;
      default:
        throw new ExportError(EXIT.USAGE, `unknown argument '${arg}'`);
    }
  }
  return cfg;
}

export function resolveEndpoint(cfg, env) {
  const explicit = cfg.endpoint ?? env.COSMOS_EXPORT_ENDPOINT;
  if (explicit) return explicit;
  const account = cfg.account ?? env.COSMOS_EXPORT_ACCOUNT;
  if (account) return `https://${account}.documents.azure.com:443/`;
  throw new ExportError(
    EXIT.USAGE,
    'no account — pass --account <name> or --endpoint <url> (or set COSMOS_EXPORT_ACCOUNT / COSMOS_EXPORT_ENDPOINT)'
  );
}

function accountNameFrom(endpoint) {
  try {
    return new URL(endpoint).hostname.split('.')[0];
  } catch {
    throw new ExportError(EXIT.USAGE, `--endpoint is not a URL: '${endpoint}'`);
  }
}

// The two SDK modules are loaded through injectable thunks for the same reason
// the client itself is injected into main(): it is the only way to assert what
// the auth wiring actually hands to CosmosClient — that aad mode passes a
// credential and no key, and key mode the reverse — without an Azure account.
export async function createRealClient({
  endpoint,
  authMode,
  key,
  databaseScoped = false,
  loadCosmos = () => import('@azure/cosmos'),
  loadIdentity = () => import('@azure/identity'),
}) {
  const { CosmosClient } = await loadCosmos();
  const connectionPolicy = {
    retryOptions: {
      maxRetryAttemptCount: 9,
      fixedRetryIntervalInMilliseconds: 0,
      maxWaitTimeInSeconds: 60,
    },
    // MG-49: with endpoint discovery on — the SDK default — the client reads the
    // DATABASE ACCOUNT before it issues its first data request, to learn which
    // regions the account can be read from. That probe is 'Read DatabaseAccount',
    // an ACCOUNT-scoped operation, and it is the call a /dbs/<database>-scoped
    // Data Reader is refused for, before anything the operator actually asked for
    // is attempted. Not enumerating databases is therefore necessary but not
    // sufficient; the SDK's own account probe has to go too. A filtered run talks
    // to the endpoint it was given and never asks the account about itself. The
    // cost is cross-region read failover, which a single-endpoint read-only
    // export does not use. An unfiltered run needs account scope regardless, so
    // it keeps discovery exactly as it was.
    enableEndpointDiscovery: !databaseScoped,
  };
  if (authMode === 'key') {
    return new CosmosClient({ endpoint, key, connectionPolicy });
  }
  const { DefaultAzureCredential } = await loadIdentity();
  return new CosmosClient({
    endpoint,
    aadCredentials: new DefaultAzureCredential(),
    connectionPolicy,
  });
}

export async function main({ argv, env, createClient = createRealClient, log = defaultLog }) {
  try {
    const cfg = parseArgs(argv);
    if (cfg.help) {
      log.info(USAGE);
      return EXIT.OK;
    }
    if (!cfg.out) {
      throw new ExportError(EXIT.USAGE, '--out <dir> is required');
    }

    const endpoint = resolveEndpoint(cfg, env);
    const accountName = accountNameFrom(endpoint);
    const key = env.COSMOS_EXPORT_KEY ?? '';
    const authMode = cfg.auth ?? (key ? 'key' : 'aad');
    if (authMode === 'key' && !key) {
      throw new ExportError(
        EXIT.AUTH,
        '--auth key needs the account key in COSMOS_EXPORT_KEY (it is never taken as a CLI argument)'
      );
    }

    const scopedDatabases = cfg.verify
      ? ((await readManifestFilters(cfg.out)).databases ?? [])
      : cfg.databases;
    const client = await createClient({
      endpoint,
      authMode,
      key,
      databaseScoped: scopedDatabases.length > 0,
    });
    if (cfg.verify) {
      await runVerify({ client, outDir: cfg.out, log });
    } else {
      await runExport({
        client,
        outDir: cfg.out,
        endpoint,
        accountName,
        authMode,
        databases: cfg.databases,
        containers: cfg.containers,
        pageSize: cfg.pageSize,
        force: cfg.force,
        log,
      });
    }
    return EXIT.OK;
  } catch (err) {
    const error =
      err instanceof ExportError ? err : new ExportError(classifyError(err), describeError(err));
    log.error(`${TOOL_NAME}: ${error.message}`);
    log.error(`${TOOL_NAME}: exit ${error.exitCode} (${exitLabel(error.exitCode)})`);
    return error.exitCode;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env });
}
