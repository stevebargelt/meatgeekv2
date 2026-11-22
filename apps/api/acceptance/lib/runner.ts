import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';

import { REQUEST_CHARGE_HEADER } from '../../src/shared/cosmos/request-charge';
import { maskClaimCodes } from './claim-code';
import { clock } from './clock';
import { Contract, SPEC_PATH } from './contract';
import {
  AcceptanceApi,
  AcceptanceResponse,
  Caller,
  HttpMethod,
  Proof,
  ProofFailure,
  ProofGroup,
  RequestOptions,
  SimDeviceOptions,
  SimDeviceRun,
} from './proof';
import {
  CHART_DEVICE_INPUTS,
  DeviceCredential,
  DPS_ID_SCOPE_ENV,
  deviceMode,
  SIM_DEVICE_INPUTS,
  simDeviceEnv,
} from './simdevice-env';

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
 *
 * HAR-67: a proof may also send a request as the acceptance peer, a second
 * caller with no devices, whose token is ACCEPTANCE_PEER_BEARER_TOKEN
 * (`request({ ..., as: 'peer' })`). The redactor masks that token too, and the
 * simdevice child gets neither token.
 *
 * HAR-77: at the start of a run it loads libs/api-specs/spec/openapi.yaml, and
 * every request is checked against it (./contract): the route must be an
 * operation in the spec, the status declared for it, a JSON body must match
 * that status's schema and a declared X-Request-ID header must be present. A
 * mismatch fails the proof. The run ends with a `CONTRACT validated …` line and
 * `METRIC contract-validated-responses`.
 *
 * HAR-84: a second standing device, the chart device, for the cook-chart RU
 * proof, which keeps one active cook running on it across runs. Its id and
 * credential (ACCEPTANCE_CHART_DEVICE_ID, SIMDEVICE_CHART_CONNECTION_STRING)
 * are optional: set both or neither. When set, `api.chartDeviceId` names it and
 * `runSimDevice(args, { device: 'chart' })` runs simdevice with the chart
 * credential as its SIMDEVICE_CONNECTION_STRING. The redactor masks it as it
 * masks the first device's, and no simdevice child is handed the credential of
 * the device it is not sending as.
 *
 * HAR-120: both of its own time limits, the per-request one and the simdevice
 * kill, are on the injected clock (./clock), and each failure says what it was
 * waiting for: `the response did not finish in <ms> ms …` for a request, and
 * `killedAfterMs` on a {@link SimDeviceRun} the runner killed.
 *
 * HAR-138: each device can instead run in DPS mode (./simdevice-env), from a
 * state dir `simdevice identity init` made and an enrolled certificate:
 * ACCEPTANCE_DPS_ID_SCOPE (and optionally ACCEPTANCE_DPS_ENDPOINT) plus the
 * device's state dir, ACCEPTANCE_SIM_STATE_DIR or ACCEPTANCE_CHART_STATE_DIR,
 * in place of its connection string. The child then gets the MEATGEEK_* DPS
 * variables and no SIMDEVICE_CONNECTION_STRING. A device given both, or a state
 * dir without the ID scope, stops the run before anything is sent. The
 * redactor also masks anything shaped like a claim code (HAR-134).
 */

export const REQUIRED_ENV = [
  'ACCEPTANCE_BASE_URL',
  'ACCEPTANCE_BEARER_TOKEN',
  'ACCEPTANCE_PEER_BEARER_TOKEN',
  'SIMDEVICE_CONNECTION_STRING',
  'ACCEPTANCE_SIM_DEVICE_ID',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

/** HAR-84: the chart device's id and credential. Optional, but set both or
 *  neither: one without the other stops the run before anything is sent.
 *  HAR-138: in DPS mode its credential is ACCEPTANCE_CHART_STATE_DIR instead. */
export const CHART_DEVICE_ENV = [
  'ACCEPTANCE_CHART_DEVICE_ID',
  'SIMDEVICE_CHART_CONNECTION_STRING',
] as const;

export const PROOFS_DIR = join(__dirname, '..', 'proofs');

/** How long one request may take, response body included, before it fails.
 *  A cold start of the dev Function App answers its first request in ~9.5 s
 *  (docs/development/live-acceptance.md, "Real-time waits"). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** A `simdevice` run longer than this is killed, unless the proof passes its
 *  own limit. One reading takes seconds. */
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
  /** The OpenAPI document to check responses against. Defaults to
   *  libs/api-specs/spec/openapi.yaml ({@link SPEC_PATH}). */
  readonly specPath?: string;
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
  const stamp = new Date(clock().now())
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
 * A function masking every secret in a line: the bearer tokens (the owner's and
 * the peer's), each device connection string (the standing device's and, when
 * set, the chart device's), and each one's SharedAccessKey value (with and
 * without the `SharedAccessKey=` prefix). Longest first, so a whole connection
 * string is one mask rather than a mangled partial. HAR-138: then anything
 * shaped like a claim code, which is known to no one before simdevice mints it.
 */
export function makeRedactor(
  tokens: readonly string[],
  connectionStrings: readonly string[]
): (line: string) => string {
  const keyed = connectionStrings.flatMap(connectionString => {
    const key = connectionString
      .split(';')
      .map(part => part.trim())
      .find(part => /^SharedAccessKey=/i.test(part))
      ?.slice('SharedAccessKey='.length);
    return [connectionString, ...(key ? [`SharedAccessKey=${key}`, key] : [])];
  });
  const secrets = [...tokens, ...keyed]
    .filter(secret => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  return line =>
    maskClaimCodes(secrets.reduce((masked, secret) => masked.split(secret).join(REDACTED), line));
}

/** Run `bin` with `args`, reducing its output to a {@link SimDeviceRun}. A run
 *  still going after `timeoutMs` (on the {@link clock}) is killed with SIGKILL
 *  and reports `killedAfterMs`. */
function runChild(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  redact: (line: string) => string,
  timeoutMs: number
): Promise<{ readonly run: SimDeviceRun; readonly durationMs: number }> {
  return new Promise((resolve, reject) => {
    const started = clock().monotonic();
    // stdio is piped, never inherited: nothing the child prints reaches the log raw.
    const child = spawn(bin, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let killed = false;
    const cancelKill = clock().after(timeoutMs, () => {
      killed = true;
      child.kill('SIGKILL');
    });
    child.on('error', error => {
      cancelKill();
      const code = (error as NodeJS.ErrnoException).code;
      reject(new Error(`simdevice could not be started${code ? ` (${code})` : ''}`));
    });
    child.on('close', exitCode => {
      cancelKill();
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
          ...(killed && exitCode === null ? { killedAfterMs: timeoutMs } : {}),
        },
        durationMs: Math.round(clock().monotonic() - started),
      });
    });
  });
}

export async function runAcceptance(options: RunOptions): Promise<RunResult> {
  const env = options.env;
  const isSet = (name: string) => (env[name]?.trim() ?? '') !== '';
  // HAR-138: a simulated device given a state dir runs in DPS mode and needs no
  // connection string; deviceMode() below checks the rest of that mode.
  const required = REQUIRED_ENV.filter(
    name =>
      !(
        name === SIM_DEVICE_INPUTS.connectionStringVariable &&
        isSet(SIM_DEVICE_INPUTS.stateDirVariable)
      )
  );
  const missing = required.filter(name => !isSet(name));
  if (missing.length > 0) {
    const failures = missing.map(
      name => `acceptance: ${name} is not set; the live acceptance run needs it`
    );
    failures.forEach(line => options.write(line));
    return { exitCode: 2, failures };
  }

  const simMode = deviceMode(env, SIM_DEVICE_INPUTS);
  const chartMode = deviceMode(env, CHART_DEVICE_INPUTS);
  const modeErrors = [simMode, chartMode].flatMap(mode =>
    mode.kind === 'error' ? [`acceptance: ${mode.message}`] : []
  );
  if (modeErrors.length > 0) {
    modeErrors.forEach(line => options.write(line));
    return { exitCode: 2, failures: modeErrors };
  }
  if (simMode.kind !== 'configured') {
    // Unreachable: the required-input check above guarantees one of the two.
    const line = `acceptance: ${SIM_DEVICE_INPUTS.connectionStringVariable} is not set; the live acceptance run needs it`;
    options.write(line);
    return { exitCode: 2, failures: [line] };
  }

  const chartIdSet = isSet(CHART_DEVICE_INPUTS.idVariable);
  if (chartIdSet !== (chartMode.kind === 'configured')) {
    const credentialVariable =
      chartMode.kind === 'configured' && chartMode.credential.mode === 'dps'
        ? CHART_DEVICE_INPUTS.stateDirVariable
        : CHART_DEVICE_INPUTS.connectionStringVariable;
    const line = chartIdSet
      ? isSet(DPS_ID_SCOPE_ENV)
        ? `acceptance: ${CHART_DEVICE_INPUTS.idVariable} is set but neither ` +
          `${CHART_DEVICE_INPUTS.connectionStringVariable} nor ${CHART_DEVICE_INPUTS.stateDirVariable} ` +
          'is; the chart device needs both or neither'
        : `acceptance: ${CHART_DEVICE_INPUTS.idVariable} is set but ${credentialVariable} is not; ` +
          'the chart device needs both or neither'
      : `acceptance: ${credentialVariable} is set but ${CHART_DEVICE_INPUTS.idVariable} is not; ` +
        'the chart device needs both or neither';
    options.write(line);
    return { exitCode: 2, failures: [line] };
  }

  const token = (env['ACCEPTANCE_BEARER_TOKEN'] as string).trim();
  const peerToken = (env['ACCEPTANCE_PEER_BEARER_TOKEN'] as string).trim();
  const rawBaseUrl = (env['ACCEPTANCE_BASE_URL'] as string).trim();
  const simulatedDeviceId = (env['ACCEPTANCE_SIM_DEVICE_ID'] as string).trim();
  const simdeviceBin = (env['ACCEPTANCE_SIMDEVICE_BIN'] as string).trim();
  const simCredential: DeviceCredential = simMode.credential;
  const chartCredential: DeviceCredential | undefined =
    chartMode.kind === 'configured' ? chartMode.credential : undefined;
  const chartDeviceId = chartCredential
    ? (env['ACCEPTANCE_CHART_DEVICE_ID'] as string).trim()
    : undefined;
  const connectionStrings = [simCredential, chartCredential].flatMap(credential =>
    credential?.mode === 'connection-string' ? [credential.connectionString] : []
  );
  const redact = makeRedactor([token, peerToken], connectionStrings);
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

  let contract: Contract;
  try {
    contract = await Contract.load(options.specPath ?? SPEC_PATH);
  } catch (error) {
    const line = `acceptance: the OpenAPI contract could not be loaded: ${describeError(error)}`;
    write(line);
    return { exitCode: 2, failures: [redact(line)] };
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
  let lastRequest: { method: HttpMethod; route: string; as: Caller; status?: number } | undefined;
  /** Set while a proof's last action was a simdevice run, for the same reason. */
  let lastExec: { exitCode?: number | null; label: string } | undefined;

  /** `simdevice → exit N` when the proof's last action was a simdevice run.
   *  (A function, so the compiler does not narrow lastExec across `await`.) */
  const execWhere = (): string | undefined => {
    if (!lastExec) return undefined;
    const { exitCode, label } = lastExec;
    return `${label} → ${exitCode === undefined ? 'not started' : `exit ${exitCode ?? 'killed'}`}`;
  };

  // The child gets the runner's own environment for PATH and tracing, plus the
  // credential of the device it sends as; never a bearer token, which it has
  // no use for, nor the other device's credential. simDeviceEnv() drops any
  // SIMDEVICE_CONNECTION_STRING and MEATGEEK_* DPS variable it inherited and
  // sets only those of the device's mode (HAR-138).
  const baseChildEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseChildEnv['ACCEPTANCE_BEARER_TOKEN'];
  delete baseChildEnv['ACCEPTANCE_PEER_BEARER_TOKEN'];
  delete baseChildEnv['SIMDEVICE_CHART_CONNECTION_STRING'];

  const api: AcceptanceApi = {
    runId,
    simulatedDeviceId,
    chartDeviceId,
    contract,

    async runSimDevice(
      args: readonly string[],
      simOptions?: SimDeviceOptions
    ): Promise<SimDeviceRun> {
      lastRequest = undefined;
      const chart = simOptions?.device === 'chart';
      const label = chart ? 'simdevice (chart)' : 'simdevice';
      lastExec = { label };
      if (chart && chartCredential === undefined) {
        throw new Error(
          'the chart device is not configured: ACCEPTANCE_CHART_DEVICE_ID and ' +
            'SIMDEVICE_CHART_CONNECTION_STRING are not set'
        );
      }
      const { run, durationMs } = await runChild(
        simdeviceBin,
        args,
        simDeviceEnv(baseChildEnv, chart ? (chartCredential as DeviceCredential) : simCredential),
        redact,
        simOptions?.timeoutMs ?? SIMDEVICE_TIMEOUT_MS
      );
      lastExec.exitCode = run.exitCode;
      write(
        `  ${'EXEC'.padEnd(6)} ${`${label} ${args.join(' ')}`.padEnd(30)}` +
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
      const as: Caller = request.as ?? 'owner';
      lastRequest = {
        method: request.method,
        route: request.route ?? request.path.split('?')[0],
        as,
      };
      lastExec = undefined;
      // HAR-77: before anything is sent, the request must be a spec operation.
      const operation = contract.resolve(request.method, request.path, request.route);
      const route = operation.path;
      lastRequest.route = route;

      // A proof's own headers go first, so the runner's always win (Headers
      // matches names case-insensitively).
      const headers = new Headers(request.headers);
      headers.set('Accept', 'application/json');
      headers.delete('Authorization');
      if (authenticated) {
        headers.set('Authorization', `Bearer ${as === 'peer' ? peerToken : token}`);
      }
      if (request.body !== undefined) {
        headers.set('Content-Type', 'application/json');
      }

      const started = clock().monotonic();
      // The limit covers the response body too. On the injected clock, and
      // cancelled once the body is in, so it never fires for a finished request.
      const abort = new AbortController();
      let timedOut = false;
      const cancelTimeout = clock().after(timeoutMs, () => {
        timedOut = true;
        abort.abort();
      });
      let response: Response;
      let text: string;
      try {
        response = await fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: abort.signal,
        });
        text = await response.text();
      } catch (error) {
        if (timedOut) {
          throw new ProofFailure(
            `the response did not finish in ${timeoutMs} ms (the runner's per-request limit)`
          );
        }
        throw error;
      } finally {
        cancelTimeout();
      }
      const latencyMs = Math.round(clock().monotonic() - started);
      lastRequest.status = response.status;

      let body: unknown = text;
      let json = false;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
          json = true;
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

      const who = authenticated ? (as === 'peer' ? ' (peer)' : '') : ' (no auth)';
      const key = `${request.method} ${route}${who}`;
      const entry = totals.get(key) ?? { calls: 0, charged: 0, totalRu: 0 };
      entry.calls += 1;
      if (requestCharge !== undefined) {
        entry.charged += 1;
        entry.totalRu += requestCharge;
      }
      totals.set(key, entry);

      write(
        `  ${request.method.padEnd(6)} ${`${route}${as === 'peer' ? ' (peer)' : ''}`.padEnd(30)}` +
          ` ${String(response.status).padEnd(4)}` +
          ` ${`${latencyMs} ms`.padStart(8)}  RU ${requestCharge === undefined ? '-' : formatRu(requestCharge)}`
      );

      const result: AcceptanceResponse<T> = {
        method: request.method,
        route,
        as,
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
      const mismatch = contract.checkResponse(operation, {
        status: response.status,
        headers: response.headers,
        body,
        json,
      });
      if (mismatch !== undefined) {
        throw new ProofFailure(mismatch, result);
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
      if (groupFailed && !proof.always) {
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
          ? `${at.method} ${at.route}${at.as === 'peer' ? ' (peer)' : ''} → ` +
            `${at.status === undefined ? 'no response' : at.status}`
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
  const checked = contract.counts;
  write('');
  write(
    `CONTRACT validated ${checked.responses} responses, ${checked.hubMessages} hub messages, ` +
      `${checked.mismatches} mismatches`
  );
  write(`METRIC contract-validated-responses ${checked.responses}`);
  write('');
  write(
    `acceptance: ${passed} passed, ${failures.length} failed, ${skipped} skipped` +
      (failures.length > 0 ? '' : ' — all proofs green')
  );

  return { exitCode: failures.length > 0 ? 1 : 0, failures };
}
