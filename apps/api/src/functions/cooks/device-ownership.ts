/**
 * HAR-26 (MG-88, MG-83) — the refusal both cook routes return when the caller
 * does not own the cook's device.
 *
 * A device registered to someone else (`foreign`) and a device nobody registered
 * (`unknown`) get the SAME status and body, so the response does not reveal
 * whether another user owns the id. This differs on purpose from
 * `GET /devices/{id}`'s 404: a cook names a device the caller asserts is theirs.
 */
export const DEVICE_NOT_OWNED = 'DEVICE_NOT_OWNED';

export const DEVICE_NOT_OWNED_MESSAGE = 'The device is not registered to the caller.';

/** The 403 body for a cook on a device the caller does not own. */
export function deviceNotOwnedBody(requestId: string): {
  error: typeof DEVICE_NOT_OWNED;
  message: string;
  requestId: string;
} {
  return { error: DEVICE_NOT_OWNED, message: DEVICE_NOT_OWNED_MESSAGE, requestId };
}
