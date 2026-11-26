// bogota-rush-hour: how far 5, 10 and 20 minutes take you from Plaza de Bolívar by car, leaving at each hour
// of a Tuesday in Mapbox's typical traffic (Isochrone API, through the gateway's mapbox route); a Kepler Plus Time
// Brush moves the map, the card and the chart. These tests need the internet (Mapbox, through the gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'bogota-rush-hour';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [iso] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'iso');
const datasetSql = iso.source.query.rawSql;
// The start, as the map's marker writes it.
const fromSql = (lat, lng) => datasetSql.replaceAll('${origin_lat:sqlstring}', `'${lat}'`).replaceAll('${origin_lng:sqlstring}', `'${lng}'`);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'duckdb', 'kepler', 'mobility', 'mosaic']);
  assert.equal(iso.source.datasource.uid, 'duckdb');
  // Mapbox only through the gateway, which adds the token: none in the dashboard.
  assert.match(datasetSql, /http:\/\/feeds\/mapbox\/isochrone\//);
  assert.doesNotMatch(JSON.stringify(dashboard), /api\.mapbox\.com|access_token|pk\.ey/);
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplerplus-panel');
  const o = map.vizConfig.spec.options;
  assert.equal(o.basemap, 'openfreemap-fiord');
  assert.equal(o.mapConfig.config.mapStyle.styleType, 'openfreemap-fiord');
  // The map follows the Time Brush through its query (t0, t1), with no kepler time filter writing back.
  assert.equal(o.timeSync, 'off');
  assert.deepEqual(o.mapConfig.config.visState.filters, []);
  assert.match(map.data.spec.queries[0].spec.query.spec.rawSql, /\$\{t0:sqlstring\}.+\$\{t1:sqlstring\}/s);
  // The start is a marker bound to origin_lat / origin_lng.
  const marker = o.mapConfig.config.visState.layers.find((l) => l.type === 'markers');
  assert.deepEqual([marker.config.visConfig.markers[0].latVariable, marker.config.visConfig.markers[0].lngVariable], ['origin_lat', 'origin_lng']);
  const [brush] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-timebrush-panel');
  assert.equal(brush.vizConfig.spec.options.mosaicSelection, 'rush');
  assert.equal(brush.vizConfig.spec.options.windowMode, 'incremental');
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the dataset is 24 departures by car, each with three contours', { timeout: 300_000 }, async () => {
  const rows = await duckdb(STACK_URL, fromSql('4.5981', '-74.0759'));
  const car = rows.filter((r) => r.mode === 'car');
  assert.equal(car.length, 24 * 3);
  assert.equal(rows.length, car.length);
  assert.deepEqual([...new Set(rows.map((r) => r.minutes))].sort((a, b) => a - b), [5, 10, 20]);
  for (const r of rows) {
    assert.ok(r.km2 > 0 && r.km2 < 3000, JSON.stringify({ ...r, geometry: undefined }));
    assert.match(r.geometry, /^\{"type":"(Multi)?Polygon"/);
  }
  // Longer trips reach farther, at every departure.
  for (const t of new Set(car.map((r) => r.leaving))) {
    const [a, b, c] = [5, 10, 20].map((m) => car.find((r) => r.leaving === t && r.minutes === m).km2);
    assert.ok(a < b && b < c, t);
  }
  // Traffic: 20 minutes by car reach far more at night than at the evening peak.
  const car20 = car.filter((r) => r.minutes === 20).map((r) => r.km2);
  assert.ok(Math.min(...car20) < 0.6 * Math.max(...car20), `${Math.min(...car20)} vs ${Math.max(...car20)}`);
});

test('a start outside Bogotá goes back to Plaza de Bolívar; one inside is rounded to 0.002°', { timeout: 300_000 }, async () => {
  const away = await duckdb(STACK_URL, fromSql('6.25', '-75.57'));
  assert.equal(away[0].origin, '-74.0759,4.5981');
  const near = await duckdb(STACK_URL, fromSql('4.5981', '-74.0759'));
  assert.equal(near[0].origin, '-74.076,4.598');
});
