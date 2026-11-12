// The mtr-admiralty dashboard: Admiralty station of Hong Kong's MTR on a Kepler Plus map with
// Floors, from the Lands Department's 3D Indoor Map (datasets/mtr-admiralty), with the trains at
// its eight platforms placed from MTR's Next Train API (through the gateway's /mtr/nexttrain/).
// The figures are checked against the station: eight floors from the South Island Line 34 m under
// the street to the landscape deck, four lines on eight platforms, platforms about 180 m long for
// the Island and Tsuen Wan lines' eight cars. MTR runs from about 06:00 to 01:00 Hong Kong time:
// the train test pretends it is just before the next train it lists, so it passes at night too.
// It needs Kepler Plus: without it, the Grafana tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'mtr-admiralty';
const DS = 'http://feeds/datasets/mtr-admiralty';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = Object.values(dashboard.spec.elements).flatMap((e) => e.spec.data.spec.queries);
const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
// Admiralty and around it.
const INSIDE = (g) => `ST_Within(${g}, ST_MakeEnvelope(114.162, 22.276, 114.170, 22.281))`;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'duckdb', 'kepler', 'live', 'plus', 'transit']);
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g)) {
      assert.ok(url.startsWith(`'${DS}/`) || url === "'http://feeds/mtr/nexttrain/'", url);
    }
  }
  const floors = map.vizConfig.spec.options.floors;
  assert.equal(floors.enabled, true);
  assert.deepEqual([floors.variable, floors.selectVariable, floors.selectField], ['floor', 'platform', 'platform']);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the station: eight floors, four lines on eight platforms, all at Admiralty', { timeout: 120_000 }, async () => {
  const floors = await duckdb(STACK_URL, `SELECT level::DOUBLE AS level, z_mpd FROM '${DS}/floors.parquet' ORDER BY level`);
  assert.deepEqual(floors.map((f) => f.level), [-6, -5, -4, -3, -2, -1, 0, 1]);
  assert.ok(floors[0].z_mpd < -30 && floors[7].z_mpd > 10, 'L6 over 30 m under the datum, U1 over 10 m above');
  const platforms = await duckdb(STACK_URL, `SELECT plat::DOUBLE AS plat, line, level::DOUBLE AS level, platform_m, train_m, cars::DOUBLE AS cars FROM '${DS}/platforms.parquet' ORDER BY plat`);
  assert.deepEqual(platforms.map((p) => p.line), ['TWL', 'ISL', 'ISL', 'TWL', 'SIL', 'SIL', 'EAL', 'EAL']);
  assert.deepEqual(platforms.map((p) => p.level), [-3, -3, -2, -2, -6, -6, -5, -5]);
  for (const p of platforms.filter((x) => x.cars === 8)) assert.ok(p.platform_m > 170 && p.platform_m < 200, JSON.stringify(p));
  for (const p of platforms) assert.ok(p.train_m > 50 && p.train_m < p.platform_m, JSON.stringify(p));
  const [shapes] = await duckdb(STACK_URL, `
    SELECT (SELECT count(*) FROM '${DS}/units.parquet')::DOUBLE AS units,
           (SELECT count(*) FROM '${DS}/units.parquet' WHERE kind = 'Escalator')::DOUBLE AS escalators,
           (SELECT count(*) FROM '${DS}/units.parquet' WHERE NOT ${INSIDE('ST_GeomFromGeoJSON(geometry)')})::DOUBLE AS units_outside,
           (SELECT count(*) FROM '${DS}/slices.parquet' WHERE NOT ${INSIDE('ST_GeomFromGeoJSON(geometry)')})::DOUBLE AS slices_outside,
           (SELECT min(n) FROM (SELECT count(*) AS n FROM '${DS}/slices.parquet' GROUP BY plat))::DOUBLE AS fewest_slices,
           (SELECT count(*) FROM '${DS}/points.parquet' WHERE kind = 'Exit')::DOUBLE AS exits`);
  assert.ok(shapes.units > 200 && shapes.units < 300, `${shapes.units} units`);
  assert.ok(shapes.escalators > 50, `${shapes.escalators} escalators`);
  assert.equal(shapes.units_outside, 0);
  assert.equal(shapes.slices_outside, 0);
  assert.ok(shapes.fewest_slices > 150, `a platform's track only ${shapes.fewest_slices} m`);
  assert.ok(shapes.exits >= 6, `${shapes.exits} exits`);
});

test('the next trains come through the gateway, cached', { timeout: 120_000 }, async () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', 'http://feeds/mtr/nexttrain/ISL/ADM']);
  assert.match(headers(), /200/);
  assert.match(headers(), /X-Cache-Status: HIT/i);
  // Day or night, MTR lists the next trains of every platform but 8 (East Rail arrivals, by day only).
  const rows = await duckdb(STACK_URL, mapSql('F'));
  assert.equal(rows.length, 8);
  assert.ok(rows.filter((r) => /min|at \d\d:\d\d|arriving|platform|leaving/.test(r.sign)).length >= 6, JSON.stringify(rows));
});

test('a train due in 10 s is on its platform\'s track, its cars apart', { timeout: 120_000 }, async () => {
  // The clock set 10 s before the first train MTR lists, wherever it is due.
  const sql = mapSql('E').replaceAll('epoch(now())', '((SELECT min(epoch(due)) FROM next) - 10)');
  const rows = await duckdb(STACK_URL, sql);
  assert.ok(rows.length > 50, `${rows.length} slices`);
  const trains = new Map(rows.map((r) => [r.platform, r]));
  for (const [platform, r] of trains) {
    assert.ok(['Arriving', 'At the platform'].includes(r.state), `${platform}: ${r.state}`);
    const cars = new Set(rows.filter((x) => x.platform === platform).map((x) => x.car));
    assert.ok(cars.size >= 3 && cars.size <= 9, `${platform}: ${cars.size} cars`);
  }
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    for (const title of ['Admiralty, floor by floor, and its trains now', 'Next trains', 'Is the feed live?']) await view.panel(title);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
