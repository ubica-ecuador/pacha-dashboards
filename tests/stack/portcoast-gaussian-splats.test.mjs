// The portcoast-gaussian-splats dashboard: Esri's Portcoast industrial sample, a Gaussian splat scan
// served as 3D Tiles, streamed by Kepler Plus's Gaussian Splats layer (Plus f6e1c55), with five
// SIMULATED air quality stations on 3D Callouts standing on what the scan shows under them. It needs
// Kepler Plus: without it, the provisioning and browser tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, dsQueryBody, duckdb, openDashboard, rowsOf, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'portcoast-gaussian-splats';
const TILESET =
  'https://tiles.arcgis.com/tiles/V6ZHFr6zdgNZuVG0/arcgis/rest/services/Portcoast_industrial/3DTilesServer/tileset.json';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const areas = panelTitled(dashboard, 'Areas in the scan');
const sqlOf = (panel, i = 0) => panel.data.spec.queries[i].spec.query.spec.rawSql;
const air = maps.find((m) => m.vizConfig.spec.options.mapConfig.config.visState.layers.some((l) => l.type === 'callout'));
const configOf = (panel) => panel.vizConfig.spec.options.mapConfig;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['air-quality', 'buildings', 'duckdb', 'kepler', 'plus']);
  assert.equal(dashboard.spec.cursorSync, 'Crosshair');
  assert.equal(maps.length, 3);
  // Every map streams the same tileset from its first query's one row, grounded by its splats.
  for (const map of maps) {
    assert.match(sqlOf(map), new RegExp(`'${TILESET}' AS splat_url`));
    const layers = configOf(map).config.visState.layers;
    const scan = layers.find((l) => l.type === 'splats');
    assert.equal(scan.config.dataId, 'grafana-A');
    assert.equal(scan.config.visConfig.splatGround, true);
    assert.equal(map.vizConfig.spec.options.maxZoom, 24);
  }
  // The stations stand on the roofs and heaps the scan shows, their cards share the crosshair.
  const callout = configOf(air).config.visState.layers.find((l) => l.type === 'callout').config;
  assert.equal(callout.dataId, 'grafana-B');
  assert.equal(callout.visConfig.calloutBase, 'surface');
  assert.equal(callout.visConfig.sparkPublishCrosshair, true);
  // Simulated, and said so where the readings are.
  assert.match(sqlOf(air, 1), /^-- SIMULATED/);
  for (const title of ['PM10 by station (simulated)', 'PM2.5 by station (simulated)', 'NO₂ by station (simulated)']) {
    assert.ok(panelTitled(dashboard, title), title);
  }
  assert.match(air.title, /simulated/);
  for (const q of areas.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
});

test('the simulated stations: five, a reading every 10 minutes, fine dust a share of the dust', { timeout: 60_000 }, async () => {
  // Over the dashboard's own range, a day.
  const body = { ...dsQueryBody(sqlOf(air, 1)), from: 'now-24h' };
  const rows = rowsOf((await api(STACK_URL, '/api/ds/query', { method: 'POST', body })).json);
  const stations = new Map();
  for (const r of rows) stations.set(r.code, (stations.get(r.code) ?? 0) + 1);
  assert.deepEqual([...stations.keys()].sort(), ['GRN', 'PRC', 'SCR', 'SHD', 'STK']);
  for (const n of stations.values()) assert.ok(n >= 140 && n <= 146, `${n} readings`);
  for (const r of rows) {
    assert.ok(r.pm10 > 0 && r.pm10 < 400, `pm10 ${r.pm10}`);
    assert.ok(r.pm25 > 0 && r.pm25 < r.pm10, `pm25 ${r.pm25} of ${r.pm10}`);
    assert.ok(r.no2 > 0 && r.no2 < 200, `no2 ${r.no2}`);
  }
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('Esri still serves the scan: 27 areas, 5.3 GB, made with ArcGIS Reality', { timeout: 60_000 }, async () => {
  const [row, ...more] = await duckdb(STACK_URL, sqlOf(areas));
  assert.equal(more.length, 0);
  assert.equal(Number(row['Areas in the scan']), 27);
  assert.ok(row['Size on Esri'] > 4 && row['Size on Esri'] < 7, `${row['Size on Esri']} GB`);
  assert.match(row['Made with'], /^Reality Engine /);
});

test('the tiles are splats a browser on Pacha may read', { timeout: 60_000 }, async () => {
  const headers = { origin: 'https://pacha.ubica.dev' };
  const root = await fetch(TILESET, { headers });
  assert.equal(root.status, 200);
  assert.ok(['*', 'https://pacha.ubica.dev'].includes(root.headers.get('access-control-allow-origin')));
  const tileset = await root.json();
  assert.equal(tileset.asset.version, '1.1');
  // One area down to its first glTF tile: it declares the Khronos splat extension.
  const areaUrl = new URL(tileset.root.children[0].content.uri, TILESET);
  const area = await (await fetch(areaUrl, { headers })).json();
  let node = area.root;
  while (!node.content && node.children?.length) node = node.children[0];
  const glb = await fetch(new URL(node.content.uri, areaUrl), { headers });
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
    await view.panel('An industrial port in Quảng Ngãi, Vietnam, as Gaussian splats, with simulated air quality');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
