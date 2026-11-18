import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';

import { REQUEST_CHARGE_HEADER } from '../../src/shared/cosmos/request-charge';
import {
  AcceptanceApi,
  AcceptanceResponse,
  HttpMethod,
  Proof,
  ProofFailure,
  ProofGroup,
  RequestOptions,
} from './proof';

/**
 * HAR-11 — the live acceptance runner. Runs every proof group found in
 * `../proofs` against the deployed API named by ACCEPTANCE_BASE_URL, as the
 * caller whose token is ACCEPTANCE_BEARER_TOKEN, and reports per request and
 * per route. It never prints the token or any header carrying it: every output
 * line passes through a redactor that masks the token value as well.
 */

export const REQUIRED_ENV = ['ACCEPTANCE_BASE_URL', 'ACCEPTANCE_BEARER_TOKEN'] as const;

export const PROOFS_DIR = join(__dirname, '..', 'proofs');

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Receives each output line (no trailing newline). */
  readonly write: (line: string) => void;
  /** Defaults to every `*.proof.ts` / `*.proof.js` in {@link PROOFS_DIR}. */
  readonly groups?: readonly ProofGroup[];
  readonly timeoutMs?: number;
  readonly runId?: string;
}

export interface RunResult {
  readonly exitCode: number;
  /** One line per failed proof, already redacted. */
  readonly failures: readonly string[];
}

interface RouteTotals {
  calls: number;
  charged: number;
  totalRu: number;
}

/** Load every proof file in `dir`, in file-name order. */
export function loadProofGroups(dir: string = PROOFS_DIR): ProofGroup[] {
  return readdirSync(dir)
    .filter(file => /\.proof\.[jt]s$/.test(file) && !file.endsWith('.d.ts'))
    .sort()
    .map(file => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(join(dir, file)) as { default?: ProofGroup };
      const group = loaded.default;
      if (!group || typeof group.create !== 'function' || typeof group.name !== 'string') {
        throw new Error(`${file} must default-export defineProofs(name, create)`);
      }
      return group;
    });
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ]/g, '')
    .slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** RU rounded to two decimals, without trailing zeros (`20.1`, `7.42`, `3`). */
function formatRu(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
    return `${error.message}${code}`;
  }
  return String(error);
}

/** The `error` code of a JSON error body (e.g. `COOK_ALREADY_ACTIVE`), for
 *  failure context. Only a bare upper-case code is reported, never free text,
 *  so a server that echoes request data cannot put it in the output. */
function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export async function runAcceptance(options: RunOptions): Promise<RunResult> {
  const env = options.env;
  const missing = REQUIRED_ENV.filter(name => !env[name] || env[name]?.trim() === '');
  if (missing.length > 0) {
    const failures = missing.map(
      name => `acceptance: ${name} is not set; the live acceptance run needs it`
    );
    failures.forEach(line => options.write(line));
    return { exitCode: 2, failures };
  }

  const token = (env['ACCEPTANCE_BEARER_TOKEN'] as string).trim();
  const rawBaseUrl = (env['ACCEPTANCE_BASE_URL'] as string).trim();
  const write = (line: string) => options.write(line.split(token).join('[redacted]'));

  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('not http(s)');
    }
    baseUrl = rawBaseUrl.replace(/\/+$/, '');
  } catch {
    const line = 'acceptance: ACCEPTANCE_BASE_URL is not an http(s) URL';
    write(line);
    return { exitCode: 2, failures: [line] };
  }

  const runId = options.runId ?? newRunId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const groups = options.groups ?? loadProofGroups();
  const totals = new Map<string, RouteTotals>();
  const failures: string[] = [];
  let passed = 0;
  let skipped = 0;

  write(`acceptance run ${runId} against ${baseUrl}`);

  /** The request in flight for the current proof, so an unexpected throw
   *  (network error, timeout, bad JSON) is still attributed to a route. */
  let lastRequest: { method: HttpMethod; route: string; status?: number } | undefined;

  const api: AcceptanceApi = {
    runId,

    async request<T>(request: RequestOptions): Promise<AcceptanceResponse<T>> {
      const authenticated = request.authenticated ?? true;
      const expectCharge = request.expectRequestCharge ?? true;
      const route = request.route ?? request.path.split('?')[0];
      lastRequest = { method: request.method, route };

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authenticated) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const started = performance.now();
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const latencyMs = Math.round(performance.now() - started);
      lastRequest.status = response.status;

      let body: unknown = text;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON — keep the text
        }
      }

      const chargeHeader = response.headers.get(REQUEST_CHARGE_HEADER);
      const parsedCharge = chargeHeader === null ? NaN : Number(chargeHeader);
      const requestCharge =
        chargeHeader !== null && chargeHeader.trim() !== '' && Number.isFinite(parsedCharge)
          ? parsedCharge
          : undefined;

      const key = `${request.method} ${route}${authenticated ? '' : ' (no auth)'}`;
      const entry = totals.get(key) ?? { calls: 0, charged: 0, totalRu: 0 };
      entry.calls += 1;
      if (requestCharge !== undefined) {
        entry.charged += 1;
        entry.totalRu += requestCharge;
      }
      totals.set(key, entry);

      write(
        `  ${request.method.padEnd(6)} ${route.padEnd(30)} ${String(response.status).padEnd(4)}` +
          ` ${`${latencyMs} ms`.padStart(8)}  RU ${requestCharge === undefined ? '-' : formatRu(requestCharge)}`
      );

      const result: AcceptanceResponse<T> = {
        method: request.method,
        route,
        status: response.status,
        latencyMs,
        requestCharge,
        headers: response.headers,
        body: body as T,
      };

      if (expectCharge && requestCharge === undefined) {
        const code = errorCodeOf(body);
        throw new ProofFailure(
          (chargeHeader === null
            ? `missing ${REQUEST_CHARGE_HEADER} header`
            : `${REQUEST_CHARGE_HEADER} header is not a number`) + (code ? ` (${code})` : ''),
          result
        );
      }
      return result;
    },

    expectStatus(response, expected) {
      const ok =
        expected === '2xx'
          ? response.status >= 200 && response.status < 300
          : response.status === expected;
      if (!ok) {
        const code = errorCodeOf(response.body);
        throw new ProofFailure(
          `expected ${expected}, got ${response.status}${code ? ` (${code})` : ''}`,
          response
        );
      }
    },

    check(response, condition, message): asserts condition {
      if (!condition) {
        throw new ProofFailure(message, response);
      }
    },
  };

  for (const group of groups) {
    let proofs: readonly Proof[];
    try {
      proofs = group.create();
    } catch (error) {
      const line = `FAIL ${group.name} — could not create proofs: ${describeError(error)}`;
      write(line);
      failures.push(line);
      continue;
    }

    let groupFailed = false;
    for (const proof of proofs) {
      const label = `${group.name} › ${proof.name}`;
      if (groupFailed) {
        skipped += 1;
        write(`SKIP ${label} (an earlier proof in this group failed)`);
        continue;
      }

      lastRequest = undefined;
      write(`RUN  ${label}`);
      try {
        await proof.run(api);
        passed += 1;
        write(`PASS ${label}`);
      } catch (error) {
        groupFailed = true;
        const at = error instanceof ProofFailure && error.response ? error.response : lastRequest;
        const where = at
          ? `${at.method} ${at.route} → ${at.status === undefined ? 'no response' : at.status}`
          : 'before any request';
        const line = `FAIL ${label} — ${where}: ${describeError(error)}`;
        write(line);
        failures.push(line.split(token).join('[redacted]'));
      }
    }
  }

  write('');
  write('RU per route');
  write(
    `  ${'ROUTE'.padEnd(40)} ${'CALLS'.padStart(5)} ${'RU TOTAL'.padStart(9)} ${'RU AVG'.padStart(8)}`
  );
  for (const [route, entry] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = entry.charged > 0 ? formatRu(entry.totalRu) : '-';
    const avg = entry.charged > 0 ? formatRu(entry.totalRu / entry.charged) : '-';
    write(
      `  ${route.padEnd(40)} ${String(entry.calls).padStart(5)} ${total.padStart(9)} ${avg.padStart(8)}`
    );
  }
  write('');
  write(
    `acceptance: ${passed} passed, ${failures.length} failed, ${skipped} skipped` +
      (failures.length > 0 ? '' : ' — all proofs green')
  );

  return { exitCode: failures.length > 0 ? 1 : 0, failures };
}
