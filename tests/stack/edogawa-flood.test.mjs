// The edogawa-flood dashboard: Edogawa, Tokyo, building by building in PLATEAU's 3D city model, each coloured by the
// water PLATEAU's flood studies expect there (datasets/edogawa-flood/build.sh), with Mosaic charts over the same
// buildings in Chaski that filter the map. Without the dataset's files on the instance, the data tests skip; without
// Plus, the dashboard is not there and the browser test skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'edogawa-flood';
const FEEDS = 'http://feeds/datasets/edogawa-flood';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const mosaics = panelsByType(dashboard, 'ubica-chaski-mosaic-panel');
const queries = findAll(dashboard, (n) => n.kind === 'PanelQuery');
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
// A Chaski dataset's server query, as the dashboard opens: the largest river flood, any river, this site's address.
const serverSql = (name, { scenario = 'L2', river = 'any' } = {}) =>
  variable(name)
    .query.spec.source.query.rawSql.replaceAll('${scenario:sqlstring}', `'${scenario}'`)
    .replaceAll('${river:sqlstring}', `'${river}'`)
    .replaceAll('${site:sqlstring}', "'https://pacha.example'");
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/flood.parquet`]) ===
  '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'chaski', 'city', 'duckdb', 'kepler', 'mosaic', 'plus', 'water']);
  // Panels on the server DuckDB or on Chaski; the server reads only this repo's dataset.
  for (const q of queries) assert.ok(['duckdb', 'duckdbwasm'].includes(q.spec.query.datasource.name));
  for (const name of ['bld', 'tiles', 'shelters', 'border']) {
    assert.equal(variable(name).query.spec.source.type, 'datasource');
    const sql = variable(name).query.spec.source.query.rawSql;
    for (const url of sql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${FEEDS}/`), url);
  }
  // A City Model of the tiles' CityJSON, coloured by the rows' depth joined on each building's key, in PLATEAU's bands,
  // its rows those the brushes keep.
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(
    layers.map((l) => l.type),
    ['point', 'geojson', 'citymodel']
  );
  const city = layers[2];
  assert.equal(city.config.columnMode, 'files');
  assert.equal(city.config.visConfig.cityColourBy, 'data');
  assert.equal(city.config.visConfig.cityKeyAttribute, 'key');
  assert.equal(city.visualChannels.colorScale, 'custom');
  assert.deepEqual(
    city.config.visConfig.colorRange.colorMap.map(([v]) => v),
    [0.5, 3, 5, null]
  );
  assert.match(map.data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$bldFilters\)/);
  // Four Mosaic charts on one crossfilter selection, each writing the variables its filter reads.
  assert.equal(mosaics.length, 4);
  const filters = variable('bldFilters').query.spec.filters;
  for (const f of filters) {
    for (const ref of [f.from, f.to, f.variable].filter(Boolean)) {
      const name = ref.slice(1);
      assert.equal(variable(name).hide, 'hideVariable');
      assert.ok(
        mosaics.some((p) => p.vizConfig.spec.options.variables.includes(name)),
        `no chart writes ${name}`
      );
    }
  }
  // No dataset reads a variable a chart writes: a reload would clear every brush.
  for (const name of ['bld', 'tiles', 'shelters', 'border']) {
    assert.doesNotMatch(variable(name).query.spec.source.query.rawSql, /depth_lo|days_lo|storeys_lo|\$uses/);
  }
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test("the dataset holds PLATEAU's buildings of Edogawa and their floods", { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/edogawa-flood on this instance: run its build.sh');
  const [b] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(DISTINCT key) AS keys, count(DISTINCT mesh) AS tiles, count(storeys) AS storeys,
            min(lon) AS w, max(lon) AS e, min(lat) AS s, max(lat) AS n2
     FROM '${FEEDS}/buildings.parquet'`
  );
  assert.equal(Number(b.n), 144_788);
  assert.equal(Number(b.keys), 144_788);
  assert.equal(Number(b.tiles), 62);
  assert.equal(Number(b.storeys), 106_142);
  // The ward: between the Arakawa and the Edogawa, from Shibamata's south to Tokyo Bay.
  assert.ok(b.w > 139.82 && b.e < 139.93 && b.s > 35.63 && b.n2 < 35.76, `${b.w} ${b.e} ${b.s} ${b.n2}`);
  const rows = await duckdb(
    STACK_URL,
    `SELECT scenario, river, count(*) AS n, max(depth_m) AS deepest, max(hours) AS longest
     FROM '${FEEDS}/flood.parquet' GROUP BY ALL`
  );
  const of = (scenario, river) => rows.find((r) => r.scenario === scenario && r.river === river);
  // Only the Tone and the Edogawa have a planned-scale (L1) study; the Tone's largest flood is the longest.
  assert.deepEqual(rows.filter((r) => r.scenario === 'L1').map((r) => r.river).sort(), ['Edogawa', 'Tone']);
  assert.equal(Number(of('L2', 'Tone').n), 62_742);
  assert.ok(of('L2', 'Tone').deepest > 6 && of('L2', 'Tone').deepest < 6.5);
  assert.ok(of('L2', 'Tone').longest > 600, `${of('L2', 'Tone').longest} h`);
  // Tokyo's storm surge study: almost the whole ward, up to nearly 10 m.
  assert.equal(Number(of('Surge', 'Tokyo Bay').n), 142_841);
  assert.ok(of('Surge', 'Tokyo Bay').deepest > 9.5 && of('Surge', 'Tokyo Bay').deepest < 10);
  const [shelters] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM '${FEEDS}/shelters.parquet'`);
  assert.equal(Number(shelters.n), 163);
});

test('the 3D tiles reach the browser with the attributes the map shows', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/edogawa-flood on this instance');
  const res = await fetch(`${STACK_URL}/datasets/edogawa-flood/cityjson/m53394721.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const model = await res.json();
  assert.equal(model.type, 'CityJSON');
  assert.match(model.metadata.referenceSystem, /EPSG\/0\/6697$/);
  const buildings = Object.values(model.CityObjects);
  assert.equal(buildings.length, 5365);
  // Every building carries its key and the water of the storm surge; LoD 1 blocks for all, LoD 0 dropped.
  assert.ok(buildings.every((b) => Number.isInteger(b.attributes.key)));
  assert.ok(buildings.some((b) => typeof b.attributes.depth_surge_m === 'number'));
  assert.ok(buildings.every((b) => b.geometry.some((g) => g.lod === '1') && !b.geometry.some((g) => g.lod === '0')));
  // The Parquet beside it stays for DuckDB.
  assert.equal((await fetch(`${STACK_URL}/datasets/edogawa-flood/buildings.parquet`)).status, 404);
});

test('the datasets as the dashboard opens, and the sources of each study', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/edogawa-flood on this instance');
  const tiles = await duckdb(STACK_URL, serverSql('tiles'));
  assert.equal(tiles.length, 62);
  assert.equal(tiles.reduce((a, r) => a + Number(r.buildings), 0), 144_788);
  assert.match(tiles[0].city_url, /^https:\/\/pacha\.example\/datasets\/edogawa-flood\/cityjson\/m\d{8}\.json$/);
  // The largest river flood reaches almost the whole ward; the planned scale only the Tone's and the Edogawa's part.
  const [l2] = await duckdb(STACK_URL, `SELECT count(*) AS n, sum(no_dry_floor) AS nodry FROM (${serverSql('bld')})`);
  assert.equal(Number(l2.n), 140_560);
  assert.equal(Number(l2.nodry), 1_870);
  const [l1] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM (${serverSql('bld', { scenario: 'L1' })})`);
  assert.equal(Number(l1.n), 62_979);
  // The source picker offers only the study's own rivers (or the sea), after "Any".
  const sources = (scenario) =>
    duckdb(STACK_URL, variable('river').definition.replaceAll('${scenario:sqlstring}', `'${scenario}'`)).then((r) =>
      r.map((x) => x.__value)
    );
  assert.deepEqual(await sources('L1'), ['any', 'Edogawa', 'Tone']);
  assert.deepEqual(await sources('Surge'), ['any', 'Tokyo Bay']);
});

test('opens with no panel in error, the charts drawn over the buildings in the browser', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/edogawa-flood on this instance');
  const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  if (provisioned.status === 404) return t.skip('not on this instance: it needs Kepler Plus with the City Model layer');
  const view = await openDashboard(`/d/${UID}`, { timeoutMs: 150_000, datasets: ['bld', 'tiles'] });
  try {
    await (await view.panel('The ward under water')).getByText('Buildings under water').waitFor();
    const [bld] = await view.chaski('SELECT count(*) AS n FROM datasets.bld');
    assert.equal(Number(bld.n), 140_560);
    const deep = await view.panel('How deep');
    await deep.getByTestId('mosaic-panel').locator('svg rect').first().waitFor({ timeout: 60_000 });
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
