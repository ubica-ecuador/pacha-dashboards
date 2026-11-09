// The cuenca-10-minute-utopia dashboard: an imagined plan of 60 hubs with the
// six daily needs, one a month from 2027, each where it brings all six within a
// 10-minute walk to the most people (datasets/cuenca-walk/build.sh: hub.sql,
// where the R5 instance of Cuenca runs, only pacha.ubica.dev). The plan's
// timeline filters the map on the GPU and the Mosaic panels by crossfilter,
// with no dataset reloading. Without hubs.parquet on the instance, the data
// tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'cuenca-10-minute-utopia';
const DATASETS = ['cells', 'streets', 'hubs', 'plan', 'curve', 'gain', 'lacked'];
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const serverSql = (name) => dataset(name).source.query.rawSql;
const planned = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://feeds/datasets/cuenca-walk/hubs.parquet']) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'demographics', 'duckdb', 'kepler', 'mobility', 'mosaic']);
  for (const query of map.data.spec.queries) assert.equal(query.spec.query.datasource.name, 'duckdbwasm');
  for (const name of ['cells', 'streets', 'hubs']) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    // Only the files Pacha's datasets/cuenca-access and this repo's
    // datasets/cuenca-walk build, through the gateway.
    for (const url of serverSql(name).match(/'[a-z]+:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/datasets\/cuenca-(access|walk)\//);
  }
  // The plan moves by crossfilter: a dataset reading its window would reload at every step.
  for (const name of DATASETS) {
    const source = dataset(name).source;
    const text = source.type === 'sql' ? source.sql : source.query.rawSql;
    for (const v of ['plan_from', 'plan_to']) assert.doesNotMatch(text, new RegExp(`\\$${v}\\b`), `${name} reads ${v}`);
  }
  // The map filters on the GPU from the selection, through one saved time
  // filter over both datasets that have time: the gained streets and the hubs.
  const options = map.vizConfig.spec.options;
  assert.equal(options.mosaicSelection, 'planFilters');
  assert.equal(options.timeSync, 'off');
  const [filter] = options.mapConfig.config.visState.filters;
  assert.deepEqual(filter.dataId, ['grafana-B', 'grafana-C']);
  assert.deepEqual(filter.name, ['time', 'time']);
  assert.match(filter.plotType.interval, /^\d+-\w+$/);
  const [plan] = panelsByType(dashboard, 'ubica-chaski-filters-panel');
  assert.equal(plan.vizConfig.spec.options.layout, 'timeline');
  assert.equal(plan.vizConfig.spec.options.playMode, 'grow');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('sixty hubs, a month apart, each bringing fewer people than the one before', { timeout: 120_000 }, async (t) => {
  if (!planned()) return t.skip('no hubs.parquet on this instance: datasets/cuenca-walk needs the R5 instance of Cuenca');
  const hubs = await duckdb(STACK_URL, serverSql('hubs'));
  assert.equal(hubs.length, 60);
  hubs.forEach((hub, i) => {
    assert.equal(hub.hub, i + 1);
    assert.ok(hub.stop, `hub ${hub.hub} has a stop to be named by`);
    // In Cuenca and the parishes around it.
    assert.ok(hub.latitude > -3.0 && hub.latitude < -2.8 && hub.longitude > -79.15 && hub.longitude < -78.9, `hub ${hub.hub} at ${hub.latitude}, ${hub.longitude}`);
    // A greedy plan: each hub brings no more people than the one before.
    if (i > 0) assert.ok(hub.people <= hubs[i - 1].people, `hub ${hub.hub} brings ${hub.people}, more than hub ${i}`);
  });
  assert.equal(hubs[0].opens, 'January 2027');
  assert.equal(hubs[59].opens, 'December 2031');
  const people = hubs.reduce((sum, hub) => sum + hub.people, 0);
  // From 30 % of 566,000 people with all six within ten minutes to about 64 %.
  assert.ok(people > 150_000 && people < 250_000, `${people} more people with all six`);
  // The cells: a hub's cells are within ten minutes of it, so none had all six before.
  const cells = await duckdb(STACK_URL, serverSql('cells'));
  const gained = cells.filter((cell) => cell.hub !== null);
  assert.ok(gained.length > 1000, `${gained.length} cells gained`);
  for (const cell of gained) assert.ok(cell.n < 6, `a gained cell had ${cell.n} of 6`);
  const total = cells.reduce((sum, cell) => sum + cell.population, 0);
  const today = cells.filter((cell) => cell.n === 6).reduce((sum, cell) => sum + cell.population, 0);
  assert.ok(today / total > 0.2 && today / total < 0.4, `${Math.round((100 * today) / total)} % today`);
});

test('opens on the whole plan with every panel drawn, and the timeline steps back', { timeout: 400_000 }, async (t) => {
  if (!planned()) return t.skip('no hubs.parquet on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: DATASETS, timeoutMs: 180_000 });
  // Headless Chromium draws the map's streets in software GL for a minute and
  // more, and answers no action meanwhile.
  view.page.setDefaultTimeout(240_000);
  try {
    const card = async (title) => (await (await view.panel(title)).innerText()).replace(title, '').trim();
    assert.equal(await card('Hubs'), '60');
    const all60 = Number((await card('All six')).replace(/\D/g, ''));
    assert.ok(all60 > 55 && all60 < 75, `${all60} % with all six after 60 hubs`);
    // One step back: 59 hubs reach fewer.
    const plan = await view.panel("The plan, a hub a month from 2027: drag the window's end, or press play");
    await plan.getByRole('button', { name: /step back/i }).first().click();
    await view.page.waitForFunction(
      () => [...document.querySelectorAll('[data-viz-panel-key]')].some((p) => /Hubs\s*59\b/.test(p.innerText)),
      null,
      { timeout: 60_000 },
    );
    await view.page.waitForTimeout(2000);
    const all59 = Number((await card('All six')).replace(/\D/g, ''));
    assert.ok(all59 <= all60, `${all59} % with 59 hubs, ${all60} % with 60`);
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
