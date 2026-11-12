// The mbta-south-station dashboard: Boston's South Station on a Kepler Plus map with Floors,
// from MBTA's GTFS (levels, pathways, elevators and escalators) and OpenStreetMap (platforms,
// tracks, rooms) in datasets/mbta-south-station, with MBTA's live vehicle positions and service
// alerts through the gateway (/mbta/realtime/). The figures are checked against the station:
// six floors from the Red Line platforms to the bus terminal, Commuter Rail tracks 1 to 13, the
// Red Line's two tracks beside platforms 70079 and 70080, some twenty elevators and escalators.
// It needs Kepler Plus: without it, the Grafana tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'mbta-south-station';
const DS = 'http://feeds/datasets/mbta-south-station';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = Object.values(dashboard.spec.elements).flatMap((e) => e.spec.data.spec.queries);
const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
// South Station's block.
const INSIDE = (g) => `ST_Within(${g}, ST_MakeEnvelope(-71.0600, 42.3470, -71.0510, 42.3550))`;

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
      assert.ok(url.startsWith(`'${DS}/`) || url.startsWith("'http://feeds/mbta/realtime/"), url);
    }
  }
  const floors = map.vizConfig.spec.options.floors;
  assert.equal(floors.enabled, true);
  assert.equal(floors.groundFloor, 'picked');
  assert.deepEqual([floors.variable, floors.selectVariable, floors.selectField], ['floor', 'lift', 'lift']);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the station: six floors, thirteen Commuter Rail tracks, the Red Line beside its platforms', { timeout: 120_000 }, async () => {
  const floors = await duckdb(STACK_URL, `SELECT level::DOUBLE AS level FROM '${DS}/floors.parquet' ORDER BY level`);
  assert.deepEqual(floors.map((f) => f.level), [-3, -2, -1, 0, 1, 2]);
  const tracks = await duckdb(STACK_URL, `SELECT track, stop, length_m FROM '${DS}/tracks.parquet' ORDER BY track`);
  assert.equal(tracks.filter((t) => t.track.startsWith('CR-')).length, 13);
  assert.deepEqual(tracks.filter((t) => t.track.startsWith('RL-')).map((t) => t.stop).sort(), ['70079', '70080']);
  for (const t of tracks) assert.ok(t.length_m > 100 && t.length_m < 500, JSON.stringify(t));
  const [counts] = await duckdb(STACK_URL, `
    SELECT (SELECT count(DISTINCT facility) FROM '${DS}/lifts.parquet')::DOUBLE AS lifts,
           (SELECT count(*) FROM '${DS}/areas.parquet' WHERE kind = 'Platform' AND level = 0)::DOUBLE AS cr_platforms,
           (SELECT count(*) FROM '${DS}/slices.parquet' WHERE NOT ${INSIDE('ST_GeomFromGeoJSON(geometry)')})::DOUBLE AS slices_outside,
           (SELECT count(*) FROM '${DS}/areas.parquet' WHERE NOT ${INSIDE('ST_GeomFromGeoJSON(geometry)')})::DOUBLE AS areas_outside`);
  assert.ok(counts.lifts >= 15 && counts.lifts <= 30, `${counts.lifts} elevators and escalators`);
  assert.ok(counts.cr_platforms >= 7, `${counts.cr_platforms} Commuter Rail platforms`);
  assert.equal(counts.slices_outside, 0);
  assert.equal(counts.areas_outside, 0);
});

test('live: every elevator and escalator has a status, trains lie on their tracks', { timeout: 120_000 }, async () => {
  const lifts = await duckdb(STACK_URL, mapSql('C'));
  assert.ok(lifts.length > 20);
  // A column named facility would be read by Floors as a building.
  assert.ok(!('facility' in lifts[0]), 'no facility column on the map');
  for (const l of lifts) assert.ok(['Working', 'Out of service'].includes(l.status), JSON.stringify(l));
  const slices = await duckdb(STACK_URL, mapSql('E'));
  // Trains come and go: when some are drawn, each is whole cars on one track and floor.
  const trains = new Map();
  for (const s of slices) trains.set(s.train, [...(trains.get(s.train) ?? []), s]);
  for (const [train, rows] of trains) {
    assert.equal(new Set(rows.map((r) => r.track)).size, 1, `${train} on one track`);
    assert.ok(rows.length > 30 && rows.length <= 7 * 26, `${train}: ${rows.length} m of train`);
    assert.ok(rows.every((r) => r.level === (r.line === 'Red Line' ? -3 : 0)), `${train} on its floor`);
  }
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    for (const title of ['South Station, floor by floor, live', 'Elevators and escalators', 'Is the feed live?']) await view.panel(title);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
