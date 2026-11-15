// The paris-ride dashboard: a camera crossing Paris one picture a second (a Panoramax sequence,
// datasets/paris-ride), what it has in sight at each picture worked out by Kepler Plus's Viewshed layer
// against the base map's buildings, the picture it took, and the landmarks on the ground it sees
// (Overture's places, through the $visible the layer writes). The Time Brush plays the ride.
// It needs Kepler Plus: without it, the provisioning and browser tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'paris-ride';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const ride = panelTitled(dashboard, 'What the camera sees');
const soFar = panelTitled(dashboard, 'Everything it has had in sight so far');
const photo = panelTitled(dashboard, 'What the camera saw');
const brush = panelTitled(dashboard, 'Play the ride: 15 minutes across Paris');
const now = panelTitled(dashboard, 'At the instant');
const inSight = panelTitled(dashboard, 'In sight now');
const landmarks = panelTitled(dashboard, 'Landmarks in sight');
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const layersOf = (panel) => panel.vizConfig.spec.options.mapConfig.config.visState.layers;
const RIDE = "read_parquet('http://feeds/datasets/paris-ride/ride.parquet')";
const PLACES = "read_parquet('http://feeds/datasets/paris-ride/places.parquet')";
const OPEN_AT = dashboard.spec.variables.find((v) => v.spec.name === 't1').spec.current.value;
// As Grafana sends them: the datasource quotes the variables.
const at = (sql, t1 = OPEN_AT, visible = '') => sql.replaceAll('$t1', `'${t1}'`).replaceAll('$visible', `'${visible}'`);
const IN_PARIS = (r) => r.latitude > 48.83 && r.latitude < 48.88 && r.longitude > 2.33 && r.longitude < 2.365;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'business-text', 'duckdb', 'kepler', 'mobility', 'plus']);
  assert.equal(maps.length, 2);
  for (const panel of [...maps, photo, brush, now, inSight, landmarks]) {
    for (const q of panel.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  }
  // The ride and the places are read from the files the instance built, never from Panoramax's API at each view.
  const text = JSON.stringify(dashboard);
  assert.ok(text.includes('http://feeds/datasets/paris-ride/ride.parquet'));
  assert.ok(text.includes('http://feeds/datasets/paris-ride/places.parquet'));
  assert.ok(!text.includes('/api/collections/'));
  // The camera looks the way its picture did, 76° wide, 300 m ahead from 1.5 m up, against the buildings alone:
  // Mapterhorn's terrain is the bare ground, so on a bridge the camera would stand on the river under the quays.
  const view = layersOf(ride).find((l) => l.type === 'viewshed');
  const v = view.config.visConfig;
  assert.equal(v.viewshedObstacles, 'buildings');
  assert.equal(v.viewshedBuildings, '__basemap__');
  assert.equal(v.viewshedEye, 1.5);
  assert.equal(v.viewshedRange, 300);
  assert.equal(v.viewshedBeamwidth, 76);
  assert.equal(view.visualChannels.azimuthField.name, 'heading');
  assert.equal(v.rowsPerPlace, 'last');
  assert.equal(v.rowsAsset, 'camera');
  assert.equal(v.viewshedAreaVariable, 'visible');
  assert.equal(layersOf(ride).find((l) => l.type === 'fleet').config.visConfig.fleetFollow, 'Camera');
  // The map below gathers every other picture's view; it writes no variable.
  const seen = layersOf(soFar).find((l) => l.type === 'viewshed').config.visConfig;
  assert.equal(seen.rowsPerPlace, 'all');
  assert.equal(seen.rowsAsset, 'none');
  assert.ok(!seen.viewshedAreaVariable);
  // The Time Brush grows a window from the start and both maps follow it.
  const b = brush.vizConfig.spec.options;
  assert.equal(b.output, 'variables');
  assert.deepEqual(b.variables, { from: 't0', to: 't1' });
  assert.equal(b.windowMode, 'incremental');
  for (const map of maps) {
    assert.equal(map.vizConfig.spec.options.timeSync, 'variables');
    assert.deepEqual(map.vizConfig.spec.options.timeVariables, { from: 't0', to: 't1' });
  }
});

test('reads the ground seen inline, never from a subquery or a CTE', () => {
  // DuckDB spatial 1.5.4 crashes the whole datasource on ST_Within against an empty geometry that is not a constant,
  // and an empty one is what the layer writes when nothing is in sight.
  const reading = [inSight, landmarks];
  for (const panel of reading) {
    const sql = sqlOf(panel);
    assert.ok(sql.includes("nullif($visible, '') IS NOT NULL"), panel.title);
    assert.match(sql, /ST_Within\(ST_Point\(longitude, latitude\),\s*ST_Buffer\(ST_GeomFromText\(/);
    assert.doesNotMatch(sql, /\(\s*SELECT\s+ST_/i);
  }
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the ride: 626 pictures about a second apart, across central Paris', { timeout: 60_000 }, async () => {
  const rows = await duckdb(STACK_URL, `SELECT * FROM ${RIDE} ORDER BY time`);
  assert.ok(rows.length > 600 && rows.length < 650, `${rows.length} pictures`);
  const gaps = [];
  for (const [i, r] of rows.entries()) {
    assert.ok(IN_PARIS(r), JSON.stringify(r));
    assert.equal(r.camera, 'Camera');
    assert.ok(r.heading >= 0 && r.heading <= 360, JSON.stringify(r));
    assert.equal(r.field_of_view, 76);
    assert.ok(r.speed_kmh >= 0 && r.speed_kmh < 45, JSON.stringify(r));
    assert.match(r.photo, /^https:\/\/panoramax\.openstreetmap\.fr\/derivates\/.+\/sd\.jpg$/);
    if (i > 0) {
      assert.ok(r.distance_m >= rows[i - 1].distance_m);
      gaps.push(Number(r.time) - Number(rows[i - 1].time));
    }
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  assert.ok(median > 800 && median < 1500, `${median} ms between pictures`);
  // 4.2 km in 15 minutes on 13 May 2025, as Panoramax says of the sequence.
  const last = rows.at(-1);
  assert.ok(last.distance_m > 4000 && last.distance_m < 4400, `${last.distance_m} m`);
  assert.ok(last.elapsed_s > 900 && last.elapsed_s < 960, `${last.elapsed_s} s`);
  assert.equal(new Date(Number(rows[0].time)).toISOString().slice(0, 10), '2025-05-13');
});

test('the places along the route, its landmarks among them', { timeout: 60_000 }, async () => {
  const [count] = await duckdb(STACK_URL, `SELECT count(*) AS n, min(latitude) AS s, max(latitude) AS n_ FROM ${PLACES}`);
  assert.ok(Number(count.n) > 5000, `${count.n} places`);
  assert.ok(count.s > 48.83 && count.n_ < 48.88);
  const known = await duckdb(
    STACK_URL,
    `SELECT place, confidence FROM ${PLACES} WHERE place IN ('Sainte-Chapelle', 'Tour Saint-Jacques', 'Porte Saint-Denis', 'Place du Châtelet')`
  );
  assert.deepEqual([...new Set(known.map((r) => r.place))].sort(), ['Place du Châtelet', 'Porte Saint-Denis', 'Sainte-Chapelle', 'Tour Saint-Jacques']);
  for (const r of known) assert.ok(r.confidence >= 0.9, JSON.stringify(r));
});

test('at the instant: the picture, where the camera is, and the landmarks it sees', { timeout: 60_000 }, async () => {
  const [picture, ...more] = await duckdb(STACK_URL, at(sqlOf(photo)));
  assert.equal(more.length, 0);
  assert.match(picture.thumb, /\/thumb\.jpg$/);
  assert.equal(picture.clock.slice(0, 5), '14:41');
  const [here] = await duckdb(STACK_URL, at(sqlOf(now)));
  assert.ok(here.Ridden > 2.5 && here.Ridden < 2.9, `${here.Ridden} km`);
  // Nothing seen yet (blank) or nothing in sight (EMPTY): no rows, and the datasource stays up.
  for (const visible of ['', 'MULTIPOLYGON EMPTY']) {
    assert.equal((await duckdb(STACK_URL, at(sqlOf(landmarks), OPEN_AT, visible))).length, 0, visible);
    const [counted] = await duckdb(STACK_URL, at(sqlOf(inSight), OPEN_AT, visible));
    assert.equal(Number(counted['Places in sight']), 0, visible);
  }
  // On Pont au Change, with Place du Châtelet's ground in sight: it is listed, about 70 m ahead.
  const [square] = await duckdb(STACK_URL, `SELECT latitude, longitude FROM ${PLACES} WHERE place = 'Place du Châtelet' ORDER BY confidence DESC LIMIT 1`);
  const d = 0.0004;
  const { latitude: y, longitude: x } = square;
  const visible = `MULTIPOLYGON (((${x - d} ${y - d}, ${x + d} ${y - d}, ${x + d} ${y + d}, ${x - d} ${y + d}, ${x - d} ${y - d})))`;
  const listed = await duckdb(STACK_URL, at(sqlOf(landmarks), OPEN_AT, visible));
  const chatelet = listed.find((r) => r.Place === 'Place du Châtelet');
  assert.ok(chatelet, JSON.stringify(listed));
  assert.ok(chatelet.Metres > 30 && chatelet.Metres < 150, `${chatelet.Metres} m`);
});

test('Panoramax serves the pictures', { timeout: 60_000 }, async () => {
  const [picture] = await duckdb(STACK_URL, at(sqlOf(photo)));
  for (const url of [picture.thumb, picture.photo]) {
    const response = await fetch(url, { method: 'HEAD' });
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), /^image\/jpeg/);
  }
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('What the camera sees');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
