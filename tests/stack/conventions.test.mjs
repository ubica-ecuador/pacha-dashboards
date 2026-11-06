// Every dashboard here follows Pacha's conventions (../pacha/dashboards/README.md):
// file name = uid, a description, tags from the vocabulary with an engine, and
// `plus` on whatever draws a Kepler Plus panel. Needs no stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const files = readdirSync(new URL('../../dashboards/', import.meta.url)).filter((f) => f.endsWith('.json'));
const vocabulary = readFileSync(new URL('../../../pacha/dashboards/README.md', import.meta.url), 'utf8');
const tags = new Set([...vocabulary.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
const ENGINES = ['chaski', 'duckdb', 'infinity', 'mqtt'];
const PLUS_PANELS = ['ubica-keplerplus-panel', 'ubica-timebrush-panel'];

for (const file of files) {
  test(`${file} follows the conventions`, () => {
    const dashboard = loadDashboard(`dashboards/${file}`);
    assert.equal(`${dashboard.metadata.name}.json`, file);
    assert.ok(dashboard.spec.description, 'description');
    const own = dashboard.spec.tags ?? [];
    for (const tag of own) assert.ok(tags.has(tag), `tag ${tag} is not in Pacha's vocabulary`);
    assert.ok(own.some((t) => ENGINES.includes(t)), 'an engine tag');
    const plus = findAll(dashboard, (n) => PLUS_PANELS.includes(n.type) || PLUS_PANELS.includes(n.vizConfig?.group)).length > 0;
    assert.equal(own.includes('plus'), plus, plus ? 'a Plus panel needs the plus tag' : 'plus tag without a Plus panel');
  });
}
