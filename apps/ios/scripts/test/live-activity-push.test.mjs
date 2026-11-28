// #248: the hand-sent lock-screen activity pushes. Over a fixed clock, a key
// generated here and a recording `send`: nothing reaches Apple.
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, it } from 'node:test';
import { DISMISS_AFTER_SECONDS, STALE_AFTER_SECONDS, headers, parseArgs, payload, providerToken, run } from '../live-activity-push.mjs';

const NOW = new Date('2026-11-27T20:00:00.000Z');
const SECONDS = NOW.getTime() / 1000;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const AUTH = ['--key-file', '/keys/AuthKey.p8', '--key-id', 'KEYID12345', '--team-id', 'TEAMID1234', '--token', 'ABCDEF01'];

function harness(answer = { status: 200, apnsId: 'id-1', body: '' }) {
  const sent = [];
  const out = [];
  const err = [];
  const reads = [];
  return {
    sent,
    out,
    err,
    reads,
    io: {
      now: () => NOW,
      readKey: path => {
        reads.push(path);
        return KEY_PEM;
      },
      send: async request => {
        sent.push(request);
        return answer;
      },
      print: text => out.push(text),
      error: text => err.push(text),
    },
  };
}

describe('start', () => {
  const options = parseArgs(['start', ...AUTH, '--cook-id', 'cook-1', '--cook-name', 'Brisket', '--grill', '224', '--target-probe1', '203']);

  it('starts the CookActivityAttributes activity for the cook', () => {
    const { aps } = payload(options, NOW);
    assert.equal(aps.event, 'start');
    assert.equal(aps.timestamp, SECONDS);
    assert.equal(aps['attributes-type'], 'CookActivityAttributes');
    assert.deepEqual(aps.attributes, { cookId: 'cook-1', cookName: 'Brisket', startTime: NOW.toISOString() });
  });

  it('carries the content state the app decodes', () => {
    const { aps } = payload(options, NOW);
    assert.deepEqual(aps['content-state'], {
      grillTemp: 224,
      targetTemps: { probe1: 203 },
      temperatureUnit: 'fahrenheit',
      readingTime: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    assert.equal(aps['stale-date'], SECONDS + STALE_AFTER_SECONDS);
  });

  it('shows a banner with no sound', () => {
    const { aps } = payload(options, NOW);
    assert.deepEqual(aps.alert, { title: 'Cook started: Brisket', body: 'On the lock screen' });
    assert.equal('sound' in aps.alert, false);
    assert.equal('sound' in aps, false);
  });

  it('a start always carries an alert body, which iOS requires', () => {
    const { aps } = payload(parseArgs(['start', ...AUTH, '--cook-id', 'c', '--alert-title', 'Still cooking']), NOW);
    assert.equal(aps.alert.body, 'On the lock screen');
    const custom = payload(parseArgs(['start', ...AUTH, '--cook-id', 'c', '--alert-body', 'Mine']), NOW);
    assert.equal(custom.aps.alert.body, 'Mine');
  });

  it('plays a sound only when asked', () => {
    const { aps } = payload(parseArgs(['start', ...AUTH, '--cook-id', 'c', '--sound', 'default']), NOW);
    assert.equal(aps.alert.sound, 'default');
  });

  it('asks for the update token only when told to', () => {
    assert.equal('input-push-token' in payload(options, NOW).aps, false);
    const asked = payload(parseArgs(['start', ...AUTH, '--cook-id', 'c', '--input-push-token']), NOW);
    assert.equal(asked.aps['input-push-token'], 1);
  });

  it('needs a cook id', () => {
    assert.throws(() => parseArgs(['start', ...AUTH]), /--cook-id/);
  });
});

describe('update and end', () => {
  it('an update carries the readings and no alert', () => {
    const { aps } = payload(parseArgs(['update', ...AUTH, '--probe1', '171.5', '--unit', 'celsius']), NOW);
    assert.equal(aps.event, 'update');
    assert.equal(aps.alert, undefined);
    assert.equal(aps.attributes, undefined);
    assert.deepEqual(aps['content-state'], {
      probe1Temp: 171.5,
      temperatureUnit: 'celsius',
      readingTime: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    assert.equal(aps['stale-date'], SECONDS + STALE_AFTER_SECONDS);
  });

  it('an end shows "Cook ended" and leaves the lock screen 15 minutes later', () => {
    const { aps } = payload(parseArgs(['end', ...AUTH]), NOW);
    assert.equal(aps.event, 'end');
    assert.equal(aps['content-state'].ended, true);
    assert.equal(aps['content-state'].endedAt, NOW.toISOString());
    assert.equal(aps['dismissal-date'], SECONDS + DISMISS_AFTER_SECONDS);
    assert.equal(aps['stale-date'], undefined);
  });
});

describe('the request', () => {
  it('is a Live Activity push to the token, at high priority by default', () => {
    assert.deepEqual(headers(parseArgs(['update', ...AUTH])), {
      ':method': 'POST',
      ':path': '/3/device/abcdef01',
      'apns-push-type': 'liveactivity',
      'apns-topic': 'com.meatgeek.ios.push-type.liveactivity',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    assert.equal(headers(parseArgs(['update', ...AUTH, '--priority', '5']))['apns-priority'], '5');
  });

  it('refuses a missing key, a token that is not hex and an unknown option', () => {
    assert.throws(() => parseArgs(['update', '--key-id', 'K', '--team-id', 'T', '--token', 'ab']), /--key-file is required/);
    assert.throws(() => parseArgs(['update', ...AUTH.slice(0, -1), 'not-hex']), /hex/);
    assert.throws(() => parseArgs(['update', ...AUTH, '--colour', 'red']), /Unknown option --colour/);
    assert.throws(() => parseArgs(['restart', ...AUTH]), /start, update or end/);
    assert.throws(() => parseArgs(['update', ...AUTH, '--grill', 'hot']), /number/);
  });
});

describe('the key from apns.env', () => {
  const env = { APNS_KEY_PATH: '/env/AuthKey.p8', APNS_KEY_ID: 'ENVKEY1234', APPLE_TEAM_ID: 'ENVTEAM123' };

  it('takes the key file, key id and team id from the environment', () => {
    const options = parseArgs(['update', '--token', 'ab'], env);
    assert.equal(options.keyFile, '/env/AuthKey.p8');
    assert.equal(options.keyId, 'ENVKEY1234');
    assert.equal(options.teamId, 'ENVTEAM123');
  });

  it('an argument wins over the environment', () => {
    assert.equal(parseArgs(['update', ...AUTH], env).keyId, 'KEYID12345');
  });
});

describe('the provider token', () => {
  it('is an ES256 JWT for the key id and team id, issued now, that the key verifies', () => {
    const jwt = providerToken({ keyPem: KEY_PEM, keyId: 'KEYID12345', teamId: 'TEAMID1234' }, NOW);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEYID12345' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: 'TEAMID1234', iat: SECONDS });
    const raw = Buffer.from(signature, 'base64url');
    assert.equal(raw.length, 64);
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, raw);
    assert.equal(ok, true);
  });
});

describe('run', () => {
  it('sends to the sandbox, signed, and says APNs accepted it', async () => {
    const h = harness();
    const code = await run(['update', ...AUTH, '--grill', '230'], h.io);
    assert.equal(code, 0);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].host, 'api.sandbox.push.apple.com');
    assert.match(h.sent[0].headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(JSON.parse(h.sent[0].body).aps['content-state'].grillTemp, 230);
    assert.deepEqual(h.reads, ['/keys/AuthKey.p8']);
    assert.match(h.out.at(-1), /^200: APNs accepted/);
  });

  it('sends to production only when asked', async () => {
    const h = harness();
    await run(['end', ...AUTH, '--production'], h.io);
    assert.equal(h.sent[0].host, 'api.push.apple.com');
  });

  it("prints APNs' reason and fails when it refuses", async () => {
    const h = harness({ status: 410, apnsId: 'id-2', body: '{"reason":"Unregistered","timestamp":1}' });
    const code = await run(['update', ...AUTH], h.io);
    assert.equal(code, 1);
    assert.match(h.out.at(-1), /^410 Unregistered: APNs refused/);
  });

  it('a dry run reads no key and sends nothing', async () => {
    const h = harness();
    const code = await run(['start', ...AUTH, '--cook-id', 'cook-1', '--dry-run'], h.io);
    assert.equal(code, 0);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.reads, []);
  });

  it('never prints the device token, the provider token, the key or the team id', async () => {
    const h = harness();
    await run(['start', ...AUTH, '--cook-id', 'cook-1'], h.io);
    const printed = h.out.join('\n');
    assert.equal(printed.toLowerCase().includes('abcdef01'), false);
    assert.equal(printed.includes('bearer'), false);
    assert.equal(printed.includes('TEAMID1234'), false);
    assert.equal(printed.includes('BEGIN'), false);
  });

  it('a usage error exits 2 with the usage', async () => {
    const h = harness();
    assert.equal(await run(['update'], h.io), 2);
    assert.match(h.err.join('\n'), /--key-file is required[\s\S]*Usage:/);
    assert.deepEqual(h.sent, []);
  });
});
