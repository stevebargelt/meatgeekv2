import * as fs from 'fs';
import * as path from 'path';

import type { OpenAPIV3 } from 'openapi-types';

// CommonJS modules; require them as such (see spec-validates.spec.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SwaggerParser: typeof import('@apidevtools/swagger-parser') = require('@apidevtools/swagger-parser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bundleForIos, IOS_BUNDLE_PATH, RUN_COMMAND } = require('../scripts/bundle-for-ios') as {
  bundleForIos: () => Promise<string>;
  IOS_BUNDLE_PATH: string;
  RUN_COMMAND: string;
};

// The iOS app generates its API client from a one-file bundle of the spec,
// committed at apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml. These
// checks fail when that copy is out of date with libs/api-specs/spec, so a
// contract change cannot reach main without the iOS client being regenerated
// from it (and the app then failing to compile if it no longer fits).
describe('iOS API client bundle', () => {
  let expected: string;

  beforeAll(async () => {
    expected = await bundleForIos();
  });

  it('the committed bundle matches the spec', () => {
    const relative = path.relative(path.resolve(__dirname, '..', '..', '..'), IOS_BUNDLE_PATH);
    if (!fs.existsSync(IOS_BUNDLE_PATH)) {
      throw new Error(`${relative} is missing. Run \`${RUN_COMMAND}\` and commit the result.`);
    }
    const committed = fs.readFileSync(IOS_BUNDLE_PATH, 'utf8');
    if (committed !== expected) {
      const committedLines = committed.split('\n');
      const expectedLines = expected.split('\n');
      const line = expectedLines.findIndex((text, index) => committedLines[index] !== text);
      throw new Error(
        [
          `${relative} is out of date with libs/api-specs/spec.`,
          `Run \`${RUN_COMMAND}\` and commit the result.`,
          `First difference at line ${line + 1}:`,
          `  committed: ${JSON.stringify(committedLines[line])}`,
          `  expected:  ${JSON.stringify(expectedLines[line])}`,
        ].join('\n'),
      );
    }
  });

  it('the bundle is one valid document with only component references', async () => {
    const yaml = expected.replace(/^#.*\n/gm, '');
    const refs = [...yaml.matchAll(/\$ref: '?([^'\n]+)'?/g)].map(match => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter(ref => !/^#\/components\/[^/]+\/[^/]+$/.test(ref))).toEqual([]);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const document = require('js-yaml').load(yaml) as OpenAPIV3.Document;
    const api = (await SwaggerParser.validate(document)) as OpenAPIV3.Document;
    // The SignalR messages are generated as Swift types; later issues decode
    // hub messages with them.
    expect(Object.keys(api.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        'TemperatureMessage',
        'CookStartedMessage',
        'CookStoppedMessage',
        'SignalRConnectionInfo',
      ]),
    );
  });

  it('bundles the same text twice', async () => {
    expect(await bundleForIos()).toBe(expected);
  });
});
