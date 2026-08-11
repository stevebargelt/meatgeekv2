// Unit tests for the container measurement (MG-67, HR4).
//
// The property under test is not "the parser reads JSON". It is that NOTHING is
// ever assumed: a document whose partition key path or default_ttl cannot be
// read produces a refusal and no value at all, never a fallback. The downstream
// tickets (MG-53's source-only-holds-recorded-documents check, MG-54's disposal
// authorization) classify a later zero count as TTL expiry using the number
// recorded here — a guessed retention would make that call unsound, so a
// substituted default is the defect these tests exist to catch.
//
// Dependency-free by contract: node: built-ins and local files only, so this
// file runs in the credentialless validate-infrastructure job with no npm
// install and no network. The az documents under fixtures/ are what az produces;
// this tool holds no identity and never calls it.

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  RUN_ID_FIELD,
  SYNTHETIC_MARKER_FIELD,
  buildFixtureMessages,
  partitionKeyFieldProblem,
} from './fixture-core.mjs';
import {
  DECLARED_DEFAULT_TTL_SECONDS,
  DECLARED_TTL_DAYS,
  SECONDS_PER_DAY,
  describeContainerDefinition,
  parseContainerDefinition,
} from './container-definition.mjs';

const readLocal = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const readFixture = name => readLocal(`./fixtures/${name}`);

// Reshape a fixture in memory. Used for the cases the four shipped fixtures do
// not cover on disk — every one of them is a one-field mutation of the clean
// document, so writing them as files would say nothing the mutation does not.
async function mutateClean(mutate) {
  const doc = JSON.parse(await readFixture('container-show-clean.json'));
  mutate(doc, doc.resource);
  return JSON.stringify(doc, null, 2);
}

// Refusals are asserted this way rather than with assert.throws alone, because
// half the claim is that NOTHING came back: a parser that returned a defaulted
// shape *and* warned would pass a throws-only assertion in a later refactor.
function expectRefusal(text, options) {
  let result;
  let caught;
  try {
    result = parseContainerDefinition(text, options);
  } catch (err) {
    caught = err;
  }
  assert.equal(result, undefined, 'a refusal must produce no definition at all');
  assert.ok(caught instanceof FixtureError, `expected a FixtureError, got ${caught}`);
  assert.equal(caught.exitCode, EXIT.CONTAINER_DEFINITION);
  assert.ok(caught.exitCode > 0, 'a refusal must carry a nonzero exit code');
  return caught;
}

describe('the shipped az documents', () => {
  it('measures the clean document: partition key path, TTL, and no drift', async () => {
    const definition = parseContainerDefinition(await readFixture('container-show-clean.json'));

    assert.equal(definition.containerName, 'temperatures');
    assert.equal(definition.partitionKeyPath, '/deviceId');
    // The body field the sender must spell. Nothing between the device and
    // Cosmos injects a partition key, so this is derived from the container
    // rather than assumed.
    assert.equal(definition.partitionKeyField, 'deviceId');
    assert.equal(definition.partitionKeyKind, 'Hash');
    assert.equal(definition.partitionKeyVersion, 1);
    assert.equal(definition.measuredDefaultTtl, 604800);
    assert.equal(definition.ttlExpires, true);
    assert.equal(definition.declaredDefaultTtl, 604800);
    assert.equal(definition.ttlDriftFinding, null);
    assert.deepEqual(definition.findings, []);
  });

  it('measures the drifted TTL and reports it, naming BOTH numbers', async () => {
    const definition = parseContainerDefinition(await readFixture('container-show-ttl-drift.json'));

    // The MEASURED value is what comes back and what the evidence records. The
    // declared value is a comparand and nothing else.
    assert.equal(definition.measuredDefaultTtl, 86400);
    assert.equal(definition.declaredDefaultTtl, 604800);
    assert.notEqual(definition.measuredDefaultTtl, definition.declaredDefaultTtl);

    const finding = definition.ttlDriftFinding;
    assert.ok(finding, 'drift must be reported, not silently adopted');
    assert.equal(finding.kind, 'ttl-drift');
    assert.equal(finding.measured, 86400);
    assert.equal(finding.declared, 604800);
    assert.match(finding.message, /86400/);
    assert.match(finding.message, /604800/);
    assert.deepEqual(definition.findings, [finding]);
  });

  it('treats drift as a finding, not a failure — the proof can still traverse', async () => {
    // Deliberate: a container that really holds a different retention is still a
    // container this proof can send through. Halting here would block the only
    // end-to-end traversal the product has over a number that was recorded.
    const definition = parseContainerDefinition(await readFixture('container-show-ttl-drift.json'));
    assert.equal(definition.partitionKeyPath, '/deviceId');
    assert.equal(definition.ttlExpires, true);
  });

  it('refuses a document with no partition key, measuring nothing', async () => {
    const text = await readFixture('container-show-missing-partition-key.json');
    const err = expectRefusal(text);
    assert.match(err.message, /partitionKey/);

    // That document DOES carry a readable default_ttl — restoring only the
    // partition key makes it parse — and the refusal still returned nothing at
    // all (expectRefusal asserts that). A half-measured container is not a
    // measurement, and there is no partial result for a caller to read past.
    const repaired = JSON.parse(text);
    repaired.resource.partitionKey = { kind: 'Hash', paths: ['/deviceId'], version: 1 };
    assert.equal(parseContainerDefinition(JSON.stringify(repaired)).measuredDefaultTtl, 604800);
  });

  // "Malformed" on disk is the shape an operator actually produces by mistake:
  // `az cosmosdb sql container list` instead of `... container show`, which is a
  // JSON array of containers, one of which really is the destination. Reading
  // the first element (or hunting for the right one) would be a guess.
  //
  // The unparseable-text case is exercised inline below rather than shipped as a
  // .json file on purpose: prettier parses every changed .json in the repo, and
  // `nx format:check` — this repo's configured format gate — exits nonzero on
  // one that cannot be parsed. The behaviour is covered either way.
  it('refuses the `container list` array shape rather than picking an element', async () => {
    const err = expectRefusal(await readFixture('container-show-malformed.json'));
    assert.match(err.message, /array/);
    assert.match(err.message, /container show/);
  });
});

describe('unreadable input is refused, never defaulted', () => {
  it('refuses truncated JSON, reporting where and how much — never the content', () => {
    const truncated = '{\n  "resource": {\n    "defaultTtl": 604800,\n';
    const err = expectRefusal(truncated);
    assert.match(err.message, /not valid JSON/);
    assert.match(err.message, /bytes read/);
  });

  // The likeliest live failure: az errored, wrote to stderr, and the pipe
  // delivered nothing. An empty document read as "no TTL configured" would be
  // exactly the error-becomes-an-absence conflation this ticket refuses.
  it('refuses an empty or absent document instead of reading it as "nothing configured"', () => {
    for (const input of ['', '   ', '\n\n', undefined, null, 42, {}]) {
      const err = expectRefusal(input);
      assert.ok(err.message.length > 0);
    }
  });

  // Placeholders, not credentials — the same spelling fixture-core.test.mjs
  // uses, so a scan of this repo tells the difference at a glance. A redaction
  // cannot be tested without naming the thing being redacted.
  const FAKE_ACCOUNT_KEY = 'not-a-real-account-key-0000AAAAbbbbCCCC==';
  const FAKE_DEVICE_KEY = 'not-a-real-shared-access-key-0000';

  it('echoes none of the input back when the input is not valid JSON', () => {
    // Not a credential — a container definition does not carry one — but the
    // refusal paths hold the same posture as every other operator-facing line in
    // this tool: report the shape, never the content. Node's own JSON
    // SyntaxError quotes the offending slice, so text piped in BY MISTAKE (an
    // operator's shell history is full of documents that do carry secrets) is a
    // real leak risk on precisely this path.
    const wrongPipe = `{"connectionString": "HostName=h;SharedAccessKey=${FAKE_DEVICE_KEY}"`;
    const err = expectRefusal(wrongPipe);
    assert.doesNotMatch(err.message, /not-a-real/);
    assert.doesNotMatch(err.message, /SharedAccessKey/);
    assert.doesNotMatch(err.message, /HostName/);
  });

  it('scrubs a fragment it does echo', async () => {
    const text = await mutateClean((doc, resource) => {
      resource.id = `temperatures AccountKey=${FAKE_ACCOUNT_KEY}`;
    });
    const err = expectRefusal(text, { expectedContainer: 'temperatures' });
    assert.doesNotMatch(err.message, /not-a-real/);
    assert.match(err.message, /\[redacted\]/);
  });

  it('refuses a "resource" that is present but not an object', async () => {
    for (const value of [null, 'temperatures', 7, []]) {
      const text = await mutateClean(doc => {
        doc.resource = value;
      });
      const err = expectRefusal(text);
      assert.match(err.message, /"resource"/);
    }
  });

  it('accepts a document narrowed with --query resource', async () => {
    const doc = JSON.parse(await readFixture('container-show-clean.json'));
    const definition = parseContainerDefinition(JSON.stringify(doc.resource));
    assert.equal(definition.partitionKeyPath, '/deviceId');
    assert.equal(definition.measuredDefaultTtl, 604800);
    assert.equal(definition.containerName, 'temperatures');
  });

  it('refuses a document that is neither an ARM response nor a resource block', () => {
    const err = expectRefusal(JSON.stringify({ status: 'ok', containers: 5 }));
    assert.match(err.message, /neither/);
  });
});

describe('the TTL is measured or refused — never assumed', () => {
  it('refuses a missing default_ttl rather than standing in the declared value', async () => {
    for (const mutate of [
      (doc, resource) => delete resource.defaultTtl,
      (doc, resource) => {
        resource.defaultTtl = null;
      },
    ]) {
      const err = expectRefusal(await mutateClean(mutate));
      assert.match(err.message, /no default_ttl/);
      // The claim that matters: the declared number was not quietly adopted —
      // not as a measurement, and not as a "using 604800 instead" consolation.
      assert.equal(err.message.includes('604800'), false);
    }
  });

  it('refuses a default_ttl that is not an integer number of seconds', async () => {
    for (const value of ['604800', 604800.5, true, {}, []]) {
      const text = await mutateClean((doc, resource) => {
        resource.defaultTtl = value;
      });
      const err = expectRefusal(text);
      assert.match(err.message, /default_ttl/);
    }
  });

  it('refuses values Cosmos cannot hold, rather than recording them', async () => {
    for (const value of [0, -2, -604800]) {
      const text = await mutateClean((doc, resource) => {
        resource.defaultTtl = value;
      });
      const err = expectRefusal(text);
      assert.match(err.message, /not a legal Cosmos value/);
    }
  });

  it('measures -1 as "no expiry" and reports it as drift', async () => {
    const text = await mutateClean((doc, resource) => {
      resource.defaultTtl = -1;
    });
    const definition = parseContainerDefinition(text);
    assert.equal(definition.measuredDefaultTtl, -1);
    // Load-bearing for the evidence record: with no expiry there is no expiry
    // instant to derive, so a later count can never be explained away as TTL.
    assert.equal(definition.ttlExpires, false);
    assert.ok(definition.ttlDriftFinding);
    assert.match(definition.ttlDriftFinding.message, /no expiry/);
    assert.match(definition.ttlDriftFinding.message, /604800/);
  });

  it('reads the underscore spelling too, and refuses when the two disagree', async () => {
    const snake = await mutateClean((doc, resource) => {
      delete resource.defaultTtl;
      resource.default_ttl = 604800;
    });
    assert.equal(parseContainerDefinition(snake).measuredDefaultTtl, 604800);

    const both = await mutateClean((doc, resource) => {
      resource.default_ttl = 86400;
    });
    const err = expectRefusal(both);
    assert.match(err.message, /ambiguous/);
  });

  it('treats the declared value as a comparand only', async () => {
    // Supplying a different declared value moves the drift finding and nothing
    // else: the measurement is unaffected by what the code says it should be.
    const clean = await readFixture('container-show-clean.json');
    const definition = parseContainerDefinition(clean, { declaredDefaultTtl: 86400 });
    assert.equal(definition.measuredDefaultTtl, 604800);
    assert.equal(definition.declaredDefaultTtl, 86400);
    assert.ok(definition.ttlDriftFinding);
    assert.equal(definition.ttlDriftFinding.measured, 604800);
    assert.equal(definition.ttlDriftFinding.declared, 86400);
  });
});

describe('the partition key is measured or refused — never assumed', () => {
  it('refuses a partition key this fixture cannot address as one flat body field', async () => {
    const cases = [
      ['hierarchical', (doc, r) => (r.partitionKey.paths = ['/tenantId', '/deviceId'])],
      ['nested path', (doc, r) => (r.partitionKey.paths = ['/telemetry/deviceId'])],
      ['no leading slash', (doc, r) => (r.partitionKey.paths = ['deviceId'])],
      ['bare slash', (doc, r) => (r.partitionKey.paths = ['/'])],
      ['non-string path', (doc, r) => (r.partitionKey.paths = [7])],
      ['empty paths', (doc, r) => (r.partitionKey.paths = [])],
      ['paths not an array', (doc, r) => (r.partitionKey.paths = '/deviceId')],
      ['no paths at all', (doc, r) => delete r.partitionKey.paths],
      ['partitionKey not an object', (doc, r) => (r.partitionKey = '/deviceId')],
      ['MultiHash kind', (doc, r) => (r.partitionKey.kind = 'MultiHash')],
      ['unquotable field', (doc, r) => (r.partitionKey.paths = ['/device"Id'])],
    ];
    for (const [label, mutate] of cases) {
      const err = expectRefusal(await mutateClean(mutate));
      assert.ok(err.message.length > 0, label);
    }
  });

  // The measurement and the sender used to hold DIFFERENT ideas of a legal
  // field: a hyphenated or digit-leading path measured cleanly here and was then
  // refused downstream as EXIT.USAGE — "bad arguments, nothing live happened" —
  // when the truth was that the MEASURED container has a shape this fixture
  // cannot address. Both halves are asserted: the refusal happens, and it
  // happens with THIS module's code.
  it('refuses a field the sender could not spell, with the measurement code and never USAGE', async () => {
    const unusable = [
      ['hyphenated', '/device-id'],
      ['leading digit', '/2deviceId'],
      ['dotted', '/device.id'],
      ['spaced', '/device id'],
      // Landing the partition key on a contract field would overwrite the marker
      // or the run id and silently destroy the correlation.
      ['reserved: id', '/id'],
      ['reserved: the marker itself', `/${SYNTHETIC_MARKER_FIELD}`],
      ['reserved: the run correlator', `/${RUN_ID_FIELD}`],
      ['reserved: ticket', '/ticket'],
    ];
    for (const [label, path] of unusable) {
      const err = expectRefusal(await mutateClean((doc, r) => (r.partitionKey.paths = [path])));
      // expectRefusal already asserts CONTAINER_DEFINITION; spelled out again
      // here because the defect being guarded against was the CODE, not the
      // presence of a refusal.
      assert.equal(err.exitCode, EXIT.CONTAINER_DEFINITION, label);
      assert.notEqual(
        err.exitCode,
        EXIT.USAGE,
        `${label} must not read as "nothing live happened"`
      );
    }
  });

  // The reconciliation itself: one predicate, two callers. A field this module
  // accepts must be a field the sender can build a body from, and vice versa —
  // otherwise the two disagree again and the exit code misreports which refusal
  // occurred.
  it('accepts exactly the fields the sender can spell', async () => {
    for (const field of ['deviceId', 'device_id', '_partition', 'DeviceID']) {
      const definition = parseContainerDefinition(
        await mutateClean((doc, r) => (r.partitionKey.paths = [`/${field}`]))
      );
      assert.equal(definition.partitionKeyField, field);
      assert.equal(partitionKeyFieldProblem(field), null);
      // The sender agrees, which is the whole point of sharing the predicate.
      const [message] = buildFixtureMessages({
        runId: 'mg-67-run-agreement',
        partitionKeyField: definition.partitionKeyField,
        now: () => 0,
      });
      assert.equal(message.body[field], FIXTURE_DEVICE_ID);
    }

    for (const field of ['device-id', '2deviceId', 'id', SYNTHETIC_MARKER_FIELD]) {
      assert.notEqual(
        partitionKeyFieldProblem(field),
        null,
        `${field} is accepted by the shared predicate but refused by the measurement`
      );
    }
  });

  it('carries a partition key with no declared kind or version', async () => {
    const text = await mutateClean((doc, r) => {
      delete r.partitionKey.kind;
      delete r.partitionKey.version;
    });
    const definition = parseContainerDefinition(text);
    assert.equal(definition.partitionKeyPath, '/deviceId');
    assert.equal(definition.partitionKeyKind, null);
    assert.equal(definition.partitionKeyVersion, null);
  });
});

describe('measuring the wrong container is refused', () => {
  it('confirms the document describes the container the operator asked for', async () => {
    const clean = await readFixture('container-show-clean.json');
    const definition = parseContainerDefinition(clean, { expectedContainer: 'temperatures' });
    assert.equal(definition.containerName, 'temperatures');
  });

  it('refuses a document describing some other container, naming both', async () => {
    const text = await mutateClean((doc, resource) => {
      resource.id = 'sessions';
      doc.name = 'sessions';
    });
    const err = expectRefusal(text, { expectedContainer: 'temperatures' });
    assert.match(err.message, /sessions/);
    assert.match(err.message, /temperatures/);
  });

  it('refuses an unnamed document when a container was expected', async () => {
    const text = await mutateClean((doc, resource) => {
      delete resource.id;
      delete doc.name;
    });
    const err = expectRefusal(text, { expectedContainer: 'temperatures' });
    assert.match(err.message, /names no container/);
  });

  it('does not require a name when none was expected', async () => {
    const text = await mutateClean((doc, resource) => {
      delete resource.id;
      delete doc.name;
    });
    const definition = parseContainerDefinition(text);
    assert.equal(definition.containerName, null);
    assert.equal(definition.partitionKeyPath, '/deviceId');
  });
});

describe('the declared value exists only to be compared against', () => {
  it('derives the declared retention from the Terraform variable it mirrors', () => {
    assert.equal(SECONDS_PER_DAY, 86400);
    assert.equal(DECLARED_TTL_DAYS, 7);
    assert.equal(DECLARED_DEFAULT_TTL_SECONDS, DECLARED_TTL_DAYS * SECONDS_PER_DAY);
    // environments/dev.tfvars: temperature_data_ttl_days = 7.
    assert.equal(DECLARED_DEFAULT_TTL_SECONDS, 604800);
  });

  // The acceptance check for HR4, done against the source text: a fallback is a
  // literal somebody typed, so the absence of the literal is the strongest form
  // this check takes. The partition key path appears NOWHERE in the module —
  // not in code, not in a comment — and the retention exists only as the
  // days-times-seconds product used for the drift comparison.
  it('hardcodes no partition key path and no retention fallback', async () => {
    const source = await readLocal('./container-definition.mjs');
    assert.equal(
      /deviceid/i.test(source),
      false,
      'container-definition.mjs names a partition key path; it must measure one'
    );
    assert.equal(
      source.includes('604800'),
      false,
      'container-definition.mjs carries a retention literal; the declared value must be derived'
    );
    // And the one place seconds-per-day appears is that derivation.
    assert.equal(source.split('86400').length - 1, 1);
  });

  // The evidence-emission contract requires a record on EVERY outcome once a
  // message has been attempted. The evidence builder refuses a definition that
  // is missing any of the three fields below, so a partial measurement would
  // turn a post-send failure into a run with live effect and NO artifact — the
  // hole the contract closes. This module's half of that guarantee is
  // complete-or-absent: whatever it returns carries all three, and whatever it
  // cannot read fully it refuses outright.
  //
  // Asserted over every shipped fixture plus every mutation the rest of this
  // file exercises, so a future reading added to the parser is covered here the
  // moment its case appears above.
  it('measures completely or refuses — never a partial definition', async () => {
    const REQUIRED = ['partitionKeyPath', 'partitionKeyField', 'measuredDefaultTtl'];
    const documents = [];
    for (const name of [
      'container-show-clean.json',
      'container-show-ttl-drift.json',
      'container-show-missing-partition-key.json',
      'container-show-malformed.json',
    ]) {
      documents.push(await readFixture(name));
    }
    for (const mutate of [
      (doc, r) => delete r.defaultTtl,
      (doc, r) => (r.defaultTtl = null),
      (doc, r) => (r.defaultTtl = -1),
      (doc, r) => (r.defaultTtl = 0),
      (doc, r) => (r.defaultTtl = '604800'),
      (doc, r) => (r.default_ttl = 86400),
      (doc, r) => delete r.partitionKey,
      (doc, r) => (r.partitionKey.paths = []),
      (doc, r) => (r.partitionKey.paths = ['/tenantId', '/deviceId']),
      (doc, r) => (r.partitionKey.paths = ['/device-id']),
      (doc, r) => (r.partitionKey.paths = ['/id']),
      (doc, r) => {
        delete r.partitionKey.kind;
        delete r.partitionKey.version;
      },
      (doc, r) => {
        delete r.id;
        delete doc.name;
      },
      doc => (doc.resource = null),
    ]) {
      documents.push(await mutateClean(mutate));
    }
    documents.push('', '   ', '{"resource": {', JSON.stringify({ status: 'ok' }));

    let measured = 0;
    let refused = 0;
    for (const text of documents) {
      let definition;
      try {
        definition = parseContainerDefinition(text);
      } catch (err) {
        // A refusal is a refusal of the WHOLE reading: no object escapes for a
        // caller to read a half-measurement out of.
        assert.ok(err instanceof FixtureError);
        assert.equal(err.exitCode, EXIT.CONTAINER_DEFINITION);
        assert.equal(definition, undefined);
        refused += 1;
        continue;
      }
      for (const field of REQUIRED) {
        assert.notEqual(definition[field], undefined, `measured definition lacks ${field}`);
        assert.notEqual(definition[field], null, `measured definition has a null ${field}`);
      }
      measured += 1;
    }
    // Both halves of the property were actually exercised — a matrix that only
    // refused, or only measured, would pass the loop while proving one thing.
    assert.ok(measured >= 4, `expected several complete measurements, got ${measured}`);
    assert.ok(refused >= 8, `expected several refusals, got ${refused}`);
  });

  it('measures the same document the same way every time, and mutates nothing', async () => {
    const clean = await readFixture('container-show-clean.json');
    const first = parseContainerDefinition(clean);
    const second = parseContainerDefinition(clean);
    assert.deepEqual({ ...first }, { ...second });
    assert.equal(clean, await readFixture('container-show-clean.json'));
    // The measurement is a fact, so downstream code cannot edit it into another
    // one on its way to the evidence record.
    assert.equal(Object.isFrozen(first), true);
    assert.throws(() => {
      first.measuredDefaultTtl = 1;
    });
  });
});

describe('the operator-facing summary', () => {
  it('states the measurement and whether it agrees with the declared value', async () => {
    const clean = parseContainerDefinition(await readFixture('container-show-clean.json'));
    const line = describeContainerDefinition(clean);
    assert.match(line, /temperatures/);
    assert.match(line, /\/deviceId/);
    assert.match(line, /604800s \(measured\)/);
    assert.match(line, /matches the declared/);

    const drifted = parseContainerDefinition(await readFixture('container-show-ttl-drift.json'));
    const driftLine = describeContainerDefinition(drifted);
    assert.match(driftLine, /DRIFT/);
    assert.match(driftLine, /86400/);
    assert.match(driftLine, /604800/);
  });

  it('says so plainly when the container has no expiry at all', async () => {
    const text = await mutateClean((doc, resource) => {
      resource.defaultTtl = -1;
    });
    const line = describeContainerDefinition(parseContainerDefinition(text));
    assert.match(line, /no expiry/);
  });
});

describe('module boundaries', () => {
  // This tier runs in validate-infrastructure, which installs nothing and holds
  // no credential. An Azure package import here would make that job unrunnable;
  // an import from cosmos-export would couple this one-off proof to MG-66's live
  // deletion gate.
  it('imports no Azure package and nothing from cosmos-export', async () => {
    const source = await readLocal('./container-definition.mjs');
    const specifiers = [
      ...[...source.matchAll(/^\s*(?:import|export)\b[^\n]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(
        m => m[1]
      ),
      ...[...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1]),
      ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ];
    assert.ok(specifiers.length > 0, 'the import scan found nothing to check');
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./'),
        `container-definition.mjs imports ${specifier}`
      );
      assert.doesNotMatch(specifier, /cosmos-export/);
    }
  });

  it('reads no file, spawns nothing and opens no socket — it consumes text', async () => {
    const source = await readLocal('./container-definition.mjs');
    for (const pattern of [
      /readFile/,
      /readFileSync/,
      /spawn/,
      /execFile/,
      /fetch\(/,
      /process\./,
    ]) {
      assert.equal(pattern.test(source), false, `container-definition.mjs matches ${pattern}`);
    }
  });
});
