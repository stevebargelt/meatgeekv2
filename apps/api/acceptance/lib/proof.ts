/**
 * The contract a proof file is written against. A proof file lives in
 * `apps/api/acceptance/proofs/<name>.proof.ts` and default-exports a
 * {@link ProofGroup} built with {@link defineProofs}; the runner discovers it by
 * file name, so adding a proof never means editing the runner.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly method: HttpMethod;
  /** Path relative to ACCEPTANCE_BASE_URL, starting with `/`, query included. */
  readonly path: string;
  /** Route template used in output and the RU summary, e.g.
   *  `/cooks/{cookId}/stop`. Defaults to `path` without its query string. */
  readonly route?: string;
  /** JSON request body. */
  readonly body?: unknown;
  /** Send the bearer token. Default `true`. */
  readonly authenticated?: boolean;
  /** Fail the proof when the response lacks a numeric
   *  `x-meatgeek-request-charge` header. Default `true`: every route that
   *  touches Cosmos must report its RU. Set `false` only for a response that
   *  makes no Cosmos call (e.g. an unauthenticated 401). */
  readonly expectRequestCharge?: boolean;
}

export interface AcceptanceResponse<T = unknown> {
  readonly method: HttpMethod;
  readonly route: string;
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
}

/** What a proof is handed: a client bound to the deployed API and the run id. */
export interface AcceptanceApi {
  /** Unique per run; use it to name synthetic data (e.g. `acceptance-<runId>`). */
  readonly runId: string;
  /** The standing simulated device `simdevice` sends as
   *  (ACCEPTANCE_SIM_DEVICE_ID), e.g. `meatgeek-dev-simulated-smoker`. */
  readonly simulatedDeviceId: string;
  /** Run the `simdevice` binary (ACCEPTANCE_SIMDEVICE_BIN) with `args`. The
   *  runner hands it the device credential through its environment; a proof
   *  never sees the credential. Resolves on exit whatever the exit code;
   *  rejects only if the binary cannot be started. */
  runSimDevice(args: readonly string[]): Promise<SimDeviceRun>;
  /** Print `METRIC <name> <value>`. The CI job copies these lines to the run
   *  summary. `name` is lower-case kebab-case; `value` a finite number. */
  metric(name: string, value: number): void;
  request<T = unknown>(options: RequestOptions): Promise<AcceptanceResponse<T>>;
  /** Fail unless the status matches: an exact code, or `'2xx'`. */
  expectStatus(response: AcceptanceResponse, expected: number | '2xx'): void;
  /** Fail with `message`, attributed to `response`'s route and status, unless
   *  `condition` holds. */
  check(response: AcceptanceResponse, condition: unknown, message: string): asserts condition;
}

export interface Proof {
  /** Printed on pass and fail, e.g. `POST /cooks starts a cook`. */
  readonly name: string;
  run(api: AcceptanceApi): Promise<void>;
}

/**
 * An ordered list of proofs from one file. They run in order and may share
 * state through the `create` closure (e.g. the id of a cook made by an earlier
 * proof). After a failure the rest of the group is skipped, since later proofs
 * usually depend on earlier ones. `create` is called afresh on every run.
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
    readonly response?: Pick<AcceptanceResponse, 'method' | 'route' | 'status'>
  ) {
    super(message);
    this.name = 'ProofFailure';
  }
}
