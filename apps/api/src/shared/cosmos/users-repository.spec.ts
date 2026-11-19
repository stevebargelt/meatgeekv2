/**
 * HAR-27 (MG-81) — the pure parts of the users repository: the deep-merge rule,
 * the frozen defaults, and the toUser allow-list.
 */
import {
  DEFAULT_USER_PREFERENCES,
  deepMerge,
  mergeUserPreferences,
  toUser,
  type StoredUser,
} from './users-repository';

describe('HAR-27 deepMerge', () => {
  it('merges plain objects key by key, at any depth', () => {
    expect(deepMerge({ a: { b: 1, c: { d: 2, e: 3 } } }, { a: { c: { e: 4 }, f: 5 } })).toEqual({
      a: { b: 1, c: { d: 2, e: 4 }, f: 5 },
    });
  });

  it('replaces scalars and arrays rather than merging them', () => {
    expect(
      deepMerge(
        { s: 'x', n: 1, list: [1, 2, 3], o: { k: 1 } },
        {
          s: 'y',
          n: 2,
          list: [9],
          o: 'scalar now',
        }
      )
    ).toEqual({ s: 'y', n: 2, list: [9], o: 'scalar now' });
    expect(deepMerge({ o: [1] }, { o: { k: 1 } })).toEqual({ o: { k: 1 } });
  });

  it('leaves a key alone when the patch value is undefined, and keeps explicit null', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined, b: null })).toEqual({ a: 1, b: null });
  });

  it('modifies neither input and shares no structure with them', () => {
    const base = { a: { b: [1] } };
    const patch = { c: { d: [2] } };
    const merged = deepMerge(base, patch) as { a: { b: number[] }; c: { d: number[] } };
    merged.a.b.push(99);
    merged.c.d.push(99);
    expect(base).toEqual({ a: { b: [1] } });
    expect(patch).toEqual({ c: { d: [2] } });
  });

  it('drops prototype-polluting keys', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":{"x":1}}}');
    const merged = deepMerge({}, patch);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged).toEqual({ nested: {} });
  });
});

describe('HAR-27 DEFAULT_USER_PREFERENCES', () => {
  it('is deeply frozen and never mutated by a merge', () => {
    const snapshot = JSON.stringify(DEFAULT_USER_PREFERENCES);
    expect(Object.isFrozen(DEFAULT_USER_PREFERENCES.notifications.pushNotifications)).toBe(true);
    const merged = mergeUserPreferences(DEFAULT_USER_PREFERENCES, {
      display: { theme: 'dark' } as never,
    });
    merged.notifications.pushNotifications.quietHours.enabled = true;
    expect(JSON.stringify(DEFAULT_USER_PREFERENCES)).toBe(snapshot);
    expect(merged.display).toEqual({ ...DEFAULT_USER_PREFERENCES.display, theme: 'dark' });
  });
});

describe('HAR-27 toUser', () => {
  it('keeps only User fields: no system properties, no unmodelled, subscription or lastLogin', () => {
    const document = {
      id: 'tid:oid',
      name: 'Pit Master',
      email: 'pit@example.com',
      preferences: DEFAULT_USER_PREFERENCES,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLogin: '2026-02-01T00:00:00.000Z',
      subscription: { plan: 'pro', status: 'active' },
      devices: ['stale-stored-device'],
      _rid: 'r',
      _etag: '"e"',
      _ts: 1,
      extra: 'x',
    } as unknown as StoredUser;

    expect(toUser(document, ['grill-1'])).toEqual({
      id: 'tid:oid',
      name: 'Pit Master',
      email: 'pit@example.com',
      preferences: DEFAULT_USER_PREFERENCES,
      createdAt: '2026-01-01T00:00:00.000Z',
      devices: ['grill-1'],
    });
  });
});
