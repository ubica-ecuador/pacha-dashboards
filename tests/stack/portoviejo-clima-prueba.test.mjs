// The portoviejo-clima-prueba dashboard: midday shade, sky view and sun hours on the ground, the roofs and every wall
// panel of Portoviejo's centre, before and after street trees on calle Chile (datasets/portoviejo-clima/build.sh).
// Unlisted: off the home page, reached by its link. Without the dataset's files on the instance, the data tests skip;
// without Plus, the dashboard is not there and the browser test skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'portoviejo-clima-prueba';
const FEEDS = 'http://feeds/datasets/portoviejo-clima';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = findAll(dashboard, (n) => n.kind === 'PanelQuery');
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/tiles.parquet`]) ===
  '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'city', 'duckdb', 'kepler', 'plus', 'unlisted']);
  // Every query on the server DuckDB, reading only this repo's dataset (the tiles' https URLs are built from ${site}).
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${FEEDS}/`), url);
  }
  const [site] = dashboard.spec.variables;
  assert.equal(site.spec.name, 'site');
  assert.equal(site.spec.hide, 'hideVariable');
  assert.match(site.spec.query, /^https:\/\//);
  // Four maps: three base | scenario swipes and the difference.
  assert.equal(maps.length, 4);
  for (const m of maps) {
    const layers = m.vizConfig.spec.options.mapConfig.config.visState.layers;
    const city = layers.filter((l) => l.type === 'citymodel');
    assert.ok(city.length >= 1);
    for (const l of city) {
      assert.equal(l.config.columnMode, 'files');
      assert.equal(l.config.visConfig.cityColourBy, 'material');
    }
  }
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the dataset holds both scenarios, ground, roofs and walls', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/portoviejo-clima on this instance: run its build.sh or copy its files');
  const [tiles] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(DISTINCT conjunto) AS sets FROM '${FEEDS}/tiles.parquet'`);
  assert.equal(Number(tiles.n), 98);
  assert.equal(Number(tiles.sets), 7);
  const [faces] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(DISTINCT building_id) AS b FROM '${FEEDS}/superficies.parquet'`
  );
  assert.equal(Number(faces.n), 186_510);
  assert.equal(Number(faces.b), 2_657);
  const [trees] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM '${FEEDS}/arboles.parquet'`);
  assert.equal(Number(trees.n), 313);
  // The trees shade calle Chile's ground at midday far more than the baseline; the whole centre barely moves.
  const [chile] = await duckdb(
    STACK_URL,
    `SELECT base, esc FROM '${FEEDS}/resumen.parquet' WHERE zona = 'Calle Chile' AND superficie = 'Suelo' AND indicador = 'sombra'`
  );
  assert.ok(chile.base < 0.15 && chile.esc > 0.5, JSON.stringify(chile));
});

test('a tile reaches the browser as CityJSON, its faces coloured by class', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/portoviejo-clima on this instance');
  const res = await fetch(`${STACK_URL}/datasets/portoviejo-clima/cityjson/sombra-base_t_19908_17788.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const model = await res.json();
  assert.equal(model.type, 'CityJSON');
  assert.equal(model.version, '2.0');
  assert.equal(model.appearance.materials.length, 8);
  for (const b of Object.values(model.CityObjects)) {
    const [g] = b.geometry;
    assert.equal(g.semantics.values.length, g.boundaries.length);
    assert.equal(g.material.valor.values.length, g.boundaries.length);
  }
});

test('opens with no panel in error', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/portoviejo-clima on this instance');
  const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  if (provisioned.status === 404) return t.skip('not on this instance: it needs Kepler Plus with the City Model layer');
  const view = await openDashboard(`/d/${UID}`, { timeoutMs: 150_000, chaski: false });
  try {
    await (await view.panel('Calle Chile y todo el centro: antes y después')).getByText('Calle Chile').first().waitFor({ timeout: 60_000 });
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
