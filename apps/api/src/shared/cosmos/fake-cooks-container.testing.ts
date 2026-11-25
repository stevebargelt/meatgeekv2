import type { Container } from '@azure/cosmos';

import { ACTIVE_DEVICE_LOCK_DOC_TYPE, activeDeviceLockId } from './cooks-repository';

/**
 * HAR-136 — an in-memory cooks container that answers POINT READS and
 * conditional REPLACES only, for unit tests that need the real
 * CooksRepository's view of the MG-84 device lock (`getActiveCookIdForDevice`)
 * or of a cook's reached targets (`recordReadings`). Documents are keyed by
 * `(partition = userId, id)`; a missing one answers 404 as the SDK does. Each
 * document carries an ETag that changes on every write; a replace whose
 * If-Match no longer matches fails with 412, as Cosmos does. Any other
 * operation throws, so a test proves the code under it made no query. Test-only.
 */

export const COOKS_READ_CHARGE = 1.25;
export const COOKS_WRITE_CHARGE = 10.5;

type Stored = Record<string, unknown> & { id: string; userId: string };

export class FakeCooksContainer {
  readonly reads: Array<{ id: string; partitionKey: unknown }> = [];
  readonly replaces: Array<{ id: string; partitionKey: unknown }> = [];
  private readonly documents = new Map<string, Stored>();
  private readonly versions = new Map<string, number>();
  /** Runs before each replace; a test throws from it to fail the write, or
   *  changes a document to make the write lose a race. */
  beforeReplace: (id: string) => void = () => undefined;

  private key(partitionKey: unknown, id: string): string {
    return `${String(partitionKey)}/${id}`;
  }

  seed(document: Stored): void {
    const key = this.key(document.userId, document.id);
    this.documents.set(key, structuredClone(document));
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  /** The stored document as it is, stored-only fields included. */
  peek(userId: string, id: string): Stored {
    const document = this.documents.get(this.key(userId, id));
    if (!document) {
      throw new Error(`fake cooks container: no ${id}`);
    }
    return structuredClone(document);
  }

  private etag(key: string, id: string): string {
    return `"etag-${id}-${this.versions.get(key) ?? 0}"`;
  }

  /** A cook on `deviceId` and the lock that names it, as startCook writes them. */
  seedCookWithLock(
    userId: string,
    deviceId: string,
    cookId: string,
    status: 'active' | 'completed' = 'active'
  ): void {
    this.seed({
      id: cookId,
      userId,
      deviceId,
      status,
      startTime: '2026-11-22T10:00:00.000Z',
    });
    this.seed({
      id: activeDeviceLockId(deviceId),
      userId,
      docType: ACTIVE_DEVICE_LOCK_DOC_TYPE,
      deviceId,
      cookId,
    });
  }

  asContainer(): Container {
    return this as unknown as Container;
  }

  item(id: string, partitionKey: unknown) {
    return {
      read: async () => {
        this.reads.push({ id, partitionKey });
        const key = this.key(partitionKey, id);
        const resource = this.documents.get(key);
        return {
          resource: resource ? structuredClone(resource) : undefined,
          statusCode: resource ? 200 : 404,
          etag: resource ? this.etag(key, id) : undefined,
          requestCharge: COOKS_READ_CHARGE,
        };
      },
      replace: async (
        body: Stored,
        options?: { accessCondition?: { type: string; condition: string } }
      ) => {
        this.replaces.push({ id, partitionKey });
        this.beforeReplace(id);
        const key = this.key(partitionKey, id);
        if (!this.documents.has(key)) {
          throw Object.assign(new Error('not found'), { code: 404 });
        }
        const condition = options?.accessCondition;
        if (condition?.type === 'IfMatch' && condition.condition !== this.etag(key, id)) {
          throw Object.assign(new Error('precondition failed'), { code: 412 });
        }
        this.seed(body);
        return {
          resource: structuredClone(body),
          statusCode: 200,
          etag: this.etag(key, id),
          requestCharge: COOKS_WRITE_CHARGE,
        };
      },
    };
  }

  get items(): never {
    throw new Error('fake cooks container: only point reads are supported');
  }
}
