// Bundles the split contract (libs/api-specs/spec/**, external $refs) into the
// one YAML document the iOS app's swift-openapi-generator build plugin reads:
// apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml.
//
// Run it with `npx nx run api-specs:bundle-ios` after changing the spec.
// contract-tests/ios-bundle.spec.ts (in `nx test api-specs`, run in CI) fails
// when the committed file differs from what this script produces.
//
// The output is deterministic: keys keep the spec's source order, nothing
// time- or machine-dependent is written, and running it twice gives the same
// bytes.
//
// Node runs this file directly (`node bundle-for-ios.ts`, Node's built-in type
// stripping), so it is CommonJS with erasable type annotations only: no
// `import`, no enums. The Jest spec requires bundleForIos() and bundles in
// memory.

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
// swagger-parser ships with `export =`.
const SwaggerParser = require('@apidevtools/swagger-parser') as typeof import('@apidevtools/swagger-parser');
const yaml = require('js-yaml') as typeof import('js-yaml');
/* eslint-enable @typescript-eslint/no-var-requires */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'libs', 'api-specs', 'spec', 'openapi.yaml');
const IOS_BUNDLE_PATH = path.join(
  REPO_ROOT,
  'apps',
  'ios',
  'MeatGeekKit',
  'Sources',
  'MeatGeekAPI',
  'openapi.yaml',
);
const RUN_COMMAND = 'npx nx run api-specs:bundle-ios';

const HEADER = [
  '# GENERATED FILE - DO NOT EDIT.',
  '#',
  '# Bundled from libs/api-specs/spec/openapi.yaml by',
  '# libs/api-specs/scripts/bundle-for-ios.ts. Change the spec under',
  `# libs/api-specs/spec/ and run \`${RUN_COMMAND}\`.`,
  '# `npx nx test api-specs` fails when this file is out of date.',
  '#',
  '# swift-openapi-generator (the MeatGeekAPI target\'s build plugin) generates',
  '# the iOS API client from it on every build. Two things the generator cannot',
  '# read are rewritten: $refs that do not point at #/components/<kind>/<name>',
  '# are inlined, and `not: {enum: [0]}` (a "greater than 0" bound) is dropped.',
  '',
].join('\n');

// swift-openapi-generator follows only references of the form
// `#/components/<kind>/<name>`. swagger-parser's bundle() points a repeated
// external reference at the first place it was inlined, which can be under
// `#/paths/...` or inside a schema (`.../TemperatureReading/properties/x`).
// Replace each such reference with a copy of its target. The document's
// meaning is unchanged; only where the definition is written down moves.
const COMPONENT_REF = /^#\/components\/[^/]+\/[^/]+$/;

function resolvePointer(document: Json, ref: string): Json {
  const tokens = ref
    .slice(2)
    .split('/')
    .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: Json = document;
  for (const token of tokens) {
    if (node === null || typeof node !== 'object' || !(token in node)) {
      throw new Error(`bundle-for-ios: cannot resolve ${ref}`);
    }
    node = (node as Record<string, Json>)[token];
  }
  return node;
}

function inlineNonComponentRefs(document: Json): Json {
  const visit = (node: Json, seen: Set<string>): Json => {
    if (Array.isArray(node)) return node.map(item => visit(item, seen));
    if (node === null || typeof node !== 'object') return node;
    const ref = node['$ref'];
    if (typeof ref === 'string' && !COMPONENT_REF.test(ref)) {
      if (!ref.startsWith('#/')) {
        throw new Error(`bundle-for-ios: unexpected external $ref left after bundle: ${ref}`);
      }
      if (seen.has(ref)) throw new Error(`bundle-for-ios: circular $ref ${ref}`);
      const target = resolvePointer(document, ref);
      const siblings = Object.keys(node).filter(key => key !== '$ref');
      if (siblings.length > 0) {
        throw new Error(`bundle-for-ios: $ref ${ref} has sibling keys ${siblings.join(', ')}`);
      }
      return visit(target, new Set([...seen, ref]));
    }
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node)) out[key] = visit(value, seen);
    return out;
  };
  return visit(document, new Set());
}

// swift-openapi-generator does not support the `not` keyword: it warns
// `Schema "not ()" is not supported ... skipping` and drops the whole
// property. The spec uses `not` in one way only, `type: number, minimum: 0,
// not: {enum: [0]}`, to say "greater than 0" (recipe `estimatedDuration`).
// Dropping the property would also make every Recipe fail to decode, since
// Recipe has `additionalProperties: false` and the generated decoder rejects
// unknown keys. The generator enforces no numeric bound anyway (`minimum`
// becomes a plain Double), so removing that `not` changes no generated
// behaviour beyond keeping the property. Any other use of `not` fails the
// bundle, so a new one is looked at rather than silently dropped.
function isNumberNotZero(node: Record<string, Json>): boolean {
  return (
    (node['type'] === 'number' || node['type'] === 'integer') &&
    JSON.stringify(node['not']) === JSON.stringify({ enum: [0] })
  );
}

function stripUnsupportedNot(document: Json): Json {
  const visit = (node: Json, where: string): Json => {
    if (Array.isArray(node)) return node.map((item, index) => visit(item, `${where}/${index}`));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'not' && typeof node['type'] === 'string') {
        if (!isNumberNotZero(node)) {
          throw new Error(
            `bundle-for-ios: unsupported \`not\` at ${where}: swift-openapi-generator drops it; ` +
              'see stripUnsupportedNot in libs/api-specs/scripts/bundle-for-ios.ts',
          );
        }
        continue;
      }
      out[key] = visit(value, `${where}/${key}`);
    }
    return out;
  };
  return visit(document, '#');
}

/** The bundled document, as the exact text written to IOS_BUNDLE_PATH. */
async function bundleForIos(): Promise<string> {
  const bundled = (await SwaggerParser.bundle(SPEC_PATH)) as unknown as Json;
  const document = stripUnsupportedNot(inlineNonComponentRefs(bundled));
  const body = yaml.dump(document, {
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  });
  return HEADER + body;
}

async function main(): Promise<void> {
  const text = await bundleForIos();
  fs.mkdirSync(path.dirname(IOS_BUNDLE_PATH), { recursive: true });
  fs.writeFileSync(IOS_BUNDLE_PATH, text);
  console.log(`Wrote ${path.relative(REPO_ROOT, IOS_BUNDLE_PATH)}`);
}

module.exports = { bundleForIos, IOS_BUNDLE_PATH, RUN_COMMAND };

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
