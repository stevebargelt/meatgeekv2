import { spawn } from 'child_process';
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
  SimDeviceRun,
} from './proof';

/**
 * HAR-11 — the live acceptance runner. Runs every proof group found in
 * `../proofs` against the deployed API named by ACCEPTANCE_BASE_URL, as the
 * caller whose token is ACCEPTANCE_BEARER_TOKEN, and reports per request and
 * per route. It never prints the token or any header carrying it: every output
 * line passes through a redactor that masks the token value as well.
 *
 * HAR-44: it also runs `simdevice` (ACCEPTANCE_SIMDEVICE_BIN) for proofs, as the
 * simulated device ACCEPTANCE_SIM_DEVICE_ID. The device credential,
 * SIMDEVICE_CONNECTION_STRING, is read here and nowhere else: the child inherits
 * it through its environment, never its command line, and the redactor masks
 * both the whole connection string and its SharedAccessKey value.
 */

export const REQUIRED_ENV = [
  'ACCEPTANCE_BASE_URL',
  'ACCEPTANCE_BEARER_TOKEN',
  'SIMDEVICE_CONNECTION_STRING',
  'ACCEPTANCE_SIM_DEVICE_ID',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

export const PROOFS_DIR = join(__dirname, '..', 'proofs');

const DEFAULT_TIMEOUT_MS = 60_000;

/** A `simdevice` run longer than this is killed. One reading takes seconds. */
const SIMDEVICE_TIMEOUT_MS = 120_000;

const REDACTED = '[redacted]';

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

/**
 * A function masking every secret in a line: the bearer token, the device
 * connection string, and its SharedAccessKey value (with and without the
 * `SharedAccessKey=` prefix). Longest first, so a whole connection string is
 * one mask rather than a mangled partial.
 */
export function makeRedactor(token: string, connectionString: string): (line: string) => string {
  const key = connectionString
    .split(';')
    .map(part => part.trim())
    .find(part => /^SharedAccessKey=/i.test(part))
    ?.slice('SharedAccessKey='.length);
  const secrets = [token, connectionString, ...(key ? [`SharedAccessKey=${key}`, key] : [])]
    .filter(secret => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  return line => secrets.reduce((masked, secret) => masked.split(secret).join(REDACTED), line);
}

/** Run `bin` with `args`, reducing its output to a {@link SimDeviceRun}. */
function runChild(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  redact: (line: string) => string
): Promise<{ readonly run: SimDeviceRun; readonly durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    // stdio is piped, never inherited: nothing the child prints reaches the log raw.
    const child = spawn(bin, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), SIMDEVICE_TIMEOUT_MS);
    child.on('error', error => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new Error(`simdevice could not be started${code ? ` (${code})` : ''}`));
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      const messages: unknown[] = [];
      let unparsedLines = 0;
      for (const line of Buffer.concat(stdout).toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          unparsedLines += 1;
        }
      }
      const first = Buffer.concat(stderr)
        .toString('utf8')
        .split('\n')
        .find(line => line.trim() !== '');
      resolve({
        run: {
          exitCode,
          messages,
          unparsedLines,
          stderrFirstLine: first === undefined ? undefined : redact(first.trim()),
        },
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
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
  const connectionString = (env['SIMDEVICE_CONNECTION_STRING'] as string).trim();
  const simulatedDeviceId = (env['ACCEPTANCE_SIM_DEVICE_ID'] as string).trim();
  const simdeviceBin = (env['ACCEPTANCE_SIMDEVICE_BIN'] as string).trim();
  const redact = makeRedactor(token, connectionString);
  const write = (line: string) => options.write(redact(line));

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
  /** Set while a proof's last action was a simdevice run, for the same reason. */
  let lastExec: { exitCode?: number | null } | undefined;

  /** `simdevice → exit N` when the proof's last action was a simdevice run.
   *  (A function, so the compiler does not narrow lastExec across `await`.) */
  const execWhere = (): string | undefined => {
    if (!lastExec) return undefined;
    const { exitCode } = lastExec;
    return `simdevice → ${exitCode === undefined ? 'not started' : `exit ${exitCode ?? 'killed'}`}`;
  };

  // The child gets the runner's own environment for PATH and tracing, plus the
  // device credential; never the bearer token, which it has no use for.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SIMDEVICE_CONNECTION_STRING: connectionString,
  };
  delete childEnv['ACCEPTANCE_BEARER_TOKEN'];

  const api: AcceptanceApi = {
    runId,
    simulatedDeviceId,

    async runSimDevice(args: readonly string[]): Promise<SimDeviceRun> {
      lastRequest = undefined;
      lastExec = {};
      const { run, durationMs } = await runChild(simdeviceBin, args, childEnv, redact);
      lastExec.exitCode = run.exitCode;
      write(
        `  ${'EXEC'.padEnd(6)} ${`simdevice ${args.join(' ')}`.padEnd(30)}` +
          ` ${`exit ${run.exitCode ?? 'killed'}`.padEnd(7)} ${`${durationMs} ms`.padStart(6)}` +
          `  ${run.messages.length} message(s)`
      );
      return run;
    },

    metric(name: string, value: number) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !Number.isFinite(value)) {
        throw new Error(`invalid metric ${JSON.stringify(name)} ${value}`);
      }
      write(`METRIC ${name} ${value}`);
    },

    async request<T>(request: RequestOptions): Promise<AcceptanceResponse<T>> {
      const authenticated = request.authenticated ?? true;
      const expectCharge = request.expectRequestCharge ?? true;
      const route = request.route ?? request.path.split('?')[0];
      lastRequest = { method: request.method, route };
      lastExec = undefined;

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
      const line = redact(`FAIL ${group.name} — could not create proofs: ${describeError(error)}`);
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
      lastExec = undefined;
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
          : (execWhere() ?? 'before any request');
        const line = redact(`FAIL ${label} — ${where}: ${describeError(error)}`);
        write(line);
        failures.push(line);
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
