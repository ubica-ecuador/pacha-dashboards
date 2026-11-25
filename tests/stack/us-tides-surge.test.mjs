// us-tides-surge: NOAA's tide gauges on the coasts of the United States over the last 48 hours,
// read by the server through the gateway (noaa-tides) into Chaski, drawn by kepler and Mosaic:
// the water over an ordinary high tide, how far it ran over or under the tide tables, and the
// gauges past their flood level, each with a Kepler Plus 3D Callout card, over GFS wind streamlines. These tests need the internet (NOAA, through the gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';

const UID = 'us-tides-surge';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [tides] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'tides');
const [wind] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'wind');
const datasetSql = tides.source.query.rawSql;
const seriesSql = panelTitled(dashboard, 'Measured and predicted — ${gauge_name}').data.spec.queries[0].spec.query.spec.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'maritime', 'mosaic', 'plus', 'water']);
  assert.equal(tides.source.type, 'datasource');
  assert.equal(tides.source.datasource.uid, 'duckdb');
  // NOAA only through the gateway, which keeps a copy of each station and paces what reaches NOAA.
  for (const sql of [datasetSql, seriesSql]) assert.match(sql, /http:\/\/feeds\/noaa-tides\//);
  assert.doesNotMatch(JSON.stringify(dashboard), /api\.tidesandcurrents\.noaa\.gov/);
  assert.match(wind.source.query.rawSql, /http:\/\/feeds\/erddap\//);
  // The timeline, the filters and the grid's brush write these; the dataset reading one would
  // reload on every brush.
  for (const name of ['tide_from', 'tide_to', 'coasts', 'search', 'tide_area']) {
    assert.doesNotMatch(datasetSql, new RegExp(`\\$${name}\\b`), name);
  }
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplerplus-panel');
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'tideFilters');
  // The tide and the wind play on the map's own time slider; the callout cards read the whole
  // window (query B).
  const { layers, filters } = map.vizConfig.spec.options.mapConfig.config.visState;
  assert.deepEqual(layers.map((l) => [l.type, l.config.dataId]),
    [['point', 'grafana-A'], ['callout', 'grafana-B'], ['flowfield', 'grafana-C']]);
  assert.deepEqual(filters[0].dataId, ['grafana-A', 'grafana-C']);
  // The gauge series crosshair moves the cards' crosshair.
  assert.equal(dashboard.spec.cursorSync, 'Crosshair');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the dataset is every tidal gauge at each six minutes of 48 hours, measured against its tables', { timeout: 300_000 }, async () => {
  const rows = await duckdb(STACK_URL, datasetSql);
  const gauges = new Map();
  for (const row of rows) {
    gauges.set(row.id, row);
    if (row.has_reading !== 1) continue;
    // Metres over an ordinary high tide: Cook Inlet's low water is some 9 m under it, no gauge
    // stands more than a few metres over it.
    assert.ok(row.observed > -12 && row.observed < 5, JSON.stringify(row));
    if (row.above_tables !== null) assert.ok(Math.abs(row.above_tables) < 4, JSON.stringify(row));
  }
  // About 235 tidal gauges; NOAA's network rarely has fewer than 180 of them reporting.
  assert.ok(gauges.size >= 180, `${gauges.size} gauges`);
  assert.equal(rows.length, gauges.size * 480);
  const read = rows.filter((r) => r.has_reading === 1);
  assert.ok(read.length / rows.length > 0.9);
  // Nearly every reading meets its prediction (a gauge reading off the six-minute marks too).
  assert.ok(read.filter((r) => r.predicted !== null).length / read.length > 0.95);
  const all = [...gauges.values()];
  for (const coast of ['Alaska', 'Pacific', 'Gulf of Mexico', 'Atlantic']) {
    assert.ok(all.filter((g) => g.coast === coast).length >= 15, coast);
  }
  // About three gauges in four have a flood level, a few tenths of a metre to a few metres over MHHW.
  const floods = all.filter((g) => g.flood !== null);
  assert.ok(floods.length / all.length > 0.6, `${floods.length} flood levels`);
  for (const g of floods) assert.ok(g.flood > 0 && g.flood < 4, JSON.stringify(g));
  // The feed is live: the newest reading is from the last few hours.
  assert.ok(Date.now() - Math.max(...all.map((g) => g.latest)) < 6 * 3600_000);
});

test('the wind is a regular lattice every half hour of the 48 hours', { timeout: 300_000 }, async () => {
  const rows = await duckdb(STACK_URL, wind.source.query.rawSql);
  const cells = new Set(rows.map((r) => `${r.latitude},${r.longitude}`));
  const times = new Set(rows.map((r) => r.time));
  // 19 x 41 cells, three degrees apart; the streamlines draw nothing on a wobbling lattice.
  assert.equal(cells.size, 19 * 41);
  assert.equal(rows.length, cells.size * times.size);
  assert.ok(times.size >= 96 && times.size <= 98, `${times.size} half hours`);
  // Under the panel's limit: past some 120,000 rows the Plus map failed (call stack exceeded).
  assert.ok(rows.length < 100_000, `${rows.length} rows`);
  for (const r of rows) assert.ok(Math.hypot(r.u, r.v) < 60, JSON.stringify(r));
});

test('the series of a clicked gauge is its water, its tables and its flood level', { timeout: 120_000 }, async () => {
  // The Battery, New York: the datasource quotes a bare variable itself.
  const rows = await duckdb(STACK_URL, seriesSql.replaceAll('$gauge', "'8518750'"));
  assert.ok(rows.filter((r) => r.Measured !== null).length > 300, `${rows.length} rows`);
  // Its minor flood level is about 0.56 m over MHHW (2.10 m over MLLW).
  assert.ok(Math.abs(rows[0]['Minor flood level'] - 0.56) < 0.1, JSON.stringify(rows[0]));
  // The tables go on past now, the measured water does not.
  assert.ok(Math.max(...rows.map((r) => r.time)) > Date.now() + 6 * 3600_000);
  // No gauge clicked: no rows, and no error.
  assert.equal((await duckdb(STACK_URL, seriesSql.replaceAll('$gauge', "''"))).length, 0);
});

test('opens with every panel drawn and no error', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['tides'], timeoutMs: 180_000 });
  // 112,800 points drawn in software GL keep the page busy: every action waits for a frame.
  view.page.setDefaultTimeout(240_000);
  try {
    assert.equal(await view.panelErrors(), 0);
    assert.ok((await view.statNumber('Tide gauges')) >= 180);
    // The grid is a raster image; a null cell once failed the whole image.
    const grid = await view.panel('Over or under the tide tables, gauge by gauge');
    await grid.getByTestId('mosaic-panel').locator('svg image').last().waitFor({ timeout: 60_000 });
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
