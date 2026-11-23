import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';

import { REQUEST_CHARGE_HEADER } from '../../src/shared/cosmos/request-charge';
import { ClaimCodeLine, maskClaimCodes, NoClaimYet, readClaimCode } from './claim-code';
import { clock } from './clock';
import { Contract, SPEC_PATH } from './contract';
import {
  AcceptanceApi,
  AcceptanceResponse,
  Caller,
  DeviceRef,
  DeviceScript,
  DeviceScriptRun,
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
  deviceCredential,
  DPS_ENDPOINT_ENV,
  DPS_HOST_ENV,
  DPS_ID_SCOPE_ENV,
  IOT_HUB_HOST_ENV,
  SIM_DEVICE_INPUTS,
  simDeviceEnv,
  withoutDeviceInputs,
} from './simdevice-env';
import { spawnProcess } from './spawn';

/**
 * HAR-11 — the live acceptance runner. Runs every proof group found in
 * `../proofs` against the deployed API named by ACCEPTANCE_BASE_URL, as the
 * caller whose token is ACCEPTANCE_BEARER_TOKEN, and reports per request and
 * per route. It never prints the token or any header carrying it: every output
 * line passes through a redactor that masks the token value as well.
 *
 * HAR-44: it also runs `simdevice` (ACCEPTANCE_SIMDEVICE_BIN) for proofs, as the
 * simulated device ACCEPTANCE_SIM_DEVICE_ID. HAR-146: the device connects only
 * in DPS mode (./simdevice-env), as its own X.509 identity in the state dir
 * ACCEPTANCE_SIM_STATE_DIR, which `simdevice identity init` made and whose
 * certificate is enrolled, with the ID scope ACCEPTANCE_DPS_ID_SCOPE (and
 * optionally ACCEPTANCE_DPS_ENDPOINT). The child gets the MEATGEEK_* DPS
 * variables through its environment, never its command line. No device key
 * passes through the runner: it stays in the state dir.
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
 * `METRIC contract-validated-responses`. HAR-145: the one exception is a
 * request marked `outsideContract`, for a route the spec deliberately lacks
 * (the removed POST /devices): it is refused if it IS a spec operation, and its
 * response is not checked or counted. A proof may resolve to a note, which its
 * PASS line carries.
 *
 * HAR-84: a second standing device, the chart device, for the cook-chart RU
 * proof, which keeps one active cook running on it across runs. Its id and
 * state dir (ACCEPTANCE_CHART_DEVICE_ID, ACCEPTANCE_CHART_STATE_DIR) are
 * optional: set both or neither. When set, `api.chartDeviceId` names it and
 * `runSimDevice(args, { device: 'chart' })` runs simdevice as it. No simdevice
 * child is handed the inputs of a device it is not sending as.
 *
 * HAR-120: both of its own time limits, the per-request one and the simdevice
 * kill, are on the injected clock (./clock), and each failure says what it was
 * waiting for: `the response did not finish in <ms> ms …` for a request, and
 * `killedAfterMs` on a {@link SimDeviceRun} the runner killed.
 *
 * HAR-138: the redactor also masks anything shaped like a claim code
 * (HAR-134).
 *
 * HAR-140: a proof can enrol a fresh device of its own (./enrolment) and run
 * simdevice as it (`runSimDevice(args, { device: { deviceId, stateDir } })`,
 * always DPS mode), read a device's claim code (`readClaimCode`, logged
 * without what it printed), and run the device scripts in
 * apps/data-pusher/deploy (`runDeviceScript`) as the job's `az` login, named
 * by host with ACCEPTANCE_DPS_HOST and ACCEPTANCE_IOT_HUB_HOST.
 */

export const REQUIRED_ENV = [
  'ACCEPTANCE_BASE_URL',
  'ACCEPTANCE_BEARER_TOKEN',
  'ACCEPTANCE_PEER_BEARER_TOKEN',
  'ACCEPTANCE_DPS_ID_SCOPE',
  'ACCEPTANCE_SIM_DEVICE_ID',
  'ACCEPTANCE_SIM_STATE_DIR',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

/** HAR-84: the chart device's id and state dir. Optional, but set both or
 *  neither: one without the other stops the run before anything is sent. */
export const CHART_DEVICE_ENV = [
  'ACCEPTANCE_CHART_DEVICE_ID',
  'ACCEPTANCE_CHART_STATE_DIR',
] as const;

export const PROOFS_DIR = join(__dirname, '..', 'proofs');

/** HAR-140: enrol-device.sh and delete-device.sh. HAR-142: revoke-device.sh. */
export const DEVICE_SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'data-pusher', 'deploy');

/** How long one request may take, response body included, before it fails.
 *  A cold start of the dev Function App answers its first request in ~9.5 s
 *  (docs/development/live-acceptance.md, "Real-time waits"). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** A `simdevice` run longer than this is killed, unless the proof passes its
 *  own limit. One reading takes seconds. */
const SIMDEVICE_TIMEOUT_MS = 120_000;

/** A device-script run longer than this is killed. Each makes three to five
 *  `az` calls of a few seconds each. */
const DEVICE_SCRIPT_TIMEOUT_MS = 300_000;

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
  /** HAR-140: where `runDeviceScript` finds its scripts. Defaults to
   *  apps/data-pusher/deploy ({@link DEVICE_SCRIPTS_DIR}); the self-test
   *  points it at fakes. */
  readonly deviceScriptsDir?: string;
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
 * the peer's), longest first, so one token that contains another is one mask
 * rather than a mangled partial. HAR-138: then anything shaped like a claim
 * code, which is known to no one before simdevice mints it.
 */
export function makeRedactor(tokens: readonly string[]): (line: string) => string {
  const secrets = tokens.filter(secret => secret.length > 0).sort((a, b) => b.length - a.length);
  return line =>
    maskClaimCodes(secrets.reduce((masked, secret) => masked.split(secret).join(REDACTED), line));
}

/** What a child process left behind: its exit, raw stdout and stderr (never
 *  logged as they are), and whether the time limit killed it. */
interface ChildOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killedAfterMs?: number;
  readonly durationMs: number;
}

/** Run `bin` with `args`. A run still going after `timeoutMs` (on the
 *  {@link clock}) is killed with SIGKILL and reports `killedAfterMs`.
 *  `what` names it if it cannot be started. */
function spawnChild(
  what: string,
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const started = clock().monotonic();
    // stdio is piped, never inherited: nothing the child prints reaches the log raw.
    const child = spawnProcess(bin, args, env);
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
      reject(new Error(`${what} could not be started${code ? ` (${code})` : ''}`));
    });
    child.on('close', exitCode => {
      cancelKill();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(killed && exitCode === null ? { killedAfterMs: timeoutMs } : {}),
        durationMs: Math.round(clock().monotonic() - started),
      });
    });
  });
}

/** The first non-empty line of `text`, trimmed. */
function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .find(line => line.trim() !== '')
    ?.trim();
}

/** The last non-empty line of `text`, trimmed. */
function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .pop()
    ?.trim();
}

/** Run `bin` with `args`, reducing its output to a {@link SimDeviceRun}. */
async function runChild(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  redact: (line: string) => string,
  timeoutMs: number
): Promise<{ readonly run: SimDeviceRun; readonly durationMs: number }> {
  const outcome = await spawnChild('simdevice', bin, args, env, timeoutMs);
  const messages: unknown[] = [];
  let unparsedLines = 0;
  for (const line of outcome.stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      unparsedLines += 1;
    }
  }
  const first = firstLine(outcome.stderr);
  const last = lastLine(outcome.stderr);
  return {
    run: {
      exitCode: outcome.exitCode,
      messages,
      unparsedLines,
      stderrFirstLine: first === undefined ? undefined : redact(first),
      ...(last === undefined ? {} : { stderrLastLine: redact(last) }),
      ...(outcome.killedAfterMs !== undefined ? { killedAfterMs: outcome.killedAfterMs } : {}),
    },
    durationMs: outcome.durationMs,
  };
}

export async function runAcceptance(options: RunOptions): Promise<RunResult> {
  const env = options.env;
  const isSet = (name: string) => (env[name]?.trim() ?? '') !== '';
  const missing = REQUIRED_ENV.filter(name => !isSet(name));
  if (missing.length > 0) {
    const failures = missing.map(
      name => `acceptance: ${name} is not set; the live acceptance run needs it`
    );
    failures.forEach(line => options.write(line));
    return { exitCode: 2, failures };
  }

  const simCredential = deviceCredential(env, SIM_DEVICE_INPUTS);
  if (simCredential === undefined) {
    // Unreachable: the required-input check above covers the state dir.
    const line = `acceptance: ${SIM_DEVICE_INPUTS.stateDirVariable} is not set; the live acceptance run needs it`;
    options.write(line);
    return { exitCode: 2, failures: [line] };
  }

  const chartCredential = deviceCredential(env, CHART_DEVICE_INPUTS);
  const chartIdSet = isSet(CHART_DEVICE_INPUTS.idVariable);
  if (chartIdSet !== (chartCredential !== undefined)) {
    const [set, unset] = chartIdSet
      ? [CHART_DEVICE_INPUTS.idVariable, CHART_DEVICE_INPUTS.stateDirVariable]
      : [CHART_DEVICE_INPUTS.stateDirVariable, CHART_DEVICE_INPUTS.idVariable];
    const line = `acceptance: ${set} is set but ${unset} is not; the chart device needs both or neither`;
    options.write(line);
    return { exitCode: 2, failures: [line] };
  }

  const token = (env['ACCEPTANCE_BEARER_TOKEN'] as string).trim();
  const peerToken = (env['ACCEPTANCE_PEER_BEARER_TOKEN'] as string).trim();
  const rawBaseUrl = (env['ACCEPTANCE_BASE_URL'] as string).trim();
  const simulatedDeviceId = (env['ACCEPTANCE_SIM_DEVICE_ID'] as string).trim();
  const simdeviceBin = (env['ACCEPTANCE_SIMDEVICE_BIN'] as string).trim();
  const chartDeviceId = chartCredential?.deviceId;
  const redact = makeRedactor([token, peerToken]);
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
  // DPS variables of the device it sends as; never a bearer token, which it
  // has no use for, nor another device's inputs. simDeviceEnv() drops any
  // SIMDEVICE_* and MEATGEEK_* DPS variable it inherited and sets only the
  // device's own (HAR-138).
  const baseChildEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseChildEnv['ACCEPTANCE_BEARER_TOKEN'];
  delete baseChildEnv['ACCEPTANCE_PEER_BEARER_TOKEN'];

  /** How a device is named in an EXEC line. */
  const deviceLabel = (device: DeviceRef): string =>
    device === 'simulated'
      ? 'simdevice'
      : device === 'chart'
        ? 'simdevice (chart)'
        : `simdevice (${device.deviceId})`;

  /** The credential simdevice runs `device` with: a standing device's from
   *  the run's inputs, a fresh one's from its own state dir, with the run's
   *  ID scope (and endpoint, when set). */
  const credentialOf = (device: DeviceRef): DeviceCredential => {
    if (device === 'simulated') return simCredential;
    if (device === 'chart') {
      if (chartCredential === undefined) {
        throw new Error(
          'the chart device is not configured: ACCEPTANCE_CHART_DEVICE_ID and ' +
            'ACCEPTANCE_CHART_STATE_DIR are not set'
        );
      }
      return chartCredential;
    }
    const endpoint = env[DPS_ENDPOINT_ENV]?.trim() ?? '';
    return {
      idScope: (env[DPS_ID_SCOPE_ENV] as string).trim(),
      endpoint: endpoint === '' ? undefined : endpoint,
      deviceId: device.deviceId,
      stateDir: device.stateDir,
    };
  };

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
      const device = simOptions?.device ?? 'simulated';
      const label = deviceLabel(device);
      lastExec = { label };
      const credential = credentialOf(device);
      const { run, durationMs } = await runChild(
        simdeviceBin,
        args,
        simDeviceEnv(baseChildEnv, credential),
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

    async readClaimCode(device: DeviceRef): Promise<ClaimCodeLine | NoClaimYet> {
      lastRequest = undefined;
      const label = `${deviceLabel(device)} claim-code`;
      lastExec = { label };
      const credential = credentialOf(device);
      const started = clock().monotonic();
      let line: ClaimCodeLine | NoClaimYet;
      try {
        line = await readClaimCode(simdeviceBin, credential.stateDir);
        lastExec.exitCode = line.state === 'no-claim-yet' ? 3 : 0;
      } catch (error) {
        lastExec.exitCode = (error as { exitCode?: number | null }).exitCode ?? null;
        throw error;
      }
      // Only the state: the line itself holds the claim code.
      write(
        `  ${'EXEC'.padEnd(6)} ${label.padEnd(30)} ${`exit ${lastExec.exitCode}`.padEnd(7)}` +
          ` ${`${Math.round(clock().monotonic() - started)} ms`.padStart(6)}  state ${line.state}`
      );
      return line;
    },

    async runDeviceScript(script: DeviceScript, args: readonly string[]): Promise<DeviceScriptRun> {
      lastRequest = undefined;
      lastExec = { label: script };
      const dpsHost = env[DPS_HOST_ENV]?.trim() ?? '';
      const hubHost = env[IOT_HUB_HOST_ENV]?.trim() ?? '';
      if (dpsHost === '' || hubHost === '') {
        throw new Error(
          `${script} needs ${DPS_HOST_ENV} and ${IOT_HUB_HOST_ENV}: CI's identity can only name ` +
            'the DPS and the IoT hub by host (it has no ARM read)'
        );
      }
      const scriptEnv = withoutDeviceInputs(baseChildEnv);
      const fullArgs = [...args, '--auth-type', 'login', '--dps', dpsHost, '--hub', hubHost];
      const outcome = await spawnChild(
        script,
        join(options.deviceScriptsDir ?? DEVICE_SCRIPTS_DIR, script),
        fullArgs,
        scriptEnv,
        DEVICE_SCRIPT_TIMEOUT_MS
      );
      lastExec.exitCode = outcome.exitCode;
      const resultLine = firstLine(outcome.stdout);
      const stderrFirst = firstLine(outcome.stderr);
      const result: DeviceScriptRun = {
        exitCode: outcome.exitCode,
        resultLine: resultLine === undefined ? undefined : redact(resultLine),
        stderrFirstLine: stderrFirst === undefined ? undefined : redact(stderrFirst),
        ...(outcome.killedAfterMs !== undefined ? { killedAfterMs: outcome.killedAfterMs } : {}),
      };
      write(
        `  ${'EXEC'.padEnd(6)} ${`${script} ${args.join(' ')}`.padEnd(30)}` +
          ` ${`exit ${outcome.exitCode ?? 'killed'}`.padEnd(7)} ${`${outcome.durationMs} ms`.padStart(6)}` +
          (result.resultLine === undefined ? '' : `  ${result.resultLine}`)
      );
      return result;
    },

    metric(name: string, value: number) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !Number.isFinite(value)) {
        throw new Error(`invalid metric ${JSON.stringify(name)} ${value}`);
      }
      write(`METRIC ${name} ${value}`);
    },

    async request<T>(request: RequestOptions): Promise<AcceptanceResponse<T>> {
      const authenticated = request.authenticated ?? true;
      const outsideContract = request.outsideContract ?? false;
      const expectCharge = request.expectRequestCharge ?? !outsideContract;
      const as: Caller = request.as ?? 'owner';
      lastRequest = {
        method: request.method,
        route: request.route ?? request.path.split('?')[0],
        as,
      };
      lastExec = undefined;
      // HAR-77: before anything is sent, the request must be a spec operation.
      // HAR-145: or, outside the contract, must not be one.
      let operation: ReturnType<typeof contract.resolve> | undefined;
      let route: string;
      if (outsideContract) {
        contract.assertNoOperation(request.method, request.path);
        route = request.path.split('?')[0];
      } else {
        operation = contract.resolve(request.method, request.path, request.route);
        route = operation.path;
      }
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
      if (operation === undefined) {
        return result;
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
        const note = await proof.run(api);
        passed += 1;
        write(
          typeof note === 'string' && note !== ''
            ? redact(`PASS ${label} — ${note}`)
            : `PASS ${label}`
        );
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
