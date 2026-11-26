// The cuenca-3d-tiles dashboard: every building of Cuenca, Ecuador, in 3D from open data, as CityJSON tiles a Kepler
// Plus City Model reads by view (datasets/cuenca-3d/build.sh). Without the dataset's files on the instance, the data
// tests skip; without Plus, the dashboard is not there and the browser test skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'cuenca-3d-tiles';
const FEEDS = 'http://feeds/datasets/cuenca-3d';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = findAll(dashboard, (n) => n.kind === 'PanelQuery');
const mapSql = map.data.spec.queries[0].spec.query.spec.rawSql.replaceAll('${site:raw}', 'https://pacha.example');
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/tiles.parquet`]) ===
  '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'city', 'duckdb', 'kepler', 'plus']);
  // Every panel on the server DuckDB, reading only this repo's dataset.
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${FEEDS}/`), url);
  }
  // The site's address, hidden, for the URLs the browser fetches the tiles from.
  const [site] = dashboard.spec.variables;
  assert.equal(site.spec.name, 'site');
  assert.equal(site.spec.hide, 'hideVariable');
  assert.match(site.spec.query, /^https:\/\//);
  // One City Model in files mode, coloured by the files' own materials, its tiles read by view.
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(
    layers.map((l) => l.type),
    ['citymodel']
  );
  const { config } = layers[0];
  assert.equal(config.columnMode, 'files');
  assert.equal(config.visConfig.cityColourBy, 'material');
  assert.equal(config.visConfig.cityMaxTiles, 48);
  // Lit by the sun of the Sentinel-2 morning the roofs were seen on.
  const [effect] = map.vizConfig.spec.options.mapConfig.config.visState.effects;
  assert.equal(effect.type, 'lightAndShadow');
  assert.equal(effect.isEnabled, true);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the dataset holds every building of the city, in tiles over its urban area', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/cuenca-3d on this instance: run its build.sh');
  const [tiles] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, sum(buildings) AS b, min(west) AS w, max(east) AS e, min(south) AS s, max(north) AS n2
     FROM '${FEEDS}/tiles.parquet'`
  );
  assert.equal(Number(tiles.n), 697);
  assert.equal(Number(tiles.b), 208_206);
  // build.sh's default area: -79.08, -2.95, -78.92, -2.84.
  assert.ok(tiles.w >= -79.08 && tiles.e <= -78.92 && tiles.s >= -2.95 && tiles.n2 <= -2.84, JSON.stringify(tiles));
  const [surfaces] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT building_id) AS n, count(DISTINCT tone) AS tones, count(DISTINCT name) AS landmarks
     FROM '${FEEDS}/surfaces.parquet'`
  );
  assert.equal(Number(surfaces.n), 208_206);
  assert.equal(Number(surfaces.tones), 36);
  // The centre's thirteen churches and the Corte Provincial de Justicia.
  assert.equal(Number(surfaces.landmarks), 14);
  const rows = await duckdb(STACK_URL, mapSql);
  assert.equal(rows.length, 697);
  assert.match(rows[0].city_url, /^https:\/\/pacha\.example\/datasets\/cuenca-3d\/cityjson\/t_\d+_\d+\.json$/);
});

test('a tile reaches the browser as CityJSON, its faces coloured by materials', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/cuenca-3d on this instance');
  // The tile of Parque Calderón and the Catedral Nueva.
  const res = await fetch(`${STACK_URL}/datasets/cuenca-3d/cityjson/t_20198_17420.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const model = await res.json();
  assert.equal(model.type, 'CityJSON');
  assert.equal(model.version, '2.0');
  assert.match(model.metadata.referenceSystem, /EPSG\/0\/4979$/);
  assert.equal(model.appearance.materials.length, 36);
  const buildings = Object.values(model.CityObjects);
  assert.equal(buildings.length, 667);
  // Each face a roof or a wall, with a material under the theme "colour".
  for (const b of buildings) {
    const [g] = b.geometry;
    assert.equal(g.semantics.values.length, g.boundaries.length);
    assert.equal(g.material.colour.values.length, g.boundaries.length);
  }
  assert.ok(buildings.some((b) => b.attributes.name?.startsWith('Catedral de la Inmaculada')));
  // The Parquet beside it stays for DuckDB.
  assert.equal((await fetch(`${STACK_URL}/datasets/cuenca-3d/surfaces.parquet`)).status, 404);
});

test('opens with no panel in error', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/cuenca-3d on this instance');
  const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  if (provisioned.status === 404) return t.skip('not on this instance: it needs Kepler Plus with the City Model layer');
  const view = await openDashboard(`/d/${UID}`, { timeoutMs: 150_000, chaski: false });
  try {
    await (await view.panel('Where each height comes from')).getByText('height (OSM)').waitFor({ timeout: 60_000 });
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
