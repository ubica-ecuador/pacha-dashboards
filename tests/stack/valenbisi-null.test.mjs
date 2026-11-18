// valenbisi-null: where València's public bikes are NULL (no bike to take, no dock to leave one) over the last week,
// from the FIWARE platform's Parquet export of Valenbisi (Stellio): a Kepler Plus map of the stations, a Mosaic
// profile by hour of the day, the stations most often NULL, a Chaski Timeline and cards on one crossfilter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'valenbisi-null';
const EXPORT = 'https://fiware.ubica.dev/exports/bikes.parquet';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;
const docksSql = () => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'docks')[0].source.query.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'duckdb', 'kepler', 'mobility', 'mosaic', 'plus']);
  const docks = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'docks')[0];
  assert.equal(docks.source.datasource.uid, 'duckdb');
  assert.deepEqual(docksSql().match(/'[a-z]+:\/\/[^']+'/g), [`'${EXPORT}'`]);
  // The map: Kepler Plus, each station coloured by its lean (no dock minus no bike), the filters but its own area.
  assert.equal(el('map').vizConfig.group, 'ubica-keplerplus-panel');
  assert.equal(options('map').areaVariable, 'dockArea');
  const layers = Object.fromEntries(options('map').mapConfig.config.visState.layers.map((l) => [l.id, l]));
  assert.equal(layers.stations.visualChannels.colorField.name, 'lean');
  // Cards over the most NULL stations, each with its week: the share of its docks with a bike, 0 to 100.
  assert.equal(layers.cards.type, 'sparkline');
  assert.deepEqual([layers.cards.config.visConfig.sparkMin, layers.cards.config.visConfig.sparkMax], [0, 100]);
  assert.match(el('map').data.spec.queries[1].spec.query.spec.rawSql, /LIMIT 6\)\n  UNION/);
  assert.match(el('map').data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$dockFilters, -area\)/);
  // The day writes its hours, the timeline walks the week, the cards follow every filter.
  assert.match(options('day').variables, /column: hr\n {2}from: hr_lo\n {2}to: hr_hi/);
  assert.equal(options('timeline').timeColumn, 't');
  for (const card of ['no_bike', 'no_dock', 'day_cards', 'stations'])
    assert.match(el(card).data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$dockFilters\)/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the week: Valenbisi in València, each station NULL some of the time', { timeout: 120_000 }, async () => {
  const [w] = await duckdb(STACK_URL, `WITH d AS (${docksSql()})
    SELECT count(*) AS n, count(DISTINCT station) AS stations, min(latitude) AS s, max(latitude) AS n_, min(longitude) AS w,
      max(longitude) AS e, avg(no_bike) AS no_bike, avg(no_dock) AS no_dock, max(bikes + free - slots) AS over,
      date_diff('hour', min(t), max(t)) AS span_h FROM d`);
  assert.ok(Number(w.stations) > 250 && Number(w.stations) < 300, `${w.stations} stations`);
  assert.ok(w.s > 39.4 && w.n_ < 39.55 && w.w > -0.45 && w.e < -0.3, 'in València');
  assert.ok(Number(w.span_h) > 24 * 5, `${w.span_h} h of history`);
  // A station is empty or full now and then, never most of the time on average.
  assert.ok(w.no_bike > 0.02 && w.no_bike < 0.4, `no bike ${w.no_bike}`);
  assert.ok(w.no_dock > 0.01 && w.no_dock < 0.3, `no dock ${w.no_dock}`);
});

test('opens with its cards, and the hours of the day reach them', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['docks'], timeoutMs: 120_000 });
  const page = view.page;
  page.setDefaultTimeout(120_000);
  const card = async (key) => Number((await page.locator(`[data-viz-panel-key="${key}"]`).innerText()).match(/([\d.]+)\s*%/)[1]);
  try {
    await page.waitForFunction(() => /No dock\s+[\d.]+\s*%/.test(document.body.innerText), null, { polling: 500 });
    const allDay = await card('panel-4');
    assert.equal(await view.panelErrors(), 0);
    // From 1 to 5 at night more stations are full than over the whole day.
    await page.goto(`${STACK_URL}/d/${UID}?var-hr_lo=1&var-hr_hi=5`);
    await page.waitForFunction(() => /No dock\s+[\d.]+\s*%/.test(document.body.innerText), null, { polling: 500 });
    await page.waitForTimeout(3000);
    const night = await card('panel-4');
    assert.ok(night > allDay, `no dock ${night} % at night, ${allDay} % all day`);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
