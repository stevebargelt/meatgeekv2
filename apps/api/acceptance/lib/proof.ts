/**
 * The contract a proof file is written against. A proof file lives in
 * `apps/api/acceptance/proofs/<name>.proof.ts` and default-exports a
 * {@link ProofGroup} built with {@link defineProofs}; the runner discovers it by
 * file name, so adding a proof never means editing the runner.
 */

import type { ClaimCodeLine, NoClaimYet } from './claim-code';
import type { Contract } from './contract';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who a request is sent as (HAR-67). `owner` is the run's caller,
 * ACCEPTANCE_BEARER_TOKEN: it registers the devices and owns the simulated
 * device. `peer` is the acceptance peer, ACCEPTANCE_PEER_BEARER_TOKEN: a second
 * signed-in caller with no devices, for proving one user cannot reach
 * another's data. A proof never sees either token; it names the caller.
 */
export type Caller = 'owner' | 'peer';

export interface RequestOptions {
  readonly method: HttpMethod;
  /** Path relative to ACCEPTANCE_BASE_URL, starting with `/`, query included. */
  readonly path: string;
  /** Route template used in output and the RU summary, e.g.
   *  `/cooks/{cookId}/stop`. It must be a path in openapi.yaml that `path`
   *  fits (HAR-77). Defaults to the spec path `path` fits. */
  readonly route?: string;
  /** JSON request body. */
  readonly body?: unknown;
  /** Extra request headers, e.g. `X-Request-ID` (HAR-68). They never replace
   *  the runner's own `Authorization`, `Accept` or `Content-Type`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Send a bearer token. Default `true`. */
  readonly authenticated?: boolean;
  /** Whose bearer token to send. Default `'owner'`. A peer request is marked
   *  `(peer)` on its output line, in the RU table and in a FAIL line. */
  readonly as?: Caller;
  /** Fail the proof when the response lacks a numeric
   *  `x-meatgeek-request-charge` header. Default `true`: every route that
   *  touches Cosmos must report its RU. Set `false` only for a response that
   *  makes no Cosmos call (e.g. an unauthenticated 401). */
  readonly expectRequestCharge?: boolean;
}

export interface AcceptanceResponse<T = unknown> {
  readonly method: HttpMethod;
  readonly route: string;
  /** Who the request was sent as. */
  readonly as: Caller;
  readonly status: number;
  readonly latencyMs: number;
  /** The `x-meatgeek-request-charge` value, when present and numeric. */
  readonly requestCharge: number | undefined;
  readonly headers: Headers;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  readonly body: T;
}

/**
 * The outcome of one `simdevice` run (HAR-44). Nothing here is the child's raw
 * output: stdout is reduced to the JSON values it printed, stderr to its first
 * line, redacted.
 */
export interface SimDeviceRun {
  /** The process exit code; `null` if it was killed (e.g. it ran too long). */
  readonly exitCode: number | null;
  /** One parsed value per stdout line that is JSON, in order. */
  readonly messages: readonly unknown[];
  /** How many non-empty stdout lines were not JSON. Their text is dropped. */
  readonly unparsedLines: number;
  /** The first non-empty stderr line, with the device credential masked. */
  readonly stderrFirstLine: string | undefined;
  /** HAR-120: set when the runner killed the run for outlasting its time
   *  limit (`exitCode` is then `null`): the limit, in ms. */
  readonly killedAfterMs?: number;
}

/**
 * HAR-140: a device a proof enrolled for itself (../lib/enrolment): its own id
 * and the state dir `simdevice identity init` made its key in. It always runs
 * in DPS mode, with the run's ACCEPTANCE_DPS_ID_SCOPE.
 */
export interface FreshDeviceRef {
  readonly deviceId: string;
  readonly stateDir: string;
}

/** Which device a simdevice run is for: a standing one, or a fresh one. */
export type DeviceRef = 'simulated' | 'chart' | FreshDeviceRef;

export interface SimDeviceOptions {
  /** Kill the run after this long. Default 120 s, plenty for a few readings;
   *  a long top-up (HAR-45) passes its own. */
  readonly timeoutMs?: number;
  /** HAR-84: which standing device to send as. `'chart'` uses the chart
   *  device's credential and throws if it is not configured
   *  (`chartDeviceId` is undefined). Default the simulated device.
   *  HAR-140: or a fresh device, in DPS mode from its own state dir. */
  readonly device?: DeviceRef;
}

/** HAR-140: the device scripts in apps/data-pusher/deploy the suite runs. */
export type DeviceScript = 'enrol-device.sh' | 'delete-device.sh';

/** The outcome of one device-script run. As with simdevice, nothing here is
 *  raw output: stdout is reduced to its first line (the script's one result
 *  line, e.g. `deleted acceptance-temp-…`) and stderr to its first line, both
 *  redacted. */
export interface DeviceScriptRun {
  readonly exitCode: number | null;
  readonly resultLine: string | undefined;
  readonly stderrFirstLine: string | undefined;
  readonly killedAfterMs?: number;
}

/** What a proof is handed: a client bound to the deployed API and the run id. */
export interface AcceptanceApi {
  /** Unique per run; use it to name synthetic data (e.g. `acceptance-<runId>`). */
  readonly runId: string;
  /** The standing simulated device `simdevice` sends as
   *  (ACCEPTANCE_SIM_DEVICE_ID), e.g. `meatgeek-dev-simulated-smoker`. */
  readonly simulatedDeviceId: string;
  /** HAR-84: the second standing device the cook-chart proof keeps one active
   *  cook on (ACCEPTANCE_CHART_DEVICE_ID), e.g.
   *  `meatgeek-dev-simulated-smoker-chart`. Undefined when the run was not given
   *  it; a proof that needs it must check. Send as it with
   *  `runSimDevice(args, { device: 'chart' })`. */
  readonly chartDeviceId: string | undefined;
  /** Run the `simdevice` binary (ACCEPTANCE_SIMDEVICE_BIN) with `args`. The
   *  runner hands it the device credential through its environment; a proof
   *  never sees the credential. Resolves on exit whatever the exit code;
   *  rejects only if the binary cannot be started. A run longer than
   *  `options.timeoutMs` (default 120 s, on the injected clock) is killed:
   *  `exitCode` is `null` and `killedAfterMs` is the limit. */
  runSimDevice(args: readonly string[], options?: SimDeviceOptions): Promise<SimDeviceRun>;
  /**
   * HAR-140: `simdevice claim-code` for a DPS-mode device (../lib/claim-code).
   * The line holds the claim code, a secret until it is used: the runner logs
   * that it ran, never what it printed. Throws for a device that is not in
   * DPS mode.
   */
  readClaimCode(device: DeviceRef): Promise<ClaimCodeLine | NoClaimYet>;
  /** HAR-140: whether `device` runs in DPS mode, and so can show a claim
   *  code. A fresh device always does; a standing one when the run was given
   *  its state dir and the DPS ID scope. */
  inDpsMode(device: DeviceRef): boolean;
  /**
   * HAR-140: run one of the device scripts (`enrol-device.sh`,
   * `delete-device.sh`) with `args`, as the job's `az` login. The runner adds
   * `--auth-type login --dps <ACCEPTANCE_DPS_HOST> --hub
   * <ACCEPTANCE_IOT_HUB_HOST>` and throws when either host is not set.
   * Resolves on exit whatever the exit code.
   */
  runDeviceScript(script: DeviceScript, args: readonly string[]): Promise<DeviceScriptRun>;
  /** Print `METRIC <name> <value>`. The CI job copies these lines to the run
   *  summary. `name` is lower-case kebab-case; `value` a finite number. */
  metric(name: string, value: number): void;
  /**
   * Send a request and check the response against the OpenAPI contract
   * (HAR-77): the status is declared for the operation, a JSON body matches
   * that status's schema, and a declared `X-Request-ID` header is present. A
   * mismatch, or a route that is not in the spec, fails the proof.
   */
  request<T = unknown>(options: RequestOptions): Promise<AcceptanceResponse<T>>;
  /** The run's OpenAPI contract, for checking received SignalR messages
   *  (`expectHubMessage` in ./signalr). */
  readonly contract: Pick<Contract, 'checkHubMessage'>;
  /** Fail unless the status matches: an exact code, or `'2xx'`. */
  expectStatus(response: AcceptanceResponse, expected: number | '2xx'): void;
  /** Fail with `message`, attributed to `response`'s route and status, unless
   *  `condition` holds. */
  check(response: AcceptanceResponse, condition: unknown, message: string): asserts condition;
}

export interface Proof {
  /** Printed on pass and fail, e.g. `POST /cooks starts a cook`. */
  readonly name: string;
  /** Run even after an earlier proof in the group failed (HAR-68): for a
   *  cleanup step that must leave the system as the group found it. */
  readonly always?: boolean;
  run(api: AcceptanceApi): Promise<void>;
}

/**
 * An ordered list of proofs from one file. They run in order and may share
 * state through the `create` closure (e.g. the id of a cook made by an earlier
 * proof). After a failure the rest of the group is skipped, since later proofs
 * usually depend on earlier ones; a proof marked `always` still runs. `create` is called afresh on every run.
 */
export interface ProofGroup {
  readonly name: string;
  readonly create: () => readonly Proof[];
}

export function defineProofs(name: string, create: () => readonly Proof[]): ProofGroup {
  return { name, create };
}

/** A failed expectation, attributed to the request that produced it. */
export class ProofFailure extends Error {
  constructor(
    message: string,
    readonly response?: Pick<AcceptanceResponse, 'method' | 'route' | 'status'> &
      Partial<Pick<AcceptanceResponse, 'as'>>
  ) {
    super(message);
    this.name = 'ProofFailure';
  }
}
