#!/usr/bin/env node
// Live-versus-decided check for the LikeC4 model (the honesty convention in README.md).
//
// Usage: node scripts/check-honesty.mjs [workspace-dir]   (default: this package's directory)
//
// Exports the computed model with `likec4 export json --skip-layout` and fails (exit 1,
// naming every offender) when:
//
//   1. a view whose id does not end in `Target` and is not `deviceUpdates` draws an edge
//      where either end is tagged #decided or #notBuilt, using a relationship that is not of
//      kind decided, planned or retiring. "Either end" covers the drawn nodes and the ends of
//      every model relationship the edge stands for (an edge between two parents can carry a
//      relationship from a hidden #decided child). A dynamic-view step that matches no model
//      relationship counts as a plain, live one.
//   2. a dynamic view whose id does not end in `Target` has a step whose source or target
//      element is tagged #decided.
//   3. a relationship of kind decided lacks the #decided tag, one of kind planned lacks
//      #notBuilt, or one of kind retiring lacks #retiring.
//
// Exit codes: 0 clean, 1 violations found, 2 the model could not be exported or read.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIKEC4_BIN = join(PACKAGE_DIR, 'node_modules', 'likec4', 'bin', 'likec4.mjs');

const ALLOWED_KINDS = new Set(['decided', 'planned', 'retiring']);
const GUARDED_TAGS = ['decided', 'notBuilt'];
const KIND_TAG = { decided: 'decided', planned: 'notBuilt', retiring: 'retiring' };
const RULE1_EXEMPT = new Set(['deviceUpdates']);

const isTargetView = id => id.endsWith('Target');

function exportModel(workspace) {
  const out = mkdtempSync(join(tmpdir(), 'likec4-honesty-'));
  const file = join(out, 'model.json');
  try {
    const run = spawnSync(
      process.execPath,
      [LIKEC4_BIN, 'export', 'json', workspace, '--skip-layout', '-o', file],
      { encoding: 'utf8' }
    );
    if (run.status !== 0) {
      throw new Error(
        `likec4 export json failed (exit ${run.status}):\n${run.stderr || run.stdout}`
      );
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // A multi-project workspace exports an array of models; a single project, one model.
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Every violation in one exported model, as human-readable strings. */
export function checkModel(model) {
  const violations = [];
  const elements = model.elements ?? {};
  const relations = {
    ...(model.relations ?? {}),
    ...(model.deployments?.relations ?? {}),
  };
  const deploymentElements = model.deployments?.elements ?? {};

  const tagsOfElement = fqn => elements[fqn]?.tags ?? [];
  // A view node is a model element (element and dynamic views) or a deployment node or
  // instance (deployment views); an instance carries the tags of the element it instantiates.
  const tagsOfNode = node => {
    const tags = new Set(node?.tags ?? []);
    const ref = node?.modelRef ?? deploymentElements[node?.id]?.element;
    if (ref) for (const t of tagsOfElement(ref)) tags.add(t);
    return [...tags];
  };
  const relEnd = end =>
    end?.model ?? deploymentElements[end?.deployment]?.element ?? end?.deployment;
  const describeRel = id => {
    const r = relations[id];
    if (!r) return id;
    return `${relEnd(r.source)} -[${r.kind ?? 'plain'}]-> ${relEnd(r.target)} '${r.title ?? ''}'`;
  };
  const guarded = tags => tags.filter(t => GUARDED_TAGS.includes(t));

  // Rule 3: a relationship's kind and its tag agree.
  for (const [id, r] of Object.entries(relations)) {
    const want = KIND_TAG[r.kind];
    if (want && !(r.tags ?? []).includes(want)) {
      violations.push(
        `rule 3: relationship ${describeRel(id)} is of kind ${r.kind} but lacks the #${want} tag`
      );
    }
  }

  for (const [viewId, view] of Object.entries(model.views ?? {})) {
    if (isTargetView(viewId)) continue;
    const nodes = new Map((view.nodes ?? []).map(n => [n.id, n]));

    for (const edge of view.edges ?? []) {
      const src = nodes.get(edge.source);
      const tgt = nodes.get(edge.target);
      const step = `${edge.source} -> ${edge.target} '${edge.label ?? ''}'`;

      // Rule 2: no #decided element in a current-state flow.
      if (view._type === 'dynamic') {
        for (const [end, node] of [
          ['source', src],
          ['target', tgt],
        ]) {
          if (tagsOfNode(node).includes('decided')) {
            violations.push(
              `rule 2: dynamic view ${viewId} step ${edge.id} ${step}: ${end} ${node.id} is tagged #decided`
            );
          }
        }
      }

      // Rule 1: an edge touching a #decided or #notBuilt element must not be drawn as live.
      if (RULE1_EXEMPT.has(viewId)) continue;
      const edgeEndTags = [...tagsOfNode(src), ...tagsOfNode(tgt)];
      const relIds = edge.relations ?? [];
      if (relIds.length === 0) {
        // A dynamic step with no matching model relationship: plain unless the step has a kind.
        const tags = guarded(edgeEndTags);
        if (tags.length > 0 && !ALLOWED_KINDS.has(edge.kind)) {
          violations.push(
            `rule 1: view ${viewId} edge ${step} touches #${tags.join(', #')} but is drawn as ${edge.kind ?? 'plain'} (no decided, planned or retiring relationship behind it)`
          );
        }
        continue;
      }
      for (const relId of relIds) {
        const r = relations[relId];
        if (ALLOWED_KINDS.has(r?.kind)) continue;
        const relEndTags = r
          ? [...tagsOfElement(relEnd(r.source)), ...tagsOfElement(relEnd(r.target))]
          : [];
        const tags = [...new Set(guarded([...edgeEndTags, ...relEndTags]))];
        if (tags.length > 0) {
          violations.push(
            `rule 1: view ${viewId} edge ${step} touches #${tags.join(', #')} but draws relationship ${describeRel(relId)}, which is not of kind decided, planned or retiring`
          );
        }
      }
    }
  }
  return violations;
}

function main() {
  const workspace = resolve(process.argv[2] ?? PACKAGE_DIR);
  let models;
  try {
    models = exportModel(workspace);
  } catch (err) {
    console.error(`check-honesty: ${err.message}`);
    return 2;
  }
  const violations = models.flatMap(m => checkModel(m));
  if (violations.length > 0) {
    console.error(`check-honesty: ${violations.length} violation(s) in ${workspace}:`);
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }
  const views = models.reduce((n, m) => n + Object.keys(m.views ?? {}).length, 0);
  console.log(`check-honesty: OK (${views} views, live and decided kept apart)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
