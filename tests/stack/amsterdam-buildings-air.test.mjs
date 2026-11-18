// The amsterdam-buildings-air dashboard: 3DBAG's buildings of central Amsterdam in 3D, read by Kepler Plus's City
// Model layer from 3DBAG's CityJSON tiles (only those in view), coloured by the NO2 a Buildings layer estimates at
// each from GGD Amsterdam's 17 Luchtmeetnet stations, with its hourly card; and by the sun on each roof face.
// It needs Kepler Plus: without it, the provisioning and browser tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'amsterdam-buildings-air';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const air = panelTitled(dashboard, 'NO2 at every building, estimated from the stations around');
const sun = panelTitled(dashboard, "The sun on every roof, a year's potential");
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const layersOf = (panel) => panel.vizConfig.spec.options.mapConfig.config.visState.layers;
// The last two days, as Grafana fills the time range in.
const lastDays = (sql) => sql.replaceAll('${__to}', String(Date.now())).replaceAll('${__from}', String(Date.now() - 48 * 3600e3));
const PINNED = 'NL.IMBAG.Pand.0363100012182077';

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['air-quality', 'buildings', 'city', 'duckdb', 'kepler', 'live', 'plus']);
  assert.equal(maps.length, 2);
  for (const map of maps) {
    for (const q of map.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
    const city = layersOf(map).find((l) => l.type === 'citymodel');
    assert.equal(city.config.columnMode, 'files');
  }
  // The air: a Buildings layer drawn on the City Model, which takes its colours and its cards.
  const [buildings] = layersOf(air).filter((l) => l.type === 'buildings');
  const city = layersOf(air).find((l) => l.type === 'citymodel');
  assert.equal(buildings.config.visConfig.buildingsOn, `citymodel:${city.id}`);
  assert.equal(buildings.config.dataId, 'grafana-B');
  assert.equal(city.config.visConfig.cityColourBy, 'sensors');
  assert.equal(city.config.visConfig.cardShow, 'hover');
  assert.deepEqual(city.config.visConfig.cardPinned, [PINNED]);
  // The hours: the Time Brush writes t0/t1, the air map follows them with a time filter on the stations.
  const brush = panelTitled(dashboard, 'Hours on the map');
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  assert.equal(air.vizConfig.spec.options.timeSync, 'variables');
  assert.deepEqual(air.vizConfig.spec.options.timeVariables, { from: 't0', to: 't1' });
  const [filter] = air.vizConfig.spec.options.mapConfig.config.visState.filters;
  assert.deepEqual([filter.type, filter.dataId, filter.name], ['timeRange', ['grafana-B'], ['time']]);
  // The sun: each roof face's own.
  assert.equal(layersOf(sun).find((l) => l.type === 'citymodel').config.visConfig.cityColourBy, 'solar');
  // The stations through the gateway's cache, never Luchtmeetnet straight.
  assert.ok(sqlOf(air, 'B').includes('http://feeds/luchtmeetnet/measurements'));
  assert.ok(!JSON.stringify(dashboard).includes('api.luchtmeetnet.nl'));
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test("the tile index covers central Amsterdam, each tile a box and 3DBAG's CityJSON file", { timeout: 60_000 }, async () => {
  const tiles = await duckdb(STACK_URL, sqlOf(air));
  assert.ok(tiles.length > 40 && tiles.length < 80, `${tiles.length} tiles`);
  for (const t of tiles) {
    assert.ok(t.west < t.east && t.south < t.north, JSON.stringify(t));
    assert.ok(t.west > 4.8 && t.east < 5 && t.south > 52.3 && t.north < 52.42, JSON.stringify(t));
    assert.match(t.city_url, /^https:\/\/3dbag\.fsn1\.your-objectstorage\.com\/v20250903\/tiles\/\d+\/\d+\/\d+\/\d+-\d+-\d+\.city\.json\.gz$/);
  }
  // The Dam is in one of them; and the tiles are the same on both maps.
  assert.ok(tiles.some((t) => t.west <= 4.8929 && 4.8929 <= t.east && t.south <= 52.3731 && 52.3731 <= t.north));
  assert.equal(sqlOf(sun), sqlOf(air));
  // Read by the browser: open to any page.
  const one = await fetch(tiles[0].city_url, { method: 'HEAD', headers: { Origin: 'https://pacha.ubica.dev' } });
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('access-control-allow-origin'), '*');
});

test('the stations give hourly NO2 of the last two days, in µg/m³', { timeout: 120_000 }, async () => {
  const rows = await duckdb(STACK_URL, lastDays(sqlOf(air, 'B')));
  const stations = new Set(rows.map((r) => r.station));
  assert.ok(stations.size >= 12, `${stations.size} stations`);
  assert.ok(rows.length > 400, `${rows.length} readings`);
  for (const r of rows) {
    assert.ok(r.no2 >= 0 && r.no2 < 300, JSON.stringify(r));
    assert.ok(r.latitude > 52.25 && r.latitude < 52.5 && r.longitude > 4.7 && r.longitude < 5, JSON.stringify(r));
  }
  // The pinned building stands by the Oude Schans station.
  assert.ok(stations.has('NL49019'));
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('NO2 at every building, estimated from the stations around');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
