#!/usr/bin/env node
// Parses every ```mermaid block in a Markdown file with the pinned Mermaid 11 (this package's
// devDependency), in Node under jsdom. `likec4 gen mmd` emits Mermaid 11 syntax
// (`id@{ shape: ..., label: ... }`), which older renderers reject; this proves every block
// in the generated diagrams.md is valid for Mermaid 11.
//
// Usage: node scripts/check-mermaid.mjs [file]   (default: docs/architecture/diagrams.md)
//
// Exit codes: 0 every block parses, 1 a block failed to parse (each one is named by its
// line and the `##` section it sits in), 2 the file is missing or holds no mermaid block.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv[2] ?? resolve(PACKAGE_DIR, '..', 'diagrams.md'));

if (!existsSync(file)) {
  console.error(`check-mermaid: ${file} does not exist`);
  process.exit(2);
}

/** Every ```mermaid block: its first line number, the `##` heading above it, and its text. */
function blocks(text) {
  const lines = text.split('\n');
  const found = [];
  let heading = '(before any section)';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) heading = lines[i].slice(3);
    if (lines[i].trim() !== '```mermaid') continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end].trim() !== '```') end++;
    found.push({ line: i + 1, heading, source: lines.slice(start, end).join('\n') });
    i = end;
  }
  return found;
}

const found = blocks(readFileSync(file, 'utf8'));
if (found.length === 0) {
  console.error(`check-mermaid: ${file} has no mermaid blocks`);
  process.exit(2);
}

// Mermaid needs a DOM (DOMPurify) even to parse.
const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import('mermaid');
const MERMAID_VERSION = JSON.parse(
  readFileSync(resolve(PACKAGE_DIR, 'node_modules', 'mermaid', 'package.json'), 'utf8')
).version;
mermaid.initialize({ startOnLoad: false });

const failures = [];
for (const b of found) {
  try {
    await mermaid.parse(b.source);
  } catch (err) {
    failures.push(
      `  line ${b.line}, section "${b.heading}":\n    ${String(err?.message ?? err)
        .split('\n')
        .join('\n    ')}`
    );
  }
}

if (failures.length) {
  console.error(
    `check-mermaid: ${failures.length} of ${found.length} mermaid block(s) in ${file} do not parse with Mermaid ${MERMAID_VERSION}:\n${failures.join('\n')}`
  );
  process.exit(1);
}
console.log(
  `check-mermaid: OK, all ${found.length} mermaid blocks parse with Mermaid ${MERMAID_VERSION}`
);
