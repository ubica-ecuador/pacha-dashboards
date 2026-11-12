// The wivenhoe-pumped-hydro dashboard: Wivenhoe pumped storage station from AEMO's five-minute
// SCADA (Pacha's recorder, feed aemo-scada), on a Kepler Plus map with a 4D Model in State mode
// and Floors, from the model and tables datasets/wivenhoe/build.sh makes. It needs Kepler Plus,
// the recorder and the built files: without them, the tests that need them are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'wivenhoe-pumped-hydro';
const MAP = 'Wivenhoe at the end of the window, floor by floor';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const noPlus = plus.status === 404 && 'Kepler Plus is not mounted';
const recorded = await duckdb(
  STACK_URL,
  `SELECT url FROM read_json('http://feeds/recordings/aemo-scada/manifest.json',
     columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})
   WHERE "to" >= now() - INTERVAL 25 HOUR`,
).catch(() => []);
const built = await duckdb(STACK_URL, "SELECT count(*) AS n FROM 'http://feeds/datasets/wivenhoe/units.parquet'").then(
  () => true,
  () => false,
);
const skip =
  (!built && 'datasets/wivenhoe/build.sh has not been run') ||
  (recorded.length === 0 && 'the recorder has no AEMO SCADA of the last day (COMPOSE_PROFILES=recorder)');

// A query as Grafana sends it: the recorded files of the last day in place of $files, the last day as the range.
const files = () =>
  [...recorded.map((r) => r.url), 'http://feeds/recordings/aemo-scada-empty.parquet'].map((u) => `'${u}'`).join(', ');
const bound = (sql) =>
  sql
    .replaceAll('${files:singlequote}', files())
    .replaceAll('$__timeFrom()', '(now() - INTERVAL 1 DAY)')
    .replaceAll('$__timeTo()', 'now()');
const sqlOf = (panel, refId = 'A') =>
  bound(panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'duckdb', 'energy', 'kepler', 'live', 'plus', 'water']);
  for (const q of findAll(dashboard, (n) => n.kind === 'DataQuery' && n.datasource)) {
    assert.ok(['duckdb', '-- Grafana --'].includes(q.datasource.name), q.datasource.name);
  }
  // The readings come from the recorder through the gateway; nothing asks AEMO from a panel.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  assert.doesNotMatch(sql, /nemweb\.com\.au/);
  const options = map.vizConfig.spec.options;
  assert.equal(options.floors.enabled, true);
  assert.equal(options.floors.variable, 'floor');
  const model = options.mapConfig.config.visState.layers.find((l) => l.type === 'model4d');
  assert.equal(model.config.visConfig.modelMode, 'state');
  assert.match(model.config.visConfig.modelUrl, /^https:\/\/[^/]+\/datasets\/wivenhoe\/model\.glb/);
});

test('is provisioned in Pacha dashboards', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the model has every part the map names, and the gateway serves it as glTF', { skip }, async () => {
  const parts = await duckdb(STACK_URL, "SELECT * FROM 'http://feeds/datasets/wivenhoe/parts.parquet'");
  assert.equal(parts.length, 14);
  const res = await fetch(new URL('/datasets/wivenhoe/model.glb', STACK_URL));
  assert.equal(res.status, 200);
  const glb = Buffer.from(await res.arrayBuffer());
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  const nodes = new Set(json.nodes.map((n) => n.name));
  for (const p of parts) assert.ok(nodes.has(p.part), p.part);
  const floors = await duckdb(STACK_URL, sqlOf(map, 'D'));
  assert.deepEqual([...new Set(floors.map((f) => f.level))].sort(), ['-1', '-2', '-3', '0']);
});

test('each unit generates, pumps or idles, never both, within its ratings', { skip, timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf(panelTitled(dashboard, 'Each unit, MW (pumping below zero)')));
  assert.ok(rows.length >= 200, `${rows.length} five-minute readings in a day`);
  for (const r of rows) {
    for (const unit of ['Unit 1', 'Unit 2']) assert.ok(r[unit] >= -260 && r[unit] <= 300, JSON.stringify(r));
  }
  const parts = await duckdb(STACK_URL, sqlOf(map, 'A'));
  assert.equal(parts.length, 14);
  for (const p of parts) assert.ok(['Generating', 'Pumping', 'Idle'].includes(p.state), JSON.stringify(p));
  const water = await duckdb(STACK_URL, sqlOf(map, 'C'));
  assert.deepEqual(water.map((w) => w.name), ['Unit 1', 'Unit 2']);
});

test('the week: the pumps draw more than the generators give back', { skip, timeout: 120_000 }, async () => {
  const week = await duckdb(STACK_URL, sqlOf(brush));
  assert.ok(week.length >= 48, `${week.length} half hours`);
  const pumped = week.reduce((s, h) => s + h.Pumping, 0);
  const generated = week.reduce((s, h) => s + h.Generating, 0);
  // A round trip loses a quarter to a third: generated over pumped between about 0.5 and 0.9 over days.
  assert.ok(generated / pumped > 0.4 && generated / pumped < 1, `${generated} / ${pumped}`);
});

test('opens with no panel in error', { skip: noPlus || skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel(MAP);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
