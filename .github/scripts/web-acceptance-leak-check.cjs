#!/usr/bin/env node
// The HAR-44-style leak check for app-deploy-dev.yml's `web-acceptance` job,
// and (HAR-169) its `ios-acceptance` job.
//
//   node .github/scripts/web-acceptance-leak-check.cjs <proof-log> [<diagnostic-glob>]
//
// The iOS job gives the log only: it uploads no text file, so it has no
// diagnostic to check (its screenshots are images, chosen by name).
//
// Scans the proof's raw output (the file tee wrote, before GitHub's masking,
// so a masked secret is still caught) and every file the glob matches (the
// sign-in diagnostic, HAR-121) for: the connection-string key field, the
// acceptance user's password (ACCEPTANCE_USER_PASSWORD), its TOTP secret
// (ACCEPTANCE_USER_TOTP_SECRET), every TOTP code from a 30 s window the job
// can have run in (its 30 min timeout, plus a margin), since HAR-138,
// anything shaped like a device claim code (HAR-134) and, since HAR-139, a
// PEM private key block (each simulated device now holds its own key) and a
// JSON claimCode value whatever its shape. Line numbers only;
// nothing found is printed. The patterns are built so this file holds none of
// them literally.
//
// HAR-126: the workflow uploads the matched files on failure, so this runs
// first, and a matched file with a finding is deleted here. Every matched
// file this run did not prove clean is deleted too, so an error part-way
// through cannot leave an unchecked file for the upload.
//
// Exit codes:
//   0  nothing found
//   1  something found; every matched file with a finding is deleted
//   2  the check could not finish, or could not delete a file it had to;
//      nothing it matched can be vouched for
//
// The missing log is not an error: the proof did not run, so it wrote
// nothing; the matched files are checked all the same.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** TOTP windows scanned: from 35 min before `now` to 60 s after it. */
const WINDOW_BEFORE_S = 35 * 60;
const WINDOW_AFTER_S = 60;
const STEP_S = 30;

/**
 * The tests a line is put through. `now` is Unix seconds; the TOTP codes are
 * those of every 30 s window around it. `notes` says which inputs were not
 * set, so had nothing to look for.
 */
/**
 * A device claim code as simdevice prints it: XXXX-XXXX-XXXX in Crockford
 * base32 (no I, L, O or U), not inside a longer dashed or alphanumeric run, so
 * the middle of a UUID is not one. Nobody knows a code before the device mints
 * it, so its shape is all there is to look for.
 */
const CLAIM_CODE =
  /(?<![0-9A-Za-z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z-])/;

/**
 * HAR-139: the opening line of a PEM private key, of any kind (PKCS#8
 * `PRIVATE KEY`, `EC PRIVATE KEY`, `ENCRYPTED PRIVATE KEY`, ...). simdevice
 * keeps each device's key in its state dir and never prints it.
 */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE [K]EY-----/;

/**
 * HAR-139: a JSON `claimCode` member with a string value, as in simdevice's
 * own output, whatever the value looks like. A null value is not a code.
 */
const JSON_CLAIM_CODE = /"claim[C]ode"\s*:\s*"/;

function buildScans({ password, totpSecret, now }) {
  const scans = [
    { what: 'connection-string key field', test: line => /SharedAccess[K]ey=/i.test(line) },
    { what: 'claim code', test: line => CLAIM_CODE.test(line) },
    { what: 'PEM private key block', test: line => PEM_PRIVATE_KEY.test(line) },
    { what: 'JSON claimCode value', test: line => JSON_CLAIM_CODE.test(line) },
  ];
  const notes = [];
  if (password) scans.push({ what: 'password', test: line => line.includes(password) });
  else notes.push('password: not set, nothing to look for');

  const rawSecret = (totpSecret ?? '').trim();
  const secret = rawSecret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (secret) {
    scans.push({
      what: 'TOTP secret',
      test: line => {
        const upper = line.toUpperCase();
        return upper.includes(secret) || upper.includes(rawSecret.toUpperCase());
      },
    });
    // Same guardrails as the proof's totpCode(): Entra's secret is 10 bytes,
    // under otplib's default 16-byte minimum. A failure here throws, and the
    // caller treats the check as unfinished.
    const { createGuardrails, generateSync } = require('otplib');
    const guardrails = createGuardrails({ MIN_SECRET_BYTES: 1 });
    const codes = new Set();
    for (let t = now - WINDOW_BEFORE_S; t <= now + WINDOW_AFTER_S; t += STEP_S) {
      codes.add(generateSync({ secret, epoch: t, digits: 6, guardrails }));
    }
    scans.push({
      what: `TOTP code (${codes.size} windows)`,
      test: line => (line.match(/(?<!\d)\d{6}(?!\d)/g) ?? []).some(code => codes.has(code)),
    });
  } else {
    notes.push('TOTP secret and codes: not set, nothing to look for');
  }
  return { scans, notes };
}

/** Line numbers (1-based) of `text` each scan matches. */
function scanText(text, scans) {
  const lines = text.split('\n');
  return {
    lines: lines.length,
    results: scans.map(({ what, test }) => ({
      what,
      hits: lines.flatMap((line, i) => (test(line) ? [i + 1] : [])),
    })),
  };
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
  return !fs.existsSync(file);
}

/**
 * Runs the check. Everything it prints goes through `log`; it never prints a
 * line it scanned. Returns the exit code.
 */
function run({
  logPath,
  diagnosticGlob,
  password,
  totpSecret,
  now,
  cwd = process.cwd(),
  log = console.log,
}) {
  let diagnostics = [];
  const clean = new Set();
  let code = 0;
  try {
    diagnostics = diagnosticGlob
      ? fs
          .globSync(diagnosticGlob, { cwd })
          .map(rel => path.resolve(cwd, rel))
          .sort()
      : [];
    const { scans, notes } = buildScans({ password, totpSecret, now });
    for (const note of notes) log(`leak check: ${note}`);

    const check = (label, file) => {
      const { lines, results } = scanText(fs.readFileSync(file, 'utf8'), scans);
      const found = results.filter(r => r.hits.length);
      for (const { what, hits } of results) {
        log(`leak check: ${label}: ${what}: ${hits.length ? 'FOUND' : 'none'}`);
      }
      if (found.length) {
        log(
          `leak check: ${label}: FAILED: ${found
            .map(({ what, hits }) => `${what} on line(s) ${hits.join(', ')}`)
            .join('; ')}`
        );
      } else {
        log(`leak check: ${label}: passed (${lines} lines)`);
      }
      return found.length === 0;
    };

    if (fs.existsSync(logPath)) {
      if (!check('proof log', logPath)) code = 1;
    } else {
      log(
        `leak check: proof log: the proof did not run (no ${logPath}), so it wrote nothing to check.`
      );
    }

    if (diagnosticGlob) {
      log(`leak check: sign-in diagnostics: ${diagnostics.length} matching ${diagnosticGlob}`);
    } else {
      log('leak check: no diagnostic glob given: the log is all there is to check');
    }
    for (const file of diagnostics) {
      const label = path.relative(cwd, file);
      if (check(label, file)) {
        clean.add(file);
      } else {
        code = 1;
      }
    }
  } catch (error) {
    // The error's message could quote what it was reading; its name cannot.
    log(`leak check: could not finish (${error && error.name ? error.name : 'error'})`);
    code = 2;
  }

  // Whatever this run did not prove clean is not left for the upload.
  for (const file of diagnostics.filter(f => !clean.has(f))) {
    const label = path.relative(cwd, file);
    let gone = false;
    try {
      gone = removeFile(file);
    } catch {
      gone = false;
    }
    if (gone) {
      log(`leak check: ${label}: deleted, so the upload cannot include it`);
    } else {
      log(`leak check: ${label}: could NOT be deleted`);
      code = 2;
    }
  }
  return code;
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    console.error('usage: web-acceptance-leak-check.cjs <proof-log> [<diagnostic-glob>]');
    return 2;
  }
  return run({
    logPath: argv[0],
    diagnosticGlob: argv[1],
    password: process.env.ACCEPTANCE_USER_PASSWORD ?? '',
    totpSecret: process.env.ACCEPTANCE_USER_TOTP_SECRET ?? '',
    now: Math.floor(Date.now() / 1000),
  });
}

module.exports = { run, scanText, buildScans };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
