// The madrid-traffic-cameras dashboard: Madrid's traffic cameras from the City Council's list
// (datasets/madrid-traffic-cameras), what each one can see worked out by Kepler Plus's Viewshed
// layer against the base map's buildings and the terrain, and the picture the camera picked took.
// It needs Kepler Plus: without it, the provisioning and browser tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'madrid-traffic-cameras';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const maps = panelsByType(dashboard, 'ubica-keplerplus-panel');
const centre = panelTitled(dashboard, 'What the traffic cameras see of central Madrid: click one');
const closeUp = panelTitled(dashboard, '${camera}: what it sees');
const picture = panelTitled(dashboard, '${camera} now');
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const layersOf = (panel) => panel.vizConfig.spec.options.mapConfig.config.visState.layers;
// As Grafana sends it: the datasource quotes the variable.
const DEFAULT = dashboard.spec.variables.find((v) => v.spec.name === 'camera').spec.current.value;
const picked = (sql, camera = DEFAULT) => sql.replaceAll('$camera', `'${camera.replaceAll("'", "''")}'`);
const IN_MADRID = (r) => r.latitude > 40.3 && r.latitude < 40.55 && r.longitude > -3.85 && r.longitude < -3.5;
const metres = (a, b) => {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * 6_371_000;
};

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'business-text', 'city', 'duckdb', 'kepler', 'live', 'mobility', 'plus']);
  assert.equal(maps.length, 2);
  for (const panel of [...maps, picture]) {
    for (const q of panel.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  }
  // The list is read from the dataset the instance built, never from the city at each view.
  const text = JSON.stringify(dashboard);
  assert.ok(!text.includes('informo/tmadrid/CCTV.kml'));
  assert.ok(text.includes('http://feeds/datasets/madrid-traffic-cameras/cameras.parquet'));
  // Both maps see from 10 m, 250 m all round, against the base map's buildings and the terrain.
  for (const map of maps) {
    const views = layersOf(map).filter((l) => l.type === 'viewshed');
    assert.equal(views.length, 1);
    const v = views[0].config.visConfig;
    assert.equal(v.viewshedBuildings, '__basemap__');
    assert.equal(v.viewshedObstacles, 'both');
    assert.equal(v.viewshedEye, 10);
    assert.equal(v.viewshedRange, 250);
    assert.equal(v.viewshedBeamwidth, 360);
  }
  // A click on the centre map picks the camera; the close-up frames the camera picked.
  assert.deepEqual(centre.vizConfig.spec.options.variableMappings, [{ field: 'camera', source: 'click', variable: 'camera' }]);
  assert.deepEqual(closeUp.vizConfig.spec.options.fitOnVariables, ['camera']);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the city lists its cameras in Madrid, each with a picture', { timeout: 60_000 }, async () => {
  const cameras = await duckdb(
    STACK_URL,
    "SELECT * FROM read_parquet('http://feeds/datasets/madrid-traffic-cameras/cameras.parquet')"
  );
  assert.ok(cameras.length > 300 && cameras.length < 450, `${cameras.length} cameras`);
  assert.equal(new Set(cameras.map((c) => c.camera)).size, cameras.length, 'a name picks one camera');
  for (const c of cameras) {
    assert.ok(IN_MADRID(c), JSON.stringify(c));
    assert.match(c.picture_url, /^https:\/\/informo\.madrid\.es\/cameras\/Camara\d+\.jpg$/);
    assert.ok(['street', 'M-30', 'tunnel'].includes(c.setting), c.setting);
  }
  assert.ok(cameras.some((c) => c.camera === DEFAULT));
});

test('the centre map holds the cameras round Puerta del Sol, none in a tunnel', { timeout: 60_000 }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf(centre));
  assert.ok(rows.length > 40 && rows.length < 120, `${rows.length} cameras`);
  for (const r of rows) assert.ok(r.metres_from_sol >= 0 && r.metres_from_sol <= 2500, JSON.stringify(r));
  const counted = await duckdb(STACK_URL, sqlOf(panelTitled(dashboard, 'Watching the centre')));
  assert.equal(Number(counted[0]['Watching the centre']), rows.length);
});

test('the camera picked comes with a closed ring 250 m round it', { timeout: 60_000 }, async () => {
  const [row, ...more] = await duckdb(STACK_URL, picked(sqlOf(closeUp)));
  assert.equal(more.length, 0);
  assert.equal(row.camera, DEFAULT);
  const ring = row._geojson.replace(/^POLYGON \(\(|\)\)$/g, '').split(', ').map((p) => p.split(' ').map(Number));
  assert.ok(ring.length > 50);
  assert.deepEqual(ring[0], ring.at(-1));
  for (const p of ring) {
    const d = metres([row.longitude, row.latitude], p);
    assert.ok(Math.abs(d - 250) < 3, `${d} m`);
  }
});

test("the camera picked's picture is the city's latest", { timeout: 60_000 }, async () => {
  const [row] = await duckdb(STACK_URL, picked(sqlOf(picture)));
  const response = await fetch(row.picture_url, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/jpeg/);
  // The city replaces each picture every few minutes: a day-old one means the cameras stopped.
  const age = Date.now() - new Date(response.headers.get('last-modified')).getTime();
  assert.ok(age < 24 * 3600e3, `${Math.round(age / 60e3)} min old`);
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('What the traffic cameras see of central Madrid: click one');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
