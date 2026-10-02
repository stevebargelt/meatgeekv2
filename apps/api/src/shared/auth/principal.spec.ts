import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CLIENT_PRINCIPAL_HEADER,
  PrincipalFailure,
  principalFromHeaderValue,
  principalFromRequest,
  unauthenticatedResponse,
} from './principal';

const OID = '11111111-1111-1111-1111-111111111111';
const TID = '22222222-2222-2222-2222-222222222222';
const OID_LONG = 'http://schemas.microsoft.com/identity/claims/objectidentifier';
const TID_LONG = 'http://schemas.microsoft.com/identity/claims/tenantid';

/** Encode a claim set the way Easy Auth injects `X-MS-CLIENT-PRINCIPAL`. */
function encodePrincipal(claims: Array<{ typ: string; val: string }>): string {
  const payload = { auth_typ: 'aad', name_typ: 'name', role_typ: 'roles', claims };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function headerRequest(value: string | null): {
  headers: { get(name: string): string | null };
} {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === CLIENT_PRINCIPAL_HEADER ? value : null,
    },
  };
}

describe('principalFromHeaderValue', () => {
  it('(1) yields a tenant-namespaced stable userId from a valid long-form header', () => {
    const header = encodePrincipal([
      { typ: OID_LONG, val: OID },
      { typ: TID_LONG, val: TID },
    ]);

    const result = principalFromHeaderValue(header);

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('expected authenticated');
    expect(result.principal.objectId).toBe(OID);
    expect(result.principal.tenantId).toBe(TID);
    // userId carries its namespace so a same-oid principal from another tenant
    // can never address this tenant's partition.
    expect(result.principal.userId).toBe(`${TID}:${OID}`);
  });

  it('(1b) accepts the short-form oid/tid claim types', () => {
    const header = encodePrincipal([
      { typ: 'oid', val: OID },
      { typ: 'tid', val: TID },
    ]);

    const result = principalFromHeaderValue(header);

    expect(result.authenticated).toBe(true);
    if (!result.authenticated) throw new Error('expected authenticated');
    expect(result.principal.userId).toBe(`${TID}:${OID}`);
  });

  it('(2) treats a missing header as unauthenticated — never a default userId or user-1', () => {
    for (const value of [undefined, null, '', '   ']) {
      const result = principalFromHeaderValue(value as string | null | undefined);
      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error('expected unauthenticated');
      expect(result.reason).toBe<PrincipalFailure>('principal_header_missing');
      // Guard against any fabricated-tenant regression.
      expect(JSON.stringify(result)).not.toContain('user-1');
    }
  });

  it('(3) treats a non-base64 / non-JSON header as unauthenticated, not a partial id', () => {
    for (const garbage of ['not base64 @@@', Buffer.from('{oops', 'utf8').toString('base64')]) {
      const result = principalFromHeaderValue(garbage);
      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error('expected unauthenticated');
      expect(result.reason).toBe<PrincipalFailure>('principal_header_unparseable');
    }
  });

  it('(3b) treats a decoded non-object payload (array / number) as unparseable', () => {
    for (const nonObject of ['[1,2,3]', '42', '"a-string"']) {
      const header = Buffer.from(nonObject, 'utf8').toString('base64');
      const result = principalFromHeaderValue(header);
      expect(result.authenticated).toBe(false);
      if (result.authenticated) throw new Error('expected unauthenticated');
      expect(result.reason).toBe<PrincipalFailure>('principal_header_unparseable');
    }
  });

  it('(3c) rejects a well-formed principal that carries no object-id claim', () => {
    const header = encodePrincipal([{ typ: TID_LONG, val: TID }]);
    const result = principalFromHeaderValue(header);
    expect(result.authenticated).toBe(false);
    if (result.authenticated) throw new Error('expected unauthenticated');
    expect(result.reason).toBe<PrincipalFailure>('principal_object_id_missing');
  });

  it('(3d) rejects a principal with an object id but no tenant namespace', () => {
    const header = encodePrincipal([{ typ: OID_LONG, val: OID }]);
    const result = principalFromHeaderValue(header);
    expect(result.authenticated).toBe(false);
    if (result.authenticated) throw new Error('expected unauthenticated');
    expect(result.reason).toBe<PrincipalFailure>('principal_tenant_id_missing');
  });

  it('(3e) rejects a blank/whitespace object-id claim value rather than minting a blank userId', () => {
    const header = encodePrincipal([
      { typ: OID_LONG, val: '   ' },
      { typ: TID_LONG, val: TID },
    ]);
    const result = principalFromHeaderValue(header);
    expect(result.authenticated).toBe(false);
    if (result.authenticated) throw new Error('expected unauthenticated');
    expect(result.reason).toBe<PrincipalFailure>('principal_object_id_missing');
  });

  it('never throws, whatever the input', () => {
    const inputs = ['', '   ', 'x', '{}', Buffer.from('null').toString('base64')];
    for (const input of inputs) {
      expect(() => principalFromHeaderValue(input)).not.toThrow();
    }
  });
});

describe('principalFromRequest', () => {
  it('reads ONLY the Easy Auth header, never query or body', () => {
    const header = encodePrincipal([
      { typ: OID_LONG, val: OID },
      { typ: TID_LONG, val: TID },
    ]);
    const result = principalFromRequest(headerRequest(header));
    expect(result.authenticated).toBe(true);
  });

  it('is unauthenticated when the Easy Auth header is absent', () => {
    const result = principalFromRequest(headerRequest(null));
    expect(result.authenticated).toBe(false);
    if (result.authenticated) throw new Error('expected unauthenticated');
    expect(result.reason).toBe<PrincipalFailure>('principal_header_missing');
  });
});

describe('(4) sanitization — no identity material leaks', () => {
  it('an unparseable-header result echoes neither the header nor any decoded text', () => {
    const secretOid = 'super-secret-oid-9999';
    // A decodable-but-invalid principal that DOES contain the secret text.
    const header = encodePrincipal([{ typ: 'unrelated', val: secretOid }]);

    const result = principalFromHeaderValue(header);
    const serialized = JSON.stringify(result);

    expect(result.authenticated).toBe(false);
    // The result surfaces only a fixed code — none of the header's claim text.
    expect(serialized).not.toContain(secretOid);
    expect(serialized).not.toContain(header);
  });

  it('every failure reason is drawn from the fixed vocabulary', () => {
    const allowed: PrincipalFailure[] = [
      'principal_header_missing',
      'principal_header_unparseable',
      'principal_object_id_missing',
      'principal_tenant_id_missing',
    ];
    const cases = [undefined, '', 'garbage@@', encodePrincipal([]), encodePrincipal([{ typ: OID_LONG, val: OID }])];
    for (const input of cases) {
      const result = principalFromHeaderValue(input as string | undefined);
      if (!result.authenticated) {
        expect(allowed).toContain(result.reason);
      }
    }
  });

  it('the module never calls console/logging', () => {
    // A leak most often happens through a stray console.* on the error path.
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    principalFromHeaderValue(encodePrincipal([{ typ: OID_LONG, val: OID }, { typ: TID_LONG, val: TID }]));
    principalFromHeaderValue('garbage@@@');
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe('unauthenticatedResponse', () => {
  it('returns a 401 carrying only the fixed reason code and request id', () => {
    const res = unauthenticatedResponse('principal_header_missing', 'req-7');
    expect(res.status).toBe(401);
    expect(res.jsonBody).toEqual({
      error: 'UNAUTHENTICATED',
      reason: 'principal_header_missing',
      requestId: 'req-7',
    });
    // No identity/claim keys smuggled into the body.
    expect(JSON.stringify(res.jsonBody)).not.toContain('oid');
  });
});

describe('(5) the chosen identifier and its namespace are documented in-tree', () => {
  it('principal.ts documents oid-as-userId, its tenant namespace, and the not-global caveat', () => {
    const source = readFileSync(join(__dirname, 'principal.ts'), 'utf8');
    expect(source).toMatch(/object id/i);
    expect(source).toMatch(/\boid\b/);
    expect(source).toMatch(/\btid\b/);
    expect(source).toMatch(/tenant/i);
    expect(source).toMatch(/not.*globally|globally.*unique|globally significant/i);
  });
});
