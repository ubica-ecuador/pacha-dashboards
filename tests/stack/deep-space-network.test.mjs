// The deep-space-network dashboard: NASA's Deep Space Network live from DSN Now (through the gateway's /dsn/
// route) and replayed from the recorder's dsn-now feed, its fifteen antennas on Kepler Plus maps, one 4D Model per
// complex whose parts turn to where each antenna pointed at the Time Brush's instant, from the models and table
// datasets/dsn-antennas/build.sh makes. It needs Kepler Plus, the recorder and the built files: without them, the
// tests that need them are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'deep-space-network';
const SITES = { gdscc: 'Goldstone', mdscc: 'Madrid', cdscc: 'Canberra' };
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const noPlus = plus.status === 404 && 'Kepler Plus is not mounted';
const dishes = await duckdb(STACK_URL, "SELECT * FROM 'http://feeds/datasets/dsn-antennas/dishes.parquet'").catch(
  () => null,
);
const notBuilt = !dishes && 'datasets/dsn-antennas/build.sh has not been run';
const feed = await duckdb(
  STACK_URL,
  "SELECT r->>'status' AS status, r->>'body' AS body FROM (SELECT http_get('http://feeds/dsn/dsn.xml') AS r)",
).catch(() => []);
const noFeed = feed[0]?.status !== '200' && 'the gateway has no /dsn/ route yet (restart it) or DSN Now does not answer';
const recorded = await duckdb(
  STACK_URL,
  `SELECT url FROM read_json('http://feeds/recordings/dsn-now/manifest.json',
     columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})
   WHERE "to" >= now() - INTERVAL 25 HOUR`,
).catch(() => []);
const notRecorded = recorded.length === 0 && 'the recorder has no dsn-now recording of the last day (COMPOSE_PROFILES=recorder)';

// A query as Grafana sends it over the last day: the recorded files in place of $files.
const to = Date.now();
const from = to - 86_400_000;
const files = () =>
  [...recorded.map((r) => r.url), 'http://feeds/datasets/dsn-antennas/recording-empty.parquet']
    .map((u) => `'${u}'`)
    .join(', ');
const bound = (sql) =>
  sql
    .replaceAll('${files:singlequote}', files())
    .replaceAll('$__timeFrom()', `'${new Date(from).toISOString()}'`)
    .replaceAll('$__timeTo()', `'${new Date(to).toISOString()}'`)
    .replaceAll('${__from}', String(from))
    .replaceAll('${__to}', String(to));
const sqlOf = (panel, refId = 'A') =>
  bound(panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'live', 'network', 'plus', 'space']);
  for (const q of findAll(dashboard, (n) => n.kind === 'DataQuery' && n.datasource)) {
    assert.ok(['duckdb', '-- Grafana --'].includes(q.datasource.name), q.datasource.name);
  }
  // NASA is read through the gateway only (cached, polite), with http_get: one GET, never a HEAD and a GET.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  assert.doesNotMatch(sql, /eyes\.nasa\.gov/);
  assert.doesNotMatch(sql, /read_text\('http:\/\/feeds\/dsn/);
  assert.equal(maps.length, 4);
  for (const map of maps) {
    const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
    const model = layers.find((l) => l.type === 'model4d');
    assert.equal(model.config.visConfig.modelMode, 'state');
    assert.equal(model.config.visConfig.modelTimeField, 'time');
    // The Time Brush's window is the map's: its end is the instant the antennas stand at.
    assert.equal(map.vizConfig.spec.options.timeSync, 'variables');
    assert.deepEqual(map.vizConfig.spec.options.timeVariables, { from: 't0', to: 't1' });
    assert.match(model.config.visConfig.modelUrl, /^https:\/\/[^/]+\/datasets\/dsn-antennas\/(gdscc|mdscc|cdscc)\.glb/);
    assert.ok(layers.some((l) => l.type === 'callout'));
  }
  const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
  assert.equal(brush.vizConfig.spec.options.output, 'variables');
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  assert.deepEqual(dashboard.spec.variables.map((v) => v.spec.name), ['files', 't0', 't1']);
});

test('the recorder keeps DSN Now, every antenna at its time', { skip: notRecorded, timeout: 60_000 }, async () => {
  const rows = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(DISTINCT hex) AS antennas, max(ts) AS newest,
            count(*) FILTER (WHERE azimuth NOT BETWEEN 0 AND 360 OR elevation NOT BETWEEN -5 AND 90) AS off
     FROM read_parquet([${files()}], union_by_name = true)`,
  );
  assert.ok(rows[0].n > 0);
  assert.ok(rows[0].antennas >= 10 && rows[0].antennas <= 20, `${rows[0].antennas} antennas`);
  assert.equal(rows[0].off, 0);
  // Polled every 30 s: the newest reading is minutes old at most.
  assert.ok(Date.now() - new Date(rows[0].newest).getTime() < 15 * 60_000, String(rows[0].newest));
});

test('is provisioned in Pacha dashboards', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the gateway reads DSN Now and keeps it a few seconds', { skip: noFeed, timeout: 60_000 }, async () => {
  assert.match(feed[0].body, /<dish name="DSS\d+"/);
  assert.match(feed[0].body, /<timestamp>\d{13}<\/timestamp>/);
  const config = await duckdb(STACK_URL, "SELECT r->>'status' AS status FROM (SELECT http_get('http://feeds/dsn/config.xml') AS r)");
  assert.equal(config[0].status, '200');
});

test('the antennas are where the complexes are, and each model has their moving parts', { skip: notBuilt }, async () => {
  assert.ok(dishes.length >= 14 && dishes.length <= 20, `${dishes.length} antennas`);
  for (const d of dishes) {
    assert.ok(SITES[d.site], d.site);
    // Each antenna within 11 km of its complex's model origin (Goldstone's Apollo site is 10 km from DSS-14).
    assert.ok(Math.hypot(d.east_m, d.north_m) < 11_000, `${d.dish} ${d.east_m} ${d.north_m}`);
  }
  for (const site of Object.keys(SITES)) {
    const res = await fetch(new URL(`/datasets/dsn-antennas/${site}.glb`, STACK_URL));
    assert.equal(res.status, 200, site);
    const glb = Buffer.from(await res.arrayBuffer());
    assert.equal(glb.toString('ascii', 0, 4), 'glTF');
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    assert.equal(json.extensionsRequired, undefined, 'no Draco: the 4D Model does not read it');
    const nodes = new Set(json.nodes.map((n) => n.name));
    for (const d of dishes.filter((x) => x.site === site)) {
      for (const part of ['azimuth', 'elevation', 'dish']) assert.ok(nodes.has(`${d.dish}.${part}`), `${d.dish}.${part}`);
    }
  }
});

test('every antenna has a state, and the maps stand every antenna at every instant', { skip: notBuilt || noFeed || notRecorded, timeout: 120_000 }, async () => {
  const table = await duckdb(STACK_URL, sqlOf(panelTitled(dashboard, 'Every antenna now')));
  assert.equal(table.length, dishes.length);
  const states = ['Two-way', 'Receiving', 'Transmitting', 'Pointing', 'Idle or in maintenance'];
  for (const r of table) {
    assert.ok(states.includes(r.State), JSON.stringify(r));
    if (r.Elevation !== null) assert.ok(r.Elevation >= -5 && r.Elevation <= 90, JSON.stringify(r));
    if (r.Azimuth !== null) assert.ok(r.Azimuth >= 0 && r.Azimuth <= 360, JSON.stringify(r));
  }
  // Distance and light time agree: one AU is 499 light seconds.
  const light = await duckdb(STACK_URL, sqlOf(panelTitled(dashboard, 'How long each signal takes to reach Earth')));
  for (const r of light) assert.ok(r['Light time'] > 0.5 && r['Light time'] < 200_000, JSON.stringify(r));
  for (const map of maps) {
    const parts = await duckdb(STACK_URL, sqlOf(map, 'A'));
    const site = map.vizConfig.spec.options.mapConfig.config.visState.layers.find((l) => l.type === 'model4d').config
      .visConfig.modelUrl.match(/(gdscc|mdscc|cdscc)/)[1];
    const instants = new Set(parts.map((p) => p.time)).size;
    assert.equal(parts.length, 2 * dishes.filter((d) => d.site === site).length * instants, map.title);
    for (const p of parts) {
      if (p.part.endsWith('.azimuth')) assert.equal(p.model_pitch, null);
      if (p.part.endsWith('.elevation') && p.model_pitch !== null) assert.ok(p.model_pitch <= 0 && p.model_pitch >= -95);
    }
  }
});

test('opens with no panel in error', { skip: noPlus || notBuilt || noFeed, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('Canberra, Australia: Tidbinbilla');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
