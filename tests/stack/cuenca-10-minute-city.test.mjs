// The cuenca-10-minute-city dashboard: every street of Cuenca coloured by how
// many of six daily needs a walk of 1 to 15 minutes reaches, on a Chaski clock.
// R5 timed the walks once (datasets/cuenca-walk/build.sh, where the R5
// instance of Cuenca runs: only pacha.ubica.dev); the server hands the cells,
// streets and places to Chaski, and the clock's window filters the map on the
// GPU and the Mosaic panels by crossfilter, with no dataset reloading.
// Without walk.parquet on the instance, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'cuenca-10-minute-city';
const DATASETS = ['cells', 'streets', 'needs', 'reach', 'clock', 'curve'];
const NEEDS = ['food', 'pharmacy', 'health', 'school', 'park', 'stop'];
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const serverSql = (name) => dataset(name).source.query.rawSql;

// R5's cell (Web Mercator, zoom 10) of a point, as datasets/cuenca-walk computes it.
const cellOf = (lat, lon) => ({
  px: Math.floor(((lon + 180) / 360) * 262144),
  py: Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 262144),
});
const walked = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://feeds/datasets/cuenca-walk/walk.parquet']) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'demographics', 'duckdb', 'kepler', 'mobility', 'mosaic']);
  for (const query of map.data.spec.queries) assert.equal(query.spec.query.datasource.name, 'duckdbwasm');
  for (const name of ['cells', 'streets', 'needs']) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    // Only the files Pacha's datasets/cuenca-access and this repo's
    // datasets/cuenca-walk build, through the gateway.
    for (const url of serverSql(name).match(/'[a-z]+:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/datasets\/cuenca-(access|walk)\//);
  }
  // The clock moves by crossfilter: a dataset reading its window would reload at every step.
  for (const name of DATASETS) {
    const source = dataset(name).source;
    const text = source.type === 'sql' ? source.sql : source.query.rawSql;
    for (const v of ['walk_from', 'walk_to']) assert.doesNotMatch(text, new RegExp(`\\$${v}\\b`), `${name} reads ${v}`);
  }
  // The map filters on the GPU from the selection, through a saved time filter that kepler can split.
  const options = map.vizConfig.spec.options;
  assert.equal(options.mosaicSelection, 'cityFilters');
  assert.equal(options.timeSync, 'off');
  const [filter] = options.mapConfig.config.visState.filters;
  assert.deepEqual(filter.name, ['time']);
  assert.match(filter.plotType.interval, /^\d+-\w+$/);
  const [clock] = panelsByType(dashboard, 'ubica-chaski-filters-panel');
  assert.equal(clock.vizConfig.spec.options.layout, 'timeline');
  assert.equal(clock.vizConfig.spec.options.playMode, 'grow');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('every cell has its people and the minutes to each need, and the old centre has all six within ten', { timeout: 120_000 }, async (t) => {
  if (!walked()) return t.skip('no walk.parquet on this instance: datasets/cuenca-walk needs the R5 instance of Cuenca');
  const rows = await duckdb(STACK_URL, serverSql('cells'));
  const people = rows.reduce((sum, row) => sum + row.population, 0);
  // LlactaLAB's people per building in R5's extent: Cuenca and its parishes.
  assert.ok(people > 520_000 && people < 620_000, `${people} people`);
  for (const row of rows) {
    for (const need of NEEDS) assert.ok(row[need] === null || (row[need] >= 1 && row[need] <= 15), `${need} ${row[need]}`);
  }
  // Parque Calderón: a shop, a pharmacy, a clinic, a school, the park and a stop in minutes.
  const { px, py } = cellOf(-2.89735, -79.00455);
  const centre = rows.find((row) => row.px === px && row.py === py);
  assert.ok(centre, 'the cell of Parque Calderón');
  for (const need of NEEDS) assert.ok(centre[need] !== null && centre[need] <= 10, `${need}: ${centre[need]} min`);
  // Most people live within ten minutes of a bus or tram stop.
  const nearStop = rows.filter((row) => row.stop !== null && row.stop <= 10).reduce((sum, row) => sum + row.population, 0);
  assert.ok(nearStop / people > 0.6, `${Math.round((100 * nearStop) / people)} % near a stop`);
});

test('opens on a 10-minute walk with every panel drawn, and a step of the clock moves the figures', { timeout: 400_000 }, async (t) => {
  if (!walked()) return t.skip('no walk.parquet on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: DATASETS, timeoutMs: 180_000 });
  // Headless Chromium draws the map's streets in software GL for a minute and
  // more, and answers no action meanwhile.
  view.page.setDefaultTimeout(240_000);
  try {
    const card = async (title) => (await (await view.panel(title)).innerText()).replace(title, '').trim();
    assert.equal(await card('Walk'), '10 min');
    const all10 = Number((await card('All six needs')).replace(/\D/g, ''));
    assert.ok(all10 > 20 && all10 < 40, `${all10} % with all six in 10 minutes`);
    // One step forward: an 11-minute walk reaches more.
    const clock = await view.panel("The walk's clock, leaving home at 7:00: drag the window's end, or press play");
    await clock.getByRole('button', { name: /step forward/i }).first().click();
    await view.page.waitForFunction(
      () => [...document.querySelectorAll('[data-viz-panel-key]')].some((p) => /Walk\s*11 min/.test(p.innerText)),
      null,
      { timeout: 60_000 },
    );
    await view.page.waitForTimeout(2000);
    const all11 = Number((await card('All six needs')).replace(/\D/g, ''));
    assert.ok(all11 >= all10, `${all11} % in 11 minutes, ${all10} % in 10`);
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
