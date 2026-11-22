import type { Container } from '@azure/cosmos';

import { ACTIVE_DEVICE_LOCK_DOC_TYPE, activeDeviceLockId } from './cooks-repository';

/**
 * HAR-136 — an in-memory cooks container that answers POINT READS only, for
 * unit tests that need the real CooksRepository's view of the MG-84 device lock
 * (`getActiveCookIdForDevice`) and nothing else. Documents are keyed by
 * `(partition = userId, id)`; a missing one answers 404 as the SDK does. Any
 * other operation throws, so a test proves the code under it made no query and
 * no write. Test-only.
 */

export const COOKS_READ_CHARGE = 1.25;

type Stored = Record<string, unknown> & { id: string; userId: string };

export class FakeCooksContainer {
  readonly reads: Array<{ id: string; partitionKey: unknown }> = [];
  private readonly documents = new Map<string, Stored>();

  private key(partitionKey: unknown, id: string): string {
    return `${String(partitionKey)}/${id}`;
  }

  seed(document: Stored): void {
    this.documents.set(this.key(document.userId, document.id), structuredClone(document));
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
        const resource = this.documents.get(this.key(partitionKey, id));
        return {
          resource: resource ? structuredClone(resource) : undefined,
          statusCode: resource ? 200 : 404,
          etag: resource ? `"etag-${id}"` : undefined,
          requestCharge: COOKS_READ_CHARGE,
        };
      },
    };
  }

  get items(): never {
    throw new Error('fake cooks container: only point reads are supported');
  }
}
