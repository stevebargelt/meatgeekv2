import { join } from 'path';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIV3 } from 'openapi-types';

import type { HttpMethod } from './proof';

/**
 * HAR-77 — the OpenAPI contract the live acceptance run checks every response
 * and every received SignalR message against. libs/api-specs/spec/openapi.yaml
 * is loaded and dereferenced once, at the start of a run, and each response
 * schema and `x-signalr` message schema is compiled with Ajv.
 *
 * A check returns the mismatch as one line, or `undefined` when the response
 * conforms. A line names the operation, the status and the first Ajv errors
 * with their path in the body. It never carries a value from the body, so a
 * server that echoes request data (a token) cannot put it in the output; the
 * runner's redactor masks every line anyway.
 */

export const SPEC_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'libs',
  'api-specs',
  'spec',
  'openapi.yaml'
);

/** How many Ajv errors a mismatch line lists. */
const MAX_ERRORS = 3;

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface ResponseContract {
  /** The compiled `application/json` schema, when the response declares one. */
  readonly validate?: ValidateFunction;
  /** The response declares an `X-Request-ID` header. */
  readonly requestId: boolean;
}

export interface Operation {
  readonly method: HttpMethod;
  /** The spec path, e.g. `/cooks/{cookId}/stop`. */
  readonly path: string;
  readonly operationId: string;
  readonly responses: ReadonlyMap<string, ResponseContract>;
}

export interface ContractCounts {
  /** Responses checked, conforming or not. */
  readonly responses: number;
  /** Hub messages checked, conforming or not. */
  readonly hubMessages: number;
  /** Responses and hub messages that did not conform. */
  readonly mismatches: number;
}

/** A response, as much of it as the contract looks at. */
export interface CheckedResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed body when it was JSON. */
  readonly body: unknown;
  /** Whether `body` came from a non-empty JSON body. */
  readonly json: boolean;
}

/** Ajv for OpenAPI 3.0 schemas, set up as the HAR-72 drift check sets it up:
 *  OpenAPI's own keywords (`example`, …) are ignored, its numeric formats are
 *  accepted, and the string formats the spec uses are checked. */
function newAjv(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  addFormats(ajv);
  for (const format of ['double', 'float', 'int32', 'int64']) {
    ajv.addFormat(format, true);
  }
  return ajv;
}

/** `/cooks/{cookId}` → its segments. */
function segments(path: string): string[] {
  return path.split('/').filter(segment => segment !== '');
}

const isParameter = (segment: string) => /^\{[^}]+\}$/.test(segment);

/** Whether the request path (no query) fits the spec path template. */
function fits(template: string, path: string): boolean {
  const want = segments(template);
  const have = segments(path);
  return (
    want.length === have.length &&
    want.every((segment, i) => isParameter(segment) || segment === have[i])
  );
}

/** One Ajv error as `<path> <message>`, naming the property an
 *  additionalProperties or required error is about. Never a value. */
function describeAjvError(error: ErrorObject): string {
  const at = error.instancePath === '' ? '(root)' : error.instancePath;
  const params = error.params as { additionalProperty?: unknown };
  const extra =
    error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string'
      ? ` '${params.additionalProperty}'`
      : '';
  return `${at} ${error.message ?? error.keyword}${extra}`;
}

function describeAjvErrors(errors: readonly ErrorObject[] | null | undefined): string {
  const list = errors ?? [];
  const shown = list.slice(0, MAX_ERRORS).map(describeAjvError).join('; ');
  const more = list.length > MAX_ERRORS ? ` (+${list.length - MAX_ERRORS} more)` : '';
  return `${shown}${more}`;
}

export class Contract {
  private responsesChecked = 0;
  private hubMessagesChecked = 0;
  private mismatchCount = 0;

  private constructor(
    private readonly operations: readonly Operation[],
    private readonly hubMessages: ReadonlyMap<string, ValidateFunction>
  ) {}

  /** Load, dereference and compile the spec at `specPath`. */
  static async load(specPath: string = SPEC_PATH): Promise<Contract> {
    const document = (await SwaggerParser.dereference(specPath)) as OpenAPIV3.Document;
    return Contract.fromDocument(document);
  }

  /** Compile an already dereferenced document. */
  static fromDocument(document: OpenAPIV3.Document): Contract {
    const ajv = newAjv();
    const operations: Operation[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const method of METHODS) {
        const operation = item?.[method.toLowerCase() as OpenAPIV3.HttpMethods];
        if (!operation) continue;
        const responses = new Map<string, ResponseContract>();
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          const declared = response as OpenAPIV3.ResponseObject;
          const schema = declared.content?.['application/json']?.schema;
          responses.set(status, {
            validate: schema ? ajv.compile(schema) : undefined,
            requestId: Object.keys(declared.headers ?? {}).some(
              name => name.toLowerCase() === 'x-request-id'
            ),
          });
        }
        operations.push({
          method,
          path,
          operationId: operation.operationId ?? `${method} ${path}`,
          responses,
        });
      }
    }

    const extension = (document as unknown as Record<string, unknown>)['x-signalr'] as
      | { messages?: Record<string, OpenAPIV3.SchemaObject> }
      | undefined;
    const hubMessages = new Map<string, ValidateFunction>();
    for (const [target, schema] of Object.entries(extension?.messages ?? {})) {
      hubMessages.set(target, ajv.compile(schema));
    }
    return new Contract(operations, hubMessages);
  }

  get counts(): ContractCounts {
    return {
      responses: this.responsesChecked,
      hubMessages: this.hubMessagesChecked,
      mismatches: this.mismatchCount,
    };
  }

  /**
   * The operation a request is for. `route`, when given, must be a spec path
   * of `method` that `path` fits; without it, the spec path `path` fits is
   * used, a literal segment winning over a parameter. Throws an Error naming
   * the request when there is none.
   */
  resolve(method: HttpMethod, path: string, route?: string): Operation {
    const bare = path.split('?')[0];
    if (route !== undefined) {
      const operation = this.operations.find(o => o.method === method && o.path === route);
      if (!operation) {
        throw new Error(`contract: ${method} ${route} is not an operation in openapi.yaml`);
      }
      if (!fits(route, bare)) {
        throw new Error(`contract: the path ${bare} does not fit the route ${route}`);
      }
      return operation;
    }
    const literals = (o: Operation) => segments(o.path).filter(s => !isParameter(s)).length;
    const candidates = this.operations
      .filter(o => o.method === method && fits(o.path, bare))
      .sort((a, b) => literals(b) - literals(a));
    if (candidates.length === 0) {
      throw new Error(`contract: ${method} ${bare} matches no operation in openapi.yaml`);
    }
    return candidates[0];
  }

  /**
   * HAR-145: for a request a proof sends to a route the spec deliberately
   * lacks (a removed one, `RequestOptions.outsideContract`). Throws an Error
   * naming the operation when `method path` is one after all, so such a proof
   * cannot silently go on sending a route the spec still describes.
   */
  assertNoOperation(method: HttpMethod, path: string): void {
    const bare = path.split('?')[0];
    const operation = this.operations.find(o => o.method === method && fits(o.path, bare));
    if (operation) {
      throw new Error(
        `contract: ${method} ${bare} is ${operation.operationId} in openapi.yaml, so it is not outside the contract`
      );
    }
  }

  /** Check a response against `operation`; the mismatch line, or `undefined`. */
  checkResponse(operation: Operation, response: CheckedResponse): string | undefined {
    this.responsesChecked += 1;
    const problem = this.responseProblem(operation, response);
    if (problem === undefined) return undefined;
    this.mismatchCount += 1;
    return `contract: ${operation.method} ${operation.path} (${operation.operationId}) ${response.status}: ${problem}`;
  }

  private responseProblem(operation: Operation, response: CheckedResponse): string | undefined {
    const status = String(response.status);
    const declared =
      operation.responses.get(status) ??
      operation.responses.get(`${status[0]}XX`) ??
      operation.responses.get('default');
    if (!declared) {
      const statuses = [...operation.responses.keys()].join(', ');
      return `the status is not declared (the spec declares ${statuses})`;
    }
    if (declared.requestId && !response.headers.get('x-request-id')) {
      return 'the declared X-Request-ID header is missing';
    }
    if (response.json) {
      if (!declared.validate) {
        return 'a JSON body came back, but the spec declares no body for this status';
      }
      if (!declared.validate(response.body)) {
        return `the body does not match the schema: ${describeAjvErrors(declared.validate.errors)}`;
      }
    }
    return undefined;
  }

  /** Check one received hub message (the single argument of `target`). */
  checkHubMessage(target: string, message: unknown): string | undefined {
    this.hubMessagesChecked += 1;
    const validate = this.hubMessages.get(target);
    let problem: string | undefined;
    if (!validate) {
      problem = 'the target is not in x-signalr.messages';
    } else if (!validate(message)) {
      problem = `the message does not match the schema: ${describeAjvErrors(validate.errors)}`;
    }
    if (problem === undefined) return undefined;
    this.mismatchCount += 1;
    return `contract: hub message ${target}: ${problem}`;
  }
}
