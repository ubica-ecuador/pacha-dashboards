// venezuela-earthquake-osm: the earthquakes of 24 June 2026 in Venezuela through OpenStreetMap. The buildings
// volunteers added in Caracas and La Guaira, day by day, on an H3 map with a Chaski Timeline and a Mosaic profile
// by hour; and a Kepler swipe between Vantor's imagery before and after, with HOT's validated damage. Its data is
// built by datasets/venezuela-eq-2026/build.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'venezuela-earthquake-osm';
const DS = 'http://feeds/datasets/venezuela-eq-2026';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;
const datasetSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'chaski', 'duckdb', 'kepler', 'mosaic', 'plus', 'satellite', 'seismic']);
  for (const name of ['changes', 'cells', 'years', 'damage']) {
    const ds = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
    assert.equal(ds.source.datasource.uid, 'duckdb', name);
    for (const url of datasetSql(name).match(/'[a-z]+:\/\/[^']+'/g)) assert.ok(url.startsWith(`'${DS}/`), url);
  }
  // The mapping: H3 cells as tall as their buildings at the window's end, the share added as the colour (an H3
  // layer's height is sizeField), the filters but the map's own area.
  const cells = options('map').mapConfig.config.visState.layers[0];
  assert.equal(cells.type, 'hexagonId');
  assert.equal(cells.visualChannels.sizeField.name, 'buildings');
  assert.equal(cells.visualChannels.colorField.name, 'added_pct');
  assert.match(el('map').data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$osmFilters, -area\)/);
  assert.match(options('hours').variables, /column: hr\n {2}from: hr_lo\n {2}to: hr_hi/);
  assert.equal(options('timeline').timeColumn, 't');
  // Before and after: a swipe, the imagery under the damage, and every query of that panel on the server (a panel
  // runs the queries of one datasource only).
  const swipe = options('swipe').mapConfig.config;
  assert.equal(swipe.mapState.mapSplitMode, 'SWIPE_COMPARE');
  const layers = swipe.visState.layers;
  assert.deepEqual(layers.slice(0, 2).map((l) => l.id), ['field', 'damage']);
  const [left, right] = swipe.visState.splitMaps.map((s) => s.layers);
  assert.ok(Object.keys(left).filter((id) => left[id]).every((id) => id.startsWith('pre-')));
  assert.ok(right.damage && right.field && !left.damage);
  for (const q of el('swipe').data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  assert.equal(options('swipe').rasterServerUrl, '/titiler');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('OpenStreetMap: about 51,000 buildings on 1 June, more than 170,000 on 27 July, all in the box', { timeout: 120_000 }, async () => {
  const [r] = await duckdb(STACK_URL, `WITH c AS (SELECT * FROM read_parquet('${DS}/osm_changes.parquet'))
    SELECT (SELECT sum(CASE kind WHEN 'creation' THEN 1 ELSE -1 END) FROM c WHERE time < TIMESTAMP '2026-06-01') AS june,
           (SELECT sum(CASE kind WHEN 'creation' THEN 1 ELSE -1 END) FROM c) AS july,
           min(latitude) AS s, max(latitude) AS n, min(longitude) AS w, max(longitude) AS e, max(time) AS last FROM c`);
  // ohsome's own counts of buildings in the box: 51,210 on 1 June and 172,036 on 27 July 2026.
  assert.ok(Math.abs(Number(r.june) - 51210) < 500, `${r.june} on 1 June`);
  assert.ok(Math.abs(Number(r.july) - 172036) < 1000, `${r.july} on 27 July`);
  assert.ok(r.s >= 10.35 && r.n <= 10.7 && r.w >= -67.35 && r.e <= -66.55, 'in the box');
});

test('the damage and the imagery: accepted cells, field reports, pre and post scenes on S3', { timeout: 120_000 }, async () => {
  const [d] = await duckdb(STACK_URL, `SELECT (SELECT count(*) FROM read_parquet('${DS}/damage_cells.parquet')) AS cells,
    (SELECT count(*) FROM read_parquet('${DS}/damage_points.parquet')) AS points,
    (SELECT count(*) FILTER (WHERE phase = 'pre') FROM read_parquet('${DS}/scenes.parquet')) AS pre,
    (SELECT count(*) FILTER (WHERE phase = 'post') FROM read_parquet('${DS}/scenes.parquet')) AS post`);
  assert.ok(Number(d.cells) > 500 && Number(d.points) > 300, JSON.stringify(d));
  assert.ok(Number(d.pre) >= 4 && Number(d.post) >= 20, JSON.stringify(d));
});

test('opens with no panel in error', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['changes', 'cells', 'years', 'damage'], timeoutMs: 150_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    const [{ n }] = await view.chaski('SELECT count(*) AS n FROM datasets.changes');
    assert.ok(Number(n) > 100000, `${n} changes`);
  } finally {
    await view.browser.close();
  }
});
