// ecuador-from-inside: the earthquakes under the northern Andes at their depth, from datasets/andes-quakes/build.sh
// (the USGS's ComCat since 1904), on a Kepler Plus map in 3D turned inside out (or seen under the ground), a
// Mosaic profile of depth by longitude, a Timeline that grows the catalog, and cards on one crossfilter. Without
// the dataset's files on the instance, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'ecuador-from-inside';
const FEEDS = 'http://feeds/datasets/andes-quakes';
const BOX = { south: -12, north: 8, west: -84, east: -66 };
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/quakes.parquet`]) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'plus', 'seismic']);
  for (const name of ['quakes', 'land']) {
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    assert.deepEqual(dataset(name).source.query.rawSql.match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${name}.parquet'`]);
  }
  // The map: Kepler Plus on the shared selection, each earthquake lifted by its depth, a stem to each deep one.
  const map = el('map');
  assert.equal(map.vizConfig.group, 'ubica-keplerplus-panel');
  assert.equal(options('map').mosaicSelection, 'quakeFilters');
  const layers = options('map').mapConfig.config.visState.layers;
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  assert.equal(byId.quakes.config.columns.altitude, 'altitude');
  assert.deepEqual([byId.stems.type, byId.stems.config.columns.alt1], ['line', 'alt1']);
  const sql = map.data.spec.queries.map((q) => q.spec.query.spec.rawSql);
  assert.match(sql[0], /depth_km \* 1000 \* \$side::DOUBLE AS altitude/);
  // The stems in the same dataset as the points, so the shared selection filters both.
  assert.match(sql[0], /depth_km \* 1000 \* \$side::DOUBLE AS alt1/);
  assert.equal(byId.stems.config.dataId, byId.quakes.config.dataId);
  // The profile's box is one clause over two columns, which the map's link to the selection leaves out: the map
  // takes it from the variables in its own SQL, and the time and the drawn area through the selection.
  assert.match(sql[0], /WHERE \$__crossfilter\(\$quakeFilters, -time, -area\)/);
  // Turned inside out by default; under the ground at a click.
  assert.equal(variable('side').current.value, '1');
  assert.deepEqual(variable('side').options.map((o) => o.value), ['1', '-1']);
  // The profile writes its box, the timeline grows, the cards follow the filters.
  assert.match(options('profile').variables, /from: \[lon_lo, depth_lo\]/);
  assert.equal(options('timeline').playMode, 'grow');
  for (const card of ['count', 'deep', 'deepest', 'strongest'])
    assert.match(el(card).data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$quakeFilters\)/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the catalog: in the box, with depths, the plate going down', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/andes-quakes on this instance: run its build.sh');
  const [q] = await duckdb(STACK_URL, `SELECT count(*) AS n, min(latitude) AS s, max(latitude) AS n_, min(longitude) AS w,
      max(longitude) AS e, min(depth_km) AS d0, max(depth_km) AS d1, max(mag) AS m1, min(time) AS t0
    FROM '${FEEDS}/quakes.parquet'`);
  assert.ok(Number(q.n) > 10000, `${q.n} earthquakes`);
  assert.ok(q.s >= BOX.south && q.n_ <= BOX.north && q.w >= BOX.west && q.e <= BOX.east);
  assert.ok(q.d0 >= 0 && q.d1 > 600 && q.d1 < 700, `depths ${q.d0} to ${q.d1} km`);
  assert.ok(q.m1 >= 8.5 && q.m1 < 9.5, `strongest M${q.m1}`); // the Ecuador–Colombia earthquake of 1906, M8.8
  // The plate sinks eastwards: under Ecuador the quakes are deeper at 78° W than at the coast.
  const rows = await duckdb(STACK_URL, `SELECT floor(longitude) AS lon, median(depth_km) AS d FROM '${FEEDS}/quakes.parquet'
    WHERE latitude BETWEEN -3 AND 0 AND depth_km NOT IN (10, 33) AND floor(longitude) IN (-81, -78) GROUP BY 1 ORDER BY 1`);
  assert.ok(rows[1].d - rows[0].d > 80, JSON.stringify(rows));
  const land = await duckdb(STACK_URL, `SELECT string_agg(country, ',' ORDER BY country) AS c FROM '${FEEDS}/land.parquet'`);
  assert.match(land[0].c, /Colombia,Ecuador,Panama,Peru/);
});

test('opens with its cards, and the filters reach them', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/andes-quakes on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['quakes', 'land'], timeoutMs: 120_000 });
  const page = view.page;
  page.setDefaultTimeout(120_000);
  // The Earthquakes card (panel 3): its value, without its title.
  const count = async () => Number((await page.locator('[data-viz-panel-key="panel-3"]').innerText()).replace(/\D/g, ''));
  try {
    await page.waitForFunction(() => /Earthquakes\s+\d{2},\d{3}/.test(document.body.innerText), null, { polling: 500 });
    const all = await count();
    assert.ok(all > 10000, `${all} earthquakes`);
    assert.equal(await view.panelErrors(), 0);
    // The deep ones only, as the profile's box writes them: a hundred or so, under the Amazon.
    await page.goto(`${STACK_URL}/d/${UID}?var-depth_lo=300&var-depth_hi=700&var-lon_lo=-84&var-lon_hi=-66&var-side=-1`);
    await page.waitForFunction(() => /Earthquakes\s+\d{2,3}\s/.test(document.body.innerText), null, { polling: 500 });
    const deep = await count();
    assert.ok(deep > 50 && deep < 400, `${deep} earthquakes deeper than 300 km`);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
