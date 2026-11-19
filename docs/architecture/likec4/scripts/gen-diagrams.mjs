#!/usr/bin/env node
// Generates docs/architecture/diagrams.md from the LikeC4 model.
//
// Usage:
//   node scripts/gen-diagrams.mjs            write docs/architecture/diagrams.md
//   node scripts/gen-diagrams.mjs --check    regenerate to a temp file and exit 1 if it differs
//                                            byte-for-byte from the committed file
//
// Inputs, all read from the model or this package, none hand-copied:
//   - `likec4 gen mmd`: one Mermaid file per view;
//   - `likec4 export json --skip-layout`: each view's id, title and description;
//   - the "## The honesty convention" section of README.md: the legend.
//
// Output is deterministic: no timestamps, views in a fixed group order, and anything not in
// a fixed order is sorted. Exit codes: 0 ok, 1 stale (--check), 2 the model could not be
// exported or a required input is missing.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..', '..');
const LIKEC4_BIN = join(PACKAGE_DIR, 'node_modules', 'likec4', 'bin', 'likec4.mjs');
const TARGET_FILE = resolve(PACKAGE_DIR, '..', 'diagrams.md');
const README = join(PACKAGE_DIR, 'README.md');

const SITE = 'https://stevebargelt.github.io/meatgeekv2/';
const REGENERATE = 'npm --prefix docs/architecture/likec4 run gen:diagrams';

// Views in each group, in this order. A view in no group lands in "Other views", so a view
// the model gains later is never dropped. `match` takes every view whose id it accepts.
const GROUPS = [
  { title: 'Landscape and containers', ids: ['index', 'system', 'cloud'] },
  {
    title: 'Drill-downs',
    ids: ['edge', 'api', 'data', 'ingest', 'observability', 'pipeline'],
  },
  { title: 'Deployment', ids: ['devDeployment'] },
  {
    title: 'Flows, today',
    ids: [
      'telemetry',
      'cookStart',
      'readHistory',
      'mergeToDeploy',
      'telemetryProof',
      'deviceUpdates',
    ],
  },
  { title: 'Decided, not built', match: id => id.endsWith('Target') },
];

// Last resort for a view whose Mermaid does not parse and cannot be post-processed into
// shape: emit only the site link, with this reason. Empty today: every view parses.
const LINK_ONLY = {};

function run(args) {
  const res = spawnSync(process.execPath, [LIKEC4_BIN, ...args], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    fail(
      2,
      `likec4 ${args[0]} ${args[1]} failed (exit ${res.status}):\n${res.stderr || res.stdout}`
    );
  }
}

class GenError extends Error {}

function fail(code, message) {
  throw Object.assign(new GenError(message), { exitCode: code });
}

function exportModel(tmp) {
  const mmdDir = join(tmp, 'mmd');
  const jsonFile = join(tmp, 'model.json');
  run(['gen', 'mmd', '.', '-o', mmdDir]);
  run(['export', 'json', '.', '--skip-layout', '-o', jsonFile]);
  const parsed = JSON.parse(readFileSync(jsonFile, 'utf8'));
  if (Array.isArray(parsed)) {
    fail(2, 'expected one LikeC4 project, found several; this generator handles one.');
  }
  return { mmdDir, model: parsed };
}

/** The legend: the honesty-convention section of README.md, up to the checker paragraph. */
function legend() {
  const lines = readFileSync(README, 'utf8').split('\n');
  const start = lines.indexOf('## The honesty convention');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('`scripts/check-honesty.mjs`'));
  if (start < 0 || end < 0) {
    fail(
      2,
      'README.md has no "## The honesty convention" section ending at the' +
        ' "`scripts/check-honesty.mjs` enforces this" paragraph; the legend is read from it.'
    );
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

function descriptionText(view) {
  const d = view.description;
  if (!d) return '';
  const text = typeof d === 'string' ? d : (d.md ?? d.txt ?? '');
  return text.replace(/\r\n/g, '\n').trim();
}

function mermaidFor(mmdDir, viewId) {
  const file = join(mmdDir, `${viewId}.mmd`);
  if (!existsSync(file)) return null;
  // Trailing spaces (likec4 leaves them where it wraps a label) are dropped so that Prettier,
  // run over the repository's Markdown, leaves the generated file unchanged.
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

/** One line of model text: markdown kept, line breaks folded into spaces. */
const oneLine = d => (d ? (d.md ?? d.txt ?? '') : '').replace(/\s+/g, ' ').trim();

/**
 * A flow's steps, numbered as LikeC4 numbers them (`step-08:par.02` is 8b), with each step's
 * notes and the view it opens. Mermaid flowcharts keep neither the order nor the notes.
 */
function steps(view) {
  const titles = new Map(view.nodes.map(n => [n.id, n.title || n.id]));
  const counts = new Map();
  for (const t of titles.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
  const name = id => {
    const t = titles.get(id) ?? id;
    return counts.get(t) > 1 ? `${t} (\`${id}\`)` : t;
  };
  const number = id => {
    const m = /^step-(\d+)(?::par\.(\d+))?$/.exec(id);
    if (!m) return id;
    const n = String(Number(m[1]));
    return m[2] ? `${n}${String.fromCharCode(96 + Number(m[2]))}` : n;
  };
  const out = ['Steps:', ''];
  for (const e of view.edges) {
    let line = `- **${number(e.id)}.** ${name(e.source)} → ${name(e.target)}`;
    if (e.label) line += `: ${e.label.replace(/\s+/g, ' ').trim()}`;
    const notes = oneLine(e.notes);
    if (notes) line += `. ${notes}`;
    if (e.navigateTo) line += ` (Opens \`${e.navigateTo}\`.)`;
    out.push(line);
  }
  out.push('');
  return out;
}

function section(view, mmdDir) {
  const out = [`## ${view.title || view.id}`, ''];
  const desc = descriptionText(view);
  if (desc) out.push(desc, '');
  out.push(`View \`${view.id}\` on the site: ${SITE}#/view/${view.id}/`, '');
  const mermaid = mermaidFor(mmdDir, view.id);
  const reason =
    LINK_ONLY[view.id] ??
    (mermaid === null ? '`likec4 gen mmd` produced no Mermaid for it.' : null);
  if (reason) {
    out.push(`No Mermaid for this view: ${reason} Open it on the site instead.`, '');
  } else {
    out.push('```mermaid', mermaid, '```', '');
  }
  if (view._type === 'dynamic') out.push(...steps(view));
  return out.join('\n');
}

function render(model, mmdDir) {
  const views = Object.values(model.views);
  const byId = new Map(views.map(v => [v.id, v]));
  const placed = new Set();

  // Within a `match` group or "Other views": static and deployment views first, then flows,
  // each sorted by id, so the order never depends on the order of the export.
  const ordered = list =>
    [...list].sort(
      (a, b) =>
        Number(a._type === 'dynamic') - Number(b._type === 'dynamic') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

  const groups = [];
  for (const g of GROUPS) {
    let members;
    if (g.ids) {
      members = g.ids.filter(id => byId.has(id) && !placed.has(id)).map(id => byId.get(id));
    } else {
      members = ordered(views.filter(v => g.match(v.id) && !placed.has(v.id)));
    }
    members.forEach(v => placed.add(v.id));
    groups.push({ title: g.title, members });
  }
  groups.push({ title: 'Other views', members: ordered(views.filter(v => !placed.has(v.id))) });

  const header = [
    '<!--',
    '  GENERATED FILE. Do not edit by hand: your change will fail `npm run check` and be',
    '  overwritten. Generated from the LikeC4 model in docs/architecture/likec4/ by',
    '  docs/architecture/likec4/scripts/gen-diagrams.mjs. To change a diagram, change the model,',
    `  then regenerate from the repository root: ${REGENERATE}`,
    '-->',
    '',
    '# MeatGeek V2 — Architecture Diagrams',
    '',
    '> **Generated from the [LikeC4 model](likec4/). Do not edit this file by hand.**',
    `> Change the model, then run \`${REGENERATE}\`.`,
    '> `npm run check`, and so CI, fails when this file is stale.',
    '',
    `The interactive site, ${SITE}, is the primary way to read the architecture:`,
    'it draws every view with its styles, shows each element and step with its description,',
    'and links each view to the views below it. This file renders the same views as Mermaid',
    'so that they also show inline on GitHub. Mermaid keeps the fill colours but not the faded',
    'opacity or the dashed and dotted borders the site gives to elements that are not live,',
    "so check the site when an element's state matters. A flow (a dynamic view) is drawn as a",
    'flowchart without step numbers; its numbered steps and their notes follow the diagram.',
    '',
    `${views.length} views, grouped as: ${groups
      .filter(g => g.members.length)
      .map(g => `${g.title} (${g.members.length})`)
      .join(', ')}.`,
    '',
    '**Legend: the honesty convention**, copied from the',
    '[model README](likec4/README.md#the-honesty-convention).',
    '',
    legend(),
    '',
  ];

  const body = [];
  for (const g of groups) {
    if (!g.members.length) continue;
    body.push('---', '', `# ${g.title}`, '');
    for (const v of g.members) body.push(section(v, mmdDir));
  }

  return `${[...header, ...body].join('\n').trimEnd()}\n`;
}

function main() {
  const check = process.argv.slice(2).includes('--check');

  const tmp = mkdtempSync(join(tmpdir(), 'likec4-diagrams-'));
  try {
    const { mmdDir, model } = exportModel(tmp);
    const text = render(model, mmdDir);

    if (!check) {
      writeFileSync(TARGET_FILE, text);
      console.log(
        `gen-diagrams: wrote ${relative(REPO_ROOT, TARGET_FILE)} (${Object.keys(model.views).length} views)`
      );
      return;
    }

    const fresh = join(tmp, 'diagrams.md');
    writeFileSync(fresh, text);
    const committed = existsSync(TARGET_FILE) ? readFileSync(TARGET_FILE) : null;
    const target = relative(REPO_ROOT, TARGET_FILE);
    if (committed && Buffer.compare(committed, readFileSync(fresh)) === 0) {
      console.log(`gen-diagrams: OK, ${target} matches the model`);
      return;
    }
    let where = 'the file is missing';
    if (committed) {
      const a = committed.toString('utf8').split('\n');
      const b = text.split('\n');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      where = `first difference at line ${i + 1}:\n  committed:   ${JSON.stringify(a[i] ?? '<end of file>')}\n  regenerated: ${JSON.stringify(b[i] ?? '<end of file>')}`;
    }
    console.error(
      `gen-diagrams: ${target} is stale: it does not match the LikeC4 model (${where})\n` +
        `Regenerate it with: ${REGENERATE}\nThen commit ${target}. Never edit it by hand.`
    );
    process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof GenError)) throw err;
    console.error(`gen-diagrams: ${err.message}`);
    process.exitCode = err.exitCode;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
