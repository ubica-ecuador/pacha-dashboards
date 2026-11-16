// The nyc-street-heat dashboard: the July 2019 heat wave on New York's streets, from the Cool Neighborhoods
// sensors (datasets/nyc-street-heat/build.sh), every building of the base map coloured by the air around it with
// Kepler Plus's Buildings layer. Without the dataset's file on the instance, the data tests skip; without Plus, the
// dashboard is not there and the browser test skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'nyc-street-heat';
const FEEDS = 'http://feeds/datasets/nyc-street-heat';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const mapTitled = (title) => maps.find((panel) => panel.title === title);
const map = mapTitled('Every building, by the street air around it');
const hviMap = mapTitled('Heat vulnerability, building by building');
const cellsMap = mapTitled('The sensors by hexagon, in the brushed hour');
const layerOf = (panel) => panel.vizConfig.spec.options.mapConfig.config.visState.layers[0];
const queries = findAll(dashboard, (n) => n.kind === 'PanelQuery');
const sqlOf = (panel) => panel.data.spec.queries[0].spec.query.spec.rawSql;
// The SQL as the dashboard opens: East Harlem South, the hottest hour (15:00 New York time on 21 July 2019).
const opened = (sql) =>
  sql
    .replaceAll('${nta:sqlstring}', "'MN33'")
    .replaceAll('${t0:sqlstring}', "'2019-07-21T19:00:00.000Z'")
    .replaceAll('${t1:sqlstring}', "'2019-07-21T20:00:00.000Z'");
// The maps read every hour, each mean at the middle of its hour: the one their time filter keeps as the dashboard opens.
const atOpening = (sql) => `SELECT * FROM (${sql}) WHERE time = TIMESTAMP '2019-07-21 19:30:00'`;
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/readings.parquet`]) ===
  '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'city', 'duckdb', 'kepler', 'plus', 'weather']);
  // Every query on the server DuckDB, reading only this repo's dataset.
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${FEEDS}/`), url);
  }
  // One Buildings layer, coloured by the sensors' °C on fixed classes, grey past 250 m.
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(
    layers.map((l) => l.type),
    ['buildings']
  );
  const [layer] = layers;
  assert.equal(layer.visualChannels.colorField.name, 'temp_c');
  assert.equal(layer.visualChannels.colorScale, 'custom');
  assert.equal(layer.config.visConfig.buildingsMode, 'interpolate');
  assert.equal(layer.config.visConfig.buildingsMaxDistance, 250);
  assert.deepEqual(map.vizConfig.spec.options.fitOnVariables, ['nta']);
  // The temperature maps keep the brushed window with a time filter synced to t0/t1, and give a building a card on hover.
  for (const panel of [map, cellsMap]) {
    const options = panel.vizConfig.spec.options;
    assert.equal(options.timeSync, 'variables');
    assert.deepEqual(options.timeVariables, { from: 't0', to: 't1' });
    assert.deepEqual(options.mapConfig.config.visState.filters.map((f) => f.name), [['time']]);
    assert.equal(layerOf(panel).config.visConfig.cardShow, 'hover');
  }
  // The two maps below: polygons and H3 cells, by the columns the panel hands kepler (`_geojson`, `h3`).
  assert.equal(layerOf(hviMap).type, 'buildings');
  assert.equal(layerOf(hviMap).config.columnMode, 'geojson');
  assert.deepEqual(layerOf(hviMap).config.columns, { geojson: '_geojson' });
  assert.equal(layerOf(hviMap).visualChannels.colorField.name, 'hvi');
  assert.equal(layerOf(cellsMap).config.columnMode, 'h3');
  assert.deepEqual(layerOf(cellsMap).config.columns, { hex_id: 'h3' });
  for (const panel of [hviMap, cellsMap]) assert.deepEqual(panel.vizConfig.spec.options.fitOnVariables, ['nta']);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the dataset holds the ten days of the heat wave', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-street-heat on this instance: run its build.sh');
  const [all] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(DISTINCT sensor) AS sensors, min(time) AS first, max(time) AS last,
            min(temp_c) AS lo, max(temp_c) AS hi, count(*) FILTER (WHERE neighbourhood IS NULL) AS unnamed,
            min(latitude) AS s, max(latitude) AS n2, min(longitude) AS w, max(longitude) AS e
     FROM '${FEEDS}/readings.parquet'`
  );
  assert.equal(Number(all.n), 84_595);
  assert.equal(Number(all.sensors), 354);
  assert.equal(Number(all.unnamed), 0);
  // New York City, in July: no reading below 15 °C or above 50 °C.
  assert.ok(all.lo > 15 && all.hi < 50, `${all.lo} to ${all.hi} °C`);
  assert.ok(all.s > 40.5 && all.n2 < 40.95 && all.w > -74.1 && all.e < -73.7);
});

test("the ZIP codes carry the Health Department's Heat Vulnerability Index", { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-street-heat on this instance');
  const [all] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(hvi) AS rated, min(hvi) AS lo, max(hvi) AS hi FROM '${FEEDS}/zcta.parquet'`
  );
  assert.equal(Number(all.n), 221);
  assert.equal(Number(all.rated), 184);
  assert.deepEqual([all.lo, all.hi].map(Number), [1, 5]);
  // Round East Harlem: its own ZIP codes at 4 and 5, the Upper East Side's at 1.
  const rows = await duckdb(STACK_URL, opened(sqlOf(hviMap)));
  const hvi = Object.fromEntries(rows.map((r) => [r.zcta, Number(r.hvi)]));
  assert.deepEqual([hvi['10029'], hvi['10035'], hvi['10128']], [4, 5, 1]);
  for (const r of rows) assert.match(r.geometry, /^(MULTI)?POLYGON/);
});

test('the sensors average into H3 hexagons on the server', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-street-heat on this instance');
  const cells = await duckdb(STACK_URL, atOpening(opened(sqlOf(cellsMap))));
  assert.ok(cells.length >= 8 && cells.length <= 20, `${cells.length} hexagons`);
  assert.equal(cells.reduce((a, c) => a + Number(c.sensors), 0), 43);
  for (const c of cells) assert.match(c.h3, /^89[0-9a-f]{13}$/);
});

test('the map opens on East Harlem at its hottest hour', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-street-heat on this instance');
  const rows = await duckdb(STACK_URL, atOpening(opened(sqlOf(map))));
  assert.equal(rows.length, 43);
  // The ten days for the cards: 43 sensors, about 240 hours each.
  const [all] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM (${opened(sqlOf(map))})`);
  assert.ok(Number(all.n) > 9000, `${all.n} readings`);
  const temps = rows.map((r) => r.temp_c);
  // NYC Open Data: a mean of 98.8 °F (37.1 °C), from 94.6 to 112.4 °F, at 15:00 on 21 July 2019 in MN33.
  const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
  assert.ok(Math.abs(mean - 37.1) < 0.1, `mean ${mean}`);
  assert.ok(Math.min(...temps) > 34.5 && Math.max(...temps) < 45);
  const [nta] = await duckdb(STACK_URL, dashboard.spec.variables[0].spec.definition);
  assert.equal(nta.__value, 'BK81');
});

test('opens with no panel in error', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-street-heat on this instance');
  const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  if (provisioned.status === 404) return t.skip('not on this instance: it needs Kepler Plus with the Buildings layer');
  // No Chaski here: every query runs on the server's DuckDB.
  const view = await openDashboard(`/d/${UID}`, { timeoutMs: 120_000, chaski: false });
  try {
    await (await view.panel('Sensors in the hour')).getByText('Hottest').waitFor();
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
