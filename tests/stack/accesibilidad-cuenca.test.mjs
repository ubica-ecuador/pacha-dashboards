// The accesibilidad-cuenca dashboard: minutes to the nearest of 37 kinds of urban
// opportunity in Cuenca, one COG per kind from datasets/accesibilidad-cuenca/build.sh,
// coloured in the browser by the free Kepler panel and measured on the server by
// Pacha's tile server (statistics over the zone, the value under a point). Without
// the dataset's files on the instance, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'accesibilidad-cuenca';
const FEEDS = 'http://feeds/datasets/accesibilidad-cuenca';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const variable = (name) => findAll(dashboard, (n) => n.spec?.name === name && n.kind?.endsWith('Variable'))[0];
const VERSION = variable('version').spec.query;
const SLUGS = variable('categoria').spec.options.map((o) => o.value);
const sqlOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql;
// The values Grafana would put in, quoted as the DuckDB datasource quotes them:
// pharmacies, the whole raster, Parque Calderón.
const fill = (sql) =>
  sql
    .replaceAll('$categoria', "'farmacia'")
    .replaceAll('$version', `'${VERSION}'`)
    .replaceAll('$area', "''")
    .replaceAll('$lat', "'-2.897'")
    .replaceAll('$lng', "'-79.004'");
const info = (slug) =>
  api(STACK_URL, `/titiler/cog/info?url=${encodeURIComponent(`${FEEDS}/${slug}_${VERSION}.tif`)}`, { anonymous: true });
const built = async () => (await info('farmacia')).status === 200;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'mobility', 'city']);
  const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
  const options = map.vizConfig.spec.options;
  assert.equal(options.rasterServerUrl, '/titiler');
  // YlGnBu the other way round, dark blue near and pale for no access, as the
  // legend and bars say. Since kepler alpha.21 the shader's offset is in pixel
  // units: [1, 0] gives (max - v) / range. The bench's [-1, -1.5] now puts every
  // pixel below 0, one flat pale colour.
  const raster = options.mapConfig.config.visState.layers.find((l) => l.type === 'rasterTile');
  assert.deepEqual(raster.config.visConfig.linearRescalingFactor, [1, 0]);
  assert.equal(raster.config.visConfig.colormapId, 'ylgnbu');
  // Every URL a query reads is this repo's dataset or Pacha's tile server.
  for (const q of findAll(dashboard, (n) => typeof n.rawSql === 'string')) {
    for (const url of q.rawSql.match(/[a-z]+:\/\/[^'?]+/g) ?? []) {
      assert.ok(url.startsWith(`${FEEDS}/`) || url.startsWith('http://titiler/'), url);
    }
  }
  assert.equal(SLUGS.length, 37);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the tile server reads all 37 rasters', { timeout: 120_000 }, async (t) => {
  if (!(await built())) return t.skip('no datasets/accesibilidad-cuenca on this instance: run its build.sh');
  for (const slug of SLUGS) {
    const { status, json } = await info(slug);
    assert.equal(status, 200, slug);
    assert.equal(json.dtype, 'float32', slug);
    assert.deepEqual([json.width, json.height], [300, 219], slug);
  }
});

test('the zone, the bands and the point add up', { timeout: 300_000 }, async (t) => {
  if (!(await built())) return t.skip('no datasets/accesibilidad-cuenca on this instance');
  // The whole raster: 300 x 219 pixels of about 76 m, some 380 km² around Cuenca.
  const [zone] = await duckdb(STACK_URL, fill(sqlOf('${categoria:text}')));
  assert.equal(zone.Zona, 'Todo el ráster');
  assert.ok(zone.Superficie > 350 && zone.Superficie < 410, `${zone.Superficie} km²`);
  assert.ok(zone.Mediana >= 1 && zone.Mediana < 120);
  const bands = ['≤15 min', '15–30 min', '30–60 min', '60–120 min', 'Sin acceso (120)'];
  assert.ok(Math.abs(bands.reduce((s, b) => s + zone[b], 0) - 100) < 0.01);
  // From Parque Calderón, in the centre, a pharmacy is minutes away; every kind
  // has a value, 1 to 120.
  const point = await duckdb(STACK_URL, fill(sqlOf('Desde el punto · minutos a cada oportunidad')));
  assert.equal(point.length, 37);
  for (const row of point) assert.ok(row.Minutos >= 1 && row.Minutos <= 120, `${row.Oportunidad} ${row.Minutos}`);
  assert.ok(point.find((r) => r.slug === 'farmacia').Minutos <= 5);
  assert.deepEqual(point.map((r) => r.slug).sort(), [...SLUGS].sort());
});

test('opens with no panel in error', { timeout: 300_000 }, async (t) => {
  if (!(await built())) return t.skip('no datasets/accesibilidad-cuenca on this instance');
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  try {
    for (const title of ['Desde el punto · minutos a cada oportunidad', 'Las 37 oportunidades · parte de la zona según minutos a la más cercana']) {
      await (await view.panel(title)).locator('canvas, svg').first().waitFor();
    }
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
