import {
  principalFromRequest,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { getUsersRepository, type UsersRepository } from '../../shared/cosmos/users-repository';

/**
 * HAR-27 (MG-81) — the injection seam the two /users/me handlers share. The
 * response helpers (JSON envelope, sanitized 500, request-charge header) are the
 * devices ones, so every Cosmos-backed route answers the same way.
 *
 * Identity comes only from the Easy Auth principal. No handler reads a `userId`
 * query parameter, an `x-user-id` header, or a body field for it.
 */

/** The repository surface the handlers use. */
export type UsersRepositoryPort = Pick<UsersRepository, 'getUser' | 'putUser'>;

/** Production wires Easy Auth and the adapter-backed repository; tests pass
 *  fakes. `getRepository` runs inside the invocation, so a missing setting fails
 *  that request (as a sanitized 500), not the module import. */
export interface UsersHandlerDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): UsersRepositoryPort;
}

export const defaultUsersDeps: UsersHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getUsersRepository,
};
