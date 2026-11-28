#!/usr/bin/env node
// Sends one lock-screen activity push to a phone by hand (#248): start,
// update or end. For the owner's trials on his own iPhone (#249), from his
// own Mac with his own APNs key; no server is involved. Node built-ins only
// (http2, crypto), so it runs with no `npm ci`.
//
//   node apps/ios/scripts/live-activity-push.mjs start \
//     --key-file ~/keys/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id YYYYYYYYYY \
//     --token <push-to-start token> --cook-id <id> --cook-name Brisket
//   node apps/ios/scripts/live-activity-push.mjs update --token <update token> ... --grill 230 --probe1 171
//   node apps/ios/scripts/live-activity-push.mjs end --token <update token> ...
//
// `--help` lists every option. `--dry-run` prints the request and sends
// nothing. The tokens come from the debug build's Push tab. Nothing here
// writes the key, the team id or a token anywhere: the key file is read and
// signs one provider token in memory, and the printout leaves the
// authorization header and the device token out.
//
// The payloads follow Apple's "Starting and updating Live Activities with
// ActivityKit push notifications". `content-state` and `attributes` are the
// app's CookActivityContentState and CookActivityAttributes
// (libs/api-specs/spec/components/schemas/live-activity.yaml).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { pathToFileURL } from 'node:url';

export const HOSTS = {
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

export const DEFAULTS = {
  bundleId: 'com.meatgeek.ios',
  attributesType: 'CookActivityAttributes',
  unit: 'fahrenheit',
  cookName: 'Test cook',
};

/// The ActivityKit content stale three minutes after it was sent, as the
/// app's own updates are (CookActivityPresenter.staleAfter).
export const STALE_AFTER_SECONDS = 3 * 60;
/// An ended activity leaves the lock screen 15 minutes later
/// (CookActivityPresenter.endedDismissAfter).
export const DISMISS_AFTER_SECONDS = 15 * 60;

const EVENTS = ['start', 'update', 'end'];
const CHANNELS = ['grill', 'probe1', 'probe2', 'probe3', 'probe4'];

export const USAGE = `Usage: live-activity-push.mjs <start|update|end> [options]

Required:
  --key-file <path>     Your APNs auth key (.p8). Read, never copied.
                        Default: $APNS_KEY_PATH.
  --key-id <id>         The key's 10-character id. Default: $APNS_KEY_ID.
  --team-id <id>        Your Apple Developer team id. Default: $APPLE_TEAM_ID.
                        (The three are what ~/.config/meatgeek/apns.env sets.)
  --token <hex>         start: the push-to-start token. update, end: the
                        activity's update token. From the debug build's Push tab.

Content:
  --cook-id <id>        start: the cook the activity is for. Use a running
                        cook's id: opening the app ends an activity whose cook
                        it cannot find.
  --cook-name <name>    start: the cook's name (default "${DEFAULTS.cookName}").
  --start-time <iso>    start: when the cook started (default: now).
  --grill <F> --probe1 <F> ... --probe4 <F>
                        Readings, degrees F.
  --target-grill <F> --target-probe1 <F> ... --target-probe4 <F>
                        Targets, degrees F.
  --unit <fahrenheit|celsius>   (default fahrenheit)

Alert (start sends one by default; update and end send none unless asked):
  --alert-title <text>  start default: "Cook started: <cook name>".
  --alert-body <text>
  --sound <name>        Play a sound. Without it the banner is silent.

Delivery:
  --priority <5|10>     (default 10; 5 is Apple's low priority, for routine updates)
  --production          Send to api.push.apple.com. Default: the sandbox, which
                        is what a debug build from Xcode receives.
  --bundle-id <id>      (default ${DEFAULTS.bundleId})
  --attributes-type <name>  start: the attributes' Swift type name
                        (default ${DEFAULTS.attributesType}).
  --input-push-token    start: add "input-push-token": 1, asking the system
                        for the new activity's update token. A variant to try
                        when the Push tab shows none for it.
  --dry-run             Print the request and send nothing.
`;

export class UsageError extends Error {}

/// The command line as options. Throws a UsageError naming what is wrong.
export function parseArgs(argv, env = {}) {
  const [event, ...rest] = argv;
  if (event === '--help' || event === '-h') return { help: true };
  if (!EVENTS.includes(event)) {
    throw new UsageError(`The first argument must be start, update or end, not ${JSON.stringify(event ?? '')}.`);
  }
  const options = { event, readings: {}, targets: {}, production: false, dryRun: false };
  const flags = { '--production': 'production', '--dry-run': 'dryRun', '--input-push-token': 'inputPushToken' };
  const strings = {
    '--key-file': 'keyFile',
    '--key-id': 'keyId',
    '--team-id': 'teamId',
    '--token': 'token',
    '--cook-id': 'cookId',
    '--cook-name': 'cookName',
    '--start-time': 'startTime',
    '--unit': 'unit',
    '--alert-title': 'alertTitle',
    '--alert-body': 'alertBody',
    '--sound': 'sound',
    '--priority': 'priority',
    '--bundle-id': 'bundleId',
    '--attributes-type': 'attributesType',
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (flags[arg]) {
      options[flags[arg]] = true;
      continue;
    }
    const value = rest[i + 1];
    const isChannel = CHANNELS.some(c => arg === `--${c}` || arg === `--target-${c}`);
    if (!strings[arg] && !isChannel) throw new UsageError(`Unknown option ${arg}.`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
    i++;
    if (isChannel) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new UsageError(`${arg} must be a number, not ${JSON.stringify(value)}.`);
      if (arg.startsWith('--target-')) options.targets[arg.slice('--target-'.length)] = number;
      else options.readings[arg.slice(2)] = number;
    } else {
      options[strings[arg]] = value;
    }
  }
  // The owner's apns.env (docs/infrastructure/apns-key-vault.md) names the
  // key; an argument wins over it.
  options.keyFile ??= env.APNS_KEY_PATH;
  options.keyId ??= env.APNS_KEY_ID;
  options.teamId ??= env.APPLE_TEAM_ID;
  for (const [flag, key] of [['--key-file', 'keyFile'], ['--key-id', 'keyId'], ['--team-id', 'teamId'], ['--token', 'token']]) {
    if (!options[key]) throw new UsageError(`${flag} is required.`);
  }
  if (!/^[0-9a-fA-F]+$/.test(options.token)) throw new UsageError('--token must be hex, as the Push tab shows it.');
  if (event === 'start' && !options.cookId) throw new UsageError('start needs --cook-id.');
  options.cookName ??= DEFAULTS.cookName;
  options.unit ??= DEFAULTS.unit;
  if (!['fahrenheit', 'celsius'].includes(options.unit)) throw new UsageError('--unit must be fahrenheit or celsius.');
  options.priority = options.priority === undefined ? 10 : Number(options.priority);
  if (![5, 10].includes(options.priority)) throw new UsageError('--priority must be 5 or 10.');
  options.bundleId ??= DEFAULTS.bundleId;
  options.attributesType ??= DEFAULTS.attributesType;
  return options;
}

/// The activity's content state (CookActivityContentState) at `now`.
export function contentState(options, now) {
  const state = {};
  for (const channel of CHANNELS) {
    if (options.readings[channel] !== undefined) state[`${channel}Temp`] = options.readings[channel];
  }
  if (Object.keys(options.targets).length > 0) state.targetTemps = { ...options.targets };
  state.temperatureUnit = options.unit;
  if (Object.keys(options.readings).length > 0) state.readingTime = now.toISOString();
  state.updatedAt = now.toISOString();
  if (options.event === 'end') {
    state.ended = true;
    state.endedAt = now.toISOString();
  }
  return state;
}

/// The push's JSON body at `now`.
export function payload(options, now) {
  const seconds = Math.floor(now.getTime() / 1000);
  const aps = { timestamp: seconds, event: options.event, 'content-state': contentState(options, now) };
  if (options.event === 'start') {
    aps['attributes-type'] = options.attributesType;
    aps.attributes = {
      cookId: options.cookId,
      cookName: options.cookName,
      startTime: options.startTime ?? now.toISOString(),
    };
    if (options.inputPushToken) aps['input-push-token'] = 1;
  }
  if (options.event === 'end') {
    aps['dismissal-date'] = seconds + DISMISS_AFTER_SECONDS;
  } else {
    aps['stale-date'] = seconds + STALE_AFTER_SECONDS;
  }
  const title = options.alertTitle ?? (options.event === 'start' ? `Cook started: ${options.cookName}` : undefined);
  if (title !== undefined || options.alertBody !== undefined || options.sound !== undefined) {
    const alert = {};
    if (title !== undefined) alert.title = title;
    if (options.alertBody !== undefined) alert.body = options.alertBody;
    // No `sound` key: the banner shows and makes no sound.
    if (options.sound !== undefined) alert.sound = options.sound;
    aps.alert = alert;
  }
  return { aps };
}

/// The request's headers, without the authorization header.
export function headers(options) {
  return {
    ':method': 'POST',
    ':path': `/3/device/${options.token.toLowerCase()}`,
    'apns-push-type': 'liveactivity',
    'apns-topic': `${options.bundleId}.push-type.liveactivity`,
    'apns-priority': String(options.priority),
    'content-type': 'application/json',
  };
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/// An APNs provider token: an ES256 JWT over the key id and team id, issued
/// at `now`, signed with the .p8 key's PEM text.
export function providerToken({ keyPem, keyId, teamId }, now) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now.getTime() / 1000) }));
  const input = `${header}.${claims}`;
  const key = createPrivateKey(keyPem);
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

/// Sends one request over HTTP/2 and resolves with APNs' answer:
/// `{ status, apnsId, body }`.
export function http2Send({ host, headers, body }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const request = client.request(headers);
    let status;
    let apnsId;
    let text = '';
    request.setEncoding('utf8');
    request.on('response', h => {
      status = h[':status'];
      apnsId = h['apns-id'];
    });
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      client.close();
      resolve({ status, apnsId, body: text });
    });
    request.on('error', error => {
      client.close();
      reject(error);
    });
    request.end(body);
  });
}

/// What APNs' answer means, in a line.
export function describe({ status, apnsId, body }) {
  let reason = '';
  try {
    reason = body ? JSON.parse(body).reason ?? '' : '';
  } catch {
    reason = body;
  }
  const id = apnsId ? ` (apns-id ${apnsId})` : '';
  if (status === 200) return `200: APNs accepted the push${id}. Accepted is not delivered: check the phone.`;
  return `${status}${reason ? ` ${reason}` : ''}: APNs refused the push${id}.`;
}

/// Runs the command. `io` is what it touches outside: the clock, the key
/// file, the network and the output.
export async function run(argv, io) {
  let options;
  try {
    options = parseArgs(argv, io.env ?? {});
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    io.print(USAGE);
    return 0;
  }
  const now = io.now();
  const host = options.production ? HOSTS.production : HOSTS.sandbox;
  const request = headers(options);
  const body = JSON.stringify(payload(options, now));
  // The device token and the provider token stay out of the printout.
  const shown = { ...request, ':path': '/3/device/<token>' };
  io.print(`${options.event} push to ${host}\n${JSON.stringify(shown, null, 2)}\n${JSON.stringify(JSON.parse(body), null, 2)}`);
  if (options.dryRun) {
    io.print('Dry run: nothing sent.');
    return 0;
  }
  const keyPem = io.readKey(options.keyFile);
  const authorization = `bearer ${providerToken({ keyPem, keyId: options.keyId, teamId: options.teamId }, now)}`;
  const answer = await io.send({ host, headers: { ...request, authorization }, body });
  io.print(describe(answer));
  return answer.status === 200 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = await run(process.argv.slice(2), {
    now: () => new Date(),
    env: process.env,
    readKey: path => readFileSync(path, 'utf8'),
    send: http2Send,
    print: text => console.log(text),
    error: text => console.error(text),
  });
  process.exitCode = code;
}
