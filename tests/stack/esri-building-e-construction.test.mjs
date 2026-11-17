// The esri-building-e-construction dashboard: Esri's Building E in Redlands, California, in eight drone captures
// from May 2019 to March 2022, each a Gaussian splat scan served as 3D Tiles and streamed by Kepler Plus's Gaussian
// Splats layer, two of them side by side, picked in two variables. It needs Kepler Plus 48252a8 or later, which
// grounds a tileset of splats inland before its first tile loads: without Plus, the provisioning and browser tests
// are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, dsQueryBody, duckdb, openDashboard, rowsOf, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'esri-building-e-construction';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const table = panelTitled(dashboard, 'Every capture');
const captures = panelTitled(dashboard, 'Drone captures');
const sqlOf = (panel, i = 0) => panel.data.spec.queries[i].spec.query.spec.rawSql;
const configOf = (panel) => panel.vizConfig.spec.options.mapConfig;
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name);
const monthsOf = (name) => variable(name).spec.query.split(',');
const query = async (sql) => rowsOf((await api(STACK_URL, '/api/ds/query', { method: 'POST', body: dsQueryBody(sql) })).json);
// A map's query with its variable set, as the dashboard quotes it.
const withCapture = (map, month) => sqlOf(map).replace(/\$\{(capture|compare)\}/, `'${month}'`);

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'duckdb', 'kepler', 'plus']);
  assert.equal(maps.length, 2);
  // Each map: one row, the capture its variable picks, grounded by its splats, from the same viewpoint.
  const views = [];
  for (const [map, name] of [
    [maps[0], 'capture'],
    [maps[1], 'compare'],
  ]) {
    assert.match(sqlOf(map), new RegExp(`WHERE month = \\$\\{${name}\\}$`));
    const scan = configOf(map).config.visState.layers.find((l) => l.type === 'splats');
    assert.equal(scan.config.dataId, 'grafana-A');
    assert.equal(scan.config.visConfig.splatGround, true);
    assert.equal(map.vizConfig.spec.options.maxZoom, 24);
    views.push(JSON.stringify(configOf(map).config.mapState));
  }
  assert.equal(views[0], views[1]);
  // Both pickers offer the same eight captures; they open on the steel frame and the finished building.
  assert.deepEqual(monthsOf('capture'), monthsOf('compare'));
  assert.equal(monthsOf('capture').length, 8);
  assert.equal(variable('capture').spec.current.value, 'September 2019');
  assert.equal(variable('compare').spec.current.value, 'February 2021');
  for (const panel of [table, captures, ...maps]) {
    for (const q of panel.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  }
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('every capture is one row: Building E, a month, a tileset on Esri', { timeout: 60_000 }, async () => {
  for (const month of monthsOf('capture')) {
    for (const map of maps) {
      const rows = await query(withCapture(map, month));
      assert.equal(rows.length, 1, month);
      assert.match(rows[0].splat_url, /^https:\/\/tiles\.arcgis\.com\/.+\/3DTilesServer\/tileset\.json$/);
      assert.ok(Math.abs(rows[0].latitude - 34.0585) < 0.001 && Math.abs(rows[0].longitude + 117.1975) < 0.001);
    }
  }
});

test('Esri still lists the eight captures, oldest first, under a gigabyte in all', { timeout: 60_000 }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf(table));
  assert.deepEqual(
    rows.map((r) => r.Month),
    monthsOf('capture')
  );
  for (const r of rows) assert.ok(r['Size on Esri'] > 50 && r['Size on Esri'] < 300, `${r.Month}: ${r['Size on Esri']} MB`);
  const [stats] = await duckdb(STACK_URL, sqlOf(captures));
  assert.equal(Number(stats.Captures), 8);
  assert.equal(Number(stats['Months covered']), 34);
  assert.ok(stats['Splats on Esri'] > 0.5 && stats['Splats on Esri'] < 1.5, `${stats['Splats on Esri']} GB`);
});

test('each tileset is splats a browser on Pacha may read', { timeout: 120_000 }, async () => {
  const headers = { origin: 'https://pacha.ubica.dev' };
  const [row] = await query(withCapture(maps[0], 'September 2019'));
  for (const month of monthsOf('capture')) {
    const [{ splat_url: url }] = await query(withCapture(maps[0], month));
    const root = await fetch(url, { headers });
    assert.equal(root.status, 200, month);
    assert.ok(['*', 'https://pacha.ubica.dev'].includes(root.headers.get('access-control-allow-origin')), month);
    const tileset = await root.json();
    assert.equal(tileset.asset.version, '1.1', month);
    assert.ok(tileset.extensions['3DTILES_content_gltf'].extensionsRequired.includes('KHR_gaussian_splatting'), month);
  }
  // One capture down to its first glTF tile: it declares the Khronos splat extension.
  const tileset = await (await fetch(row.splat_url, { headers })).json();
  let node = tileset.root;
  while (!node.content && node.children?.length) node = node.children[0];
  const glb = await fetch(new URL(node.content.uri, row.splat_url), { headers });
  assert.equal(glb.status, 200);
  const bytes = new Uint8Array(await glb.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'glTF');
  const jsonLength = new DataView(bytes.buffer).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + jsonLength)));
  assert.ok(gltf.extensionsRequired.includes('KHR_gaussian_splatting'), gltf.extensionsRequired.join());
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('Every capture');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
