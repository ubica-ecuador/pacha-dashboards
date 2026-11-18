// The dangermond-mesh-vs-splats dashboard: one drone flight over Government Point and Percos Beach (The Nature
// Conservancy's Dangermond Preserve) as an I3S integrated mesh and as Gaussian splats in 3D Tiles, both streamed from
// ArcGIS, on three Kepler Plus maps split by a swipe curtain. It needs Kepler Plus built on a free panel that draws
// I3S meshes (free fix/i3s-mesh-unlit: deck.gl 9.4's mesh shader mended): without Plus, the provisioning and browser
// tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'dangermond-mesh-vs-splats';
const SERVICES = 'https://tiles.arcgis.com/tiles/u2Q4oAfciDZpDAD8/arcgis/rest/services';
const SPLATS = `${SERVICES}/GovernmentPoint_Percos_Gov2_GaussianSplatLayer_1782667712/3DTilesServer/tileset.json`;
const MESH = `${SERVICES}/GovernmentPoint_Percos_Gov2_IntegratedMesh/SceneServer/layers/0`;
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const products = panelTitled(dashboard, 'One flight, five products');
const stats = panelTitled(dashboard, 'Products of the flight');
const sqlOf = (panel, i = 0) => panel.data.spec.queries[i].spec.query.spec.rawSql;
const configOf = (panel) => panel.vizConfig.spec.options.mapConfig;
const headers = { origin: 'https://pacha.ubica.dev' };

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['cartography', 'duckdb', 'kepler', 'plus']);
  assert.equal(maps.length, 3);
  for (const map of maps) {
    const config = configOf(map);
    const { layers, splitMaps } = config.config.visState;
    // The mesh from its I3S scene layer, not grounded (its root sphere would lift it 1.5 km); the splats from the query.
    const mesh = layers.find((l) => l.type === 'tile3d');
    const splats = layers.find((l) => l.type === 'splats');
    assert.equal(mesh.config.visConfig.groundTileset, false);
    assert.equal(config.datasets.find((d) => d.data.id === mesh.config.dataId).data.metadata.tile3dUrl, MESH);
    assert.equal(splats.config.dataId, 'grafana-A');
    assert.equal(splats.config.visConfig.splatGround, true);
    assert.match(sqlOf(map), new RegExp(`'${SPLATS}' AS splat_url`));
    // A swipe curtain: the mesh on the left, the splats on the right, one camera.
    assert.equal(config.config.mapState.mapSplitMode, 'SWIPE_COMPARE');
    assert.equal(config.config.mapState.isViewportSynced, true);
    assert.deepEqual(splitMaps, [
      { layers: { [mesh.id]: true, [splats.id]: false } },
      { layers: { [mesh.id]: false, [splats.id]: true } },
    ]);
  }
  for (const panel of [products, stats, ...maps]) {
    for (const q of panel.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  }
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('ArcGIS still lists the flight\'s five products, the splats and the mesh among them', { timeout: 60_000 }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf(products));
  assert.equal(rows.length, 5);
  const byProduct = Object.fromEntries(rows.map((r) => [r.Product, r]));
  assert.ok(byProduct['Gaussian splats'].Size > 0.8 && byProduct['Gaussian splats'].Size < 2, 'splats size');
  assert.ok(byProduct['Integrated mesh'].Size > 1 && byProduct['Integrated mesh'].Size < 3, 'mesh size');
  const [row] = await duckdb(STACK_URL, sqlOf(stats));
  assert.equal(Number(row.Products), 5);
});

test('the splats are splat tiles and the mesh an integrated mesh a browser on Pacha may read', { timeout: 60_000 }, async () => {
  const tileset = await fetch(SPLATS, { headers });
  assert.equal(tileset.status, 200);
  assert.ok(['*', 'https://pacha.ubica.dev'].includes(tileset.headers.get('access-control-allow-origin')));
  const json = await tileset.json();
  assert.ok(json.extensions['3DTILES_content_gltf'].extensionsRequired.includes('KHR_gaussian_splatting'));
  const layer = await fetch(`${MESH}?f=json`, { headers });
  assert.equal(layer.status, 200);
  assert.ok(['*', 'https://pacha.ubica.dev'].includes(layer.headers.get('access-control-allow-origin')));
  const mesh = await layer.json();
  assert.equal(mesh.layerType, 'IntegratedMesh');
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('One flight, five products');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
