// The madrid-live dashboard: Madrid's City Council feeds through the gateway's /madrid/ routes (Informo's traffic
// measuring points and incidents, the air quality stations, the districts), read live on the server and replayed
// from the recorder's feeds madrid-traffic and madrid-air: a cube by district and quarter hour in Chaski, filtered
// by a Kepler Plus Time Brush and Mosaic panels, and a Kepler Plus map whose points the server works out for the
// same selection. Without Plus, the browser test is skipped; without a recording, the test of it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'madrid-live';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const mapTitled = (start) => maps.find((m) => m.title.startsWith(start));
const map = mapTitled('Traffic in the selection');
const climate = mapTitled('Every building');
const datasetSql = (name) =>
  dashboard.spec.variables.find((v) => v.spec.name === name).spec.query.spec.source.query.rawSql;
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const noPlus = plus.status === 404 && 'Kepler Plus is not mounted';

const manifest = (feed) =>
  duckdb(
    STACK_URL,
    `SELECT url FROM read_json('http://feeds/recordings/${feed}/manifest.json',
       columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})
     WHERE "to" >= now() - INTERVAL 25 HOUR`,
  ).catch(() => []);
const traffic = await manifest('madrid-traffic');
const air = await manifest('madrid-air');
const meteo = await manifest('madrid-meteo');
const notRecorded = traffic.length === 0 && 'the recorder has no madrid-traffic recording of the last day';

// A query as Grafana sends it over the last day, at no moment picked (now): the recorded files in place of the
// file variables, the empty recordings among them as the variables add them.
const to = Date.now();
const from = to - 86_400_000;
const files = (rows, feed) =>
  [...rows.map((r) => r.url), `http://feeds/recordings/${feed}-empty.parquet`].map((u) => `'${u}'`).join(', ');
const bound = (sql, { t0 = '', t1 = '', hours = ['', ''], districts = [] } = {}) =>
  sql
    .replaceAll('${traffic_files:singlequote}', files(traffic, 'madrid-traffic'))
    .replaceAll('${air_files:singlequote}', files(air, 'madrid-air'))
    .replaceAll('${meteo_files:singlequote}', files(meteo, 'madrid-meteo'))
    .replaceAll('${district:singlequote}', districts.length ? districts.map((d) => `'${d}'`).join(', ') : "''")
    .replaceAll('$hour_lo', `'${hours[0]}'`)
    .replaceAll('$hour_hi', `'${hours[1]}'`)
    .replaceAll('$t0', `'${t0}'`)
    .replaceAll('$t1', `'${t1}'`)
    .replaceAll('${__from}', String(from))
    .replaceAll('${__to}', String(to))
    .replaceAll('$__timeFrom()', `'${new Date(from).toISOString()}'::TIMESTAMPTZ`)
    .replaceAll('$__timeTo()', `'${new Date(to).toISOString()}'::TIMESTAMPTZ`);
const sqlOf = (panel, refId = 'A', vars) =>
  bound(panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql, vars);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  assert.deepEqual(dashboard.spec.tags, [
    'air-quality', 'buildings', 'chaski', 'city', 'duckdb', 'kepler', 'live', 'mobility', 'mosaic', 'plus', 'weather',
  ]);
  // Traffic, Air, Climate and About the data, as fiware-valencia: each with its own Time Brush on the one window.
  assert.deepEqual(dashboard.spec.layout.spec.tabs.map((t) => t.spec.title), ['Traffic', 'Air', 'Climate', 'About the data']);
  const brushes = panelsByType(dashboard, 'ubica-timebrush-panel');
  assert.equal(brushes.length, 3);
  for (const b of brushes) assert.deepEqual(b.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  for (const q of findAll(dashboard, (n) => n.kind === 'DataQuery' && n.datasource)) {
    assert.ok(['duckdb', 'duckdbwasm', '-- Grafana --'].includes(q.datasource.name), q.datasource.name);
  }
  // The city is read through the gateway only (cached, polite), Informo with http_get: one GET, never a HEAD and a GET.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  assert.doesNotMatch(sql, /https?:\/\/[^\s']*madrid\.es/);
  assert.doesNotMatch(sql, /read_text\('http:\/\/feeds\/madrid/);
  // One selection: the Time Brush's window, the Mosaic panels' brushes and clicks, all on the cube, written to the
  // variables the map's server query reads too.
  const brush = brushes.find((b) => b.vizConfig.spec.options.mosaicSelection);
  const o = brush.vizConfig.spec.options;
  assert.deepEqual([o.selection, o.mosaicSelection, o.mosaicColumn], ['range', 'traffic', 't']);
  assert.deepEqual(o.variables, { from: 't0', to: 't1' });
  const mosaics = panelsByType(dashboard, 'ubica-chaski-mosaic-panel');
  assert.equal(mosaics.length, 6);
  const writes = mosaics.map((m) => m.vizConfig.spec.options.variables).join('\n');
  assert.match(writes, /column: district\n  variable: district/);
  assert.match(writes, /column: hour\n  from: hour_lo\n  to: hour_hi/);
  // A tip on a mark that selects would swallow its clicks.
  for (const m of mosaics) {
    if (/select: toggle/.test(m.vizConfig.spec.options.spec)) assert.doesNotMatch(m.vizConfig.spec.options.spec, /tip: true/);
  }
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => [l.type, l.config.dataId]), [
    ['point', 'grafana-D'], ['point', 'grafana-B'], ['geojson', 'grafana-A'],
  ]);
  // The buildings coloured by the weather stations, under kepler's Light & Shadow following the window.
  const heat = climate.vizConfig.spec.options.mapConfig.config.visState;
  assert.equal(heat.layers[0].type, 'buildings');
  assert.equal(heat.layers[0].visualChannels.colorField.name, 'above_median');
  assert.equal(heat.effects[0].type, 'lightAndShadow');
  assert.equal(heat.effects[0].parameters.timeMode, 'animation');
  assert.deepEqual(climate.vizConfig.spec.options.timeVariables, { from: 't0', to: 't1' });
  for (const l of layers.filter((l) => l.config.columnMode === 'points')) {
    assert.deepEqual(l.config.columns, { lat: 'latitude', lng: 'longitude' });
  }
  // The districts lie under the base map's streets, buildings and names, the points and incidents over them (Plus
  // underRoads / overRoads), rather than the roads moved to the top over every layer.
  const byId = Object.fromEntries(layers.map((l) => [l.id, l.config.visConfig]));
  assert.equal(byId.districts.underRoads, true);
  assert.equal(byId.points.overRoads, true);
  assert.equal(byId.incidents.overRoads, true);
  // The datasets read no variable a Mosaic panel or the Time Brush writes: a write would reload them and clear
  // every brush.
  for (const name of ['cube', 'districts', 'air', 'meteo']) {
    assert.doesNotMatch(datasetSql(name), /\$(t0|t1|hour_|district)/);
  }
  assert.deepEqual(dashboard.spec.variables.map((v) => v.spec.name), [
    'traffic_files', 'air_files', 'meteo_files', 'cube', 'districts', 'air', 'meteo', 'cubeFilters',
    't0', 't1', 'hour_lo', 'hour_hi', 'district',
  ]);
});

test('the city feeds answer through the gateway, kept and handed over plain', () => {
  for (const path of [
    'informo/pm.xml', 'informo/incidents.xml', 'air/realtime.json', 'air/stations.csv', 'districts.geojson',
    'meteo/realtime.json', 'meteo/stations.csv',
  ]) {
    const headers = () =>
      compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds/madrid/${path}`]);
    headers();
    const second = headers();
    assert.match(second, /^HTTP\/1\.1 200/, path);
    assert.match(second, /X-Cache-Status: (HIT|STALE|UPDATING)/i, path);
    assert.doesNotMatch(second, /^Content-Encoding/im, path);
  }
});

test("Informo's points stand in Madrid with a load, in its 21 districts", async () => {
  const points = await duckdb(STACK_URL, sqlOf(map, 'B'));
  assert.ok(points.length > 3000 && points.length < 6000, `${points.length} points`);
  for (const p of points) {
    assert.ok(p.latitude > 40.3 && p.latitude < 40.65 && p.longitude > -3.9 && p.longitude < -3.5, p.id);
    // Informo's load passes 100 now and then, at a point over its capacity.
    assert.ok(p.load >= 0 && p.load <= 200, `${p.id}: ${p.load}`);
  }
  assert.equal(new Set(points.map((p) => p.district)).size, 21);
  const districts = await duckdb(STACK_URL, bound(datasetSql('districts')));
  assert.equal(districts.length, 21);
  for (const d of districts) assert.match(d.geometry, /^\{"type":"(Multi)?Polygon"/);
  // The districts picked keep only their points.
  const picked = await duckdb(STACK_URL, sqlOf(map, 'B', { districts: ['Centro', 'Salamanca'] }));
  assert.deepEqual([...new Set(picked.map((p) => p.district))].sort(), ['Centro', 'Salamanca']);
});

test("the stations' NO2 hour by hour, and the incidents in Madrid", async () => {
  const readings = await duckdb(STACK_URL, bound(datasetSql('air')));
  const stations = new Set(readings.map((r) => r.station));
  assert.ok(stations.size >= 15 && stations.size <= 24, `${stations.size} stations`);
  for (const r of readings) assert.ok(r.no2 >= 0 && r.no2 < 1000, `${r.station}: ${r.no2}`);
  const incidents = await duckdb(STACK_URL, sqlOf(map, 'D'));
  for (const i of incidents) assert.ok(i.latitude > 40.2 && i.latitude < 40.7, i.description);
});

test('the weather stations: hourly temperature in a plausible range, where each stands', async () => {
  const rows = await duckdb(STACK_URL, bound(datasetSql('meteo')));
  const stations = new Set(rows.filter((r) => r.temperature !== null).map((r) => r.station));
  assert.ok(stations.size >= 15 && stations.size <= 30, `${stations.size} stations`);
  for (const r of rows) {
    assert.ok(r.latitude > 40.3 && r.latitude < 40.6 && r.longitude > -3.9 && r.longitude < -3.5, r.station);
    if (r.temperature !== null) assert.ok(r.temperature > -20 && r.temperature < 50, `${r.station}: ${r.temperature}`);
    if (r.humidity !== null) assert.ok(r.humidity >= 0 && r.humidity <= 100, `${r.station}: ${r.humidity}`);
  }
});

test('the recording: a cube by district and quarter hour, and the points in a window of it', { skip: notRecorded }, async () => {
  const cube = await duckdb(STACK_URL, bound(datasetSql('cube')));
  assert.ok(cube.length >= 21 && cube.length <= 21 * 4 * 24 * 8, `${cube.length} rows`);
  for (const r of cube) {
    assert.ok(r.load >= 0 && r.load <= 200 && r.hour >= 0 && r.hour <= 23 && r.queued >= 0, JSON.stringify(r));
    assert.equal(Number(r.t_end) - Number(r.t) <= 900_000, true);
  }
  const first = Math.min(...cube.map((r) => Number(r.t)));
  const window = { t0: new Date(first).toISOString(), t1: new Date(first + 900_000).toISOString() };
  const points = await duckdb(STACK_URL, sqlOf(map, 'B', window));
  assert.ok(points.length > 3000, `${points.length} points in ${window.t0}`);
  // Its columns are the empty recording's, which a fresh instance reads instead.
  const columns = (url) => duckdb(STACK_URL, `SELECT name FROM parquet_schema('${url}') ORDER BY name`);
  assert.deepEqual(await columns(traffic[0].url), await columns('http://feeds/recordings/madrid-traffic-empty.parquet'));
  if (air.length) assert.deepEqual(await columns(air[0].url), await columns('http://feeds/recordings/madrid-air-empty.parquet'));
});

test('opens with no panel in error', { skip: noPlus }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['cube', 'districts', 'air', 'meteo'], timeoutMs: 150_000 });
  try {
    for (const title of [
      'Traffic in the selection: points, districts, incidents',
      'Every district, quarter by quarter · mean load',
      'Incidents Informo lists',
    ]) {
      await view.panel(title);
    }
    for (const tab of ['Air', 'Climate']) {
      await view.page.getByRole('tab', { name: tab }).click();
      await view.page.waitForTimeout(8000);
      assert.equal(await view.panelErrors(), 0, tab);
    }
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
