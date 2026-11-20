/* eslint-disable */
// jsdom does not implement the Fetch API, and openapi-fetch builds real
// Request objects. Borrow Node's implementations (Node >= 20) so the API client
// runs unmodified under test; each test still replaces `fetch` with a mock.
const { TestEnvironment } = require('jest-environment-jsdom');

const FROM_NODE = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'ReadableStream',
  'TextEncoder',
  'TextDecoder',
  'structuredClone',
];

class WebTestEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of FROM_NODE) {
      if (typeof this.global[name] === 'undefined') {
        this.global[name] = globalThis[name];
      }
    }
    if (typeof this.global.crypto?.randomUUID !== 'function') {
      Object.defineProperty(this.global, 'crypto', {
        value: globalThis.crypto,
        configurable: true,
      });
    }
  }
}

module.exports = WebTestEnvironment;
