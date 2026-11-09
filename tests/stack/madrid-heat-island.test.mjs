// The madrid-heat-island dashboard: Madrid's surface temperature in July 2026
// against its countryside, by day (Landsat, 12:55) and by night (MODIS, 22:39),
// from datasets/madrid-heat/build.sh. The two maps are paletted COGs that
// Pacha's tile server paints; the charts are Mosaic panels on Chaski datasets.
// Without the dataset's files on the instance, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'madrid-heat-island';
const DATASETS = ['cells', 'landcover', 'long', 'city', 'key'];
const FEEDS = 'http://feeds/datasets/madrid-heat';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplergl-panel');
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const serverSql = (name) => dataset(name).source.query.rawSql;
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/cells.parquet`]) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'duckdb', 'kepler', 'mosaic', 'satellite']);
  for (const name of ['cells', 'landcover']) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    for (const url of serverSql(name).match(/'[a-z]+:\/\/[^']+'/g)) assert.ok(url.startsWith(`'${FEEDS}/`), url);
  }
  // Two maps, a picture each from this repo's dataset, painted by Pacha's tile
  // server from the colour table the file carries, and the hover squares.
  assert.equal(maps.length, 2);
  const tifs = [];
  for (const map of maps) {
    const options = map.vizConfig.spec.options;
    assert.equal(options.rasterPainted, true);
    assert.equal(options.rasterServerUrl, '/titiler');
    for (const query of map.data.spec.queries) assert.equal(query.spec.query.datasource.name, 'duckdbwasm');
    tifs.push(map.data.spec.queries[0].spec.query.spec.rawSql.match(/'([^']+\.tif)'/)[1]);
    // The saved layer is the panel's own painted one: a saved rasterTile would stay empty.
    const layers = options.mapConfig.config.visState.layers;
    assert.deepEqual(layers.map((l) => l.type).sort(), ['cogPainted', 'geojson']);
    assert.equal(layers.find((l) => l.type === 'geojson').config.columns.geojson, '_geojson');
  }
  assert.deepEqual(tifs, [`${FEEDS}/day.tif`, `${FEEDS}/night.tif`]);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the city is cooler than its countryside by day and warmer at night', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/madrid-heat on this instance: run its build.sh');
  const cells = await duckdb(STACK_URL, serverSql('cells'));
  assert.equal(cells.length, 3600);
  for (const c of cells) assert.ok(c.latitude > 40.1 && c.latitude < 40.75 && c.longitude > -4.1 && c.longitude < -3.3);
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const rural = cells.filter((c) => c.rural);
  const city = cells.filter((c) => c.built >= 0.5);
  assert.ok(rural.length > 1000 && city.length > 300, `${rural.length} rural squares, ${city.length} city ones`);
  // The countryside is the zero: its own median is about nothing.
  for (const k of ['landsat_vs', 'day_vs', 'night_vs']) assert.ok(Math.abs(median(rural.map((c) => c[k]))) < 0.5, k);
  // July surface temperatures in Madrid, in °C.
  assert.ok(median(rural.map((c) => c.landsat)) > 40 && median(rural.map((c) => c.night)) < 30);
  // The finding: below the countryside by day, above it at night.
  assert.ok(median(city.map((c) => c.landsat_vs)) < -1, 'the city by day');
  assert.ok(median(city.map((c) => c.night_vs)) > 1, 'the city at night');
  const classes = await duckdb(STACK_URL, serverSql('landcover'));
  const p50 = Object.fromEntries(classes.map((c) => [c.class, c.p50]));
  assert.deepEqual(Object.keys(p50).sort(), ['Bare ground', 'Built-up', 'Cropland', 'Scrub and grass', 'Trees', 'Water']);
  assert.ok(p50.Water < p50.Trees && p50.Trees < p50['Built-up'] && p50['Built-up'] < p50.Cropland);
});

test('the tile server reads both maps through the gateway', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/madrid-heat on this instance');
  for (const name of ['day', 'night']) {
    const { status, json } = await api(STACK_URL, `/titiler/cog/info?url=${encodeURIComponent(`${FEEDS}/${name}.tif`)}`, { anonymous: true });
    assert.equal(status, 200, name);
    assert.equal(json.dtype, 'uint8');
    assert.ok(json.colormap, `${name}.tif carries its colour table`);
  }
});

test('opens with every panel drawn', { timeout: 400_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/madrid-heat on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: DATASETS, timeoutMs: 180_000 });
  view.page.setDefaultTimeout(240_000);
  try {
    const card = async (title) => Number((await (await view.panel(title)).innerText()).replace(title, '').replace(/[^\d.+-]/g, ''));
    assert.ok((await card('The city by day')) < 0);
    assert.ok((await card('The city by night')) > 0);
    for (const title of ['Out from Puerta del Sol', 'By how built-up the square is', 'By land cover, at 12:55']) {
      await (await view.panel(title)).locator('svg').first().waitFor();
    }
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
