// The amsterdam-panoramas-lidar dashboard: Dam Square as the City of Amsterdam keeps it, its 360°
// panoramas of every year, the AHN5 LiDAR as a 3D Tiles point cloud and its registers of buildings,
// monuments and trees (datasets/amsterdam-panoramas), each placed in the others: the viewer marks on the
// panorama what is in sight from its camera, and the map shows where the viewer looks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType, panelTitled } from '../lib/dashboards.mjs';

const UID = 'amsterdam-panoramas-lidar';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
const viewer = panelTitled(dashboard, 'The panorama in 360°, with what the city knows of what it shows');
const sight = panelTitled(dashboard, 'In sight from the panorama shown');
const sqlOf = (panel, refId = 'A') => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const value = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec.current.value;
const DS = 'http://feeds/datasets/amsterdam-panoramas';
// As Grafana sends them: the datasource quotes the variables.
const withVars = (sql, vars = {}) => {
  const all = { pano: value('pano'), year: value('year'), look: value('look'), fov: value('fov'), ...vars };
  return Object.entries(all).reduce((s, [k, v]) => s.replaceAll(`$${k}`, `'${v}'`), sql);
};
// The box round Dam Square.
const IN_BOX = (r) => r.latitude > 52.3710 && r.latitude < 52.3753 && r.longitude > 4.8892 && r.longitude < 4.8960;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'business-text', 'city', 'duckdb', 'kepler']);
  const text = JSON.stringify(dashboard);
  for (const el of Object.values(dashboard.spec.elements)) {
    for (const q of el.spec.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb', el.spec.title);
  }
  // Everything is read from the files the instance built, never from the city's APIs at each view; only the
  // panorama pictures come from the city, read by the browser.
  assert.ok(!text.includes('api.data.amsterdam.nl/panorama/panoramas/?'));
  assert.ok(!text.includes('/v1/bomen'));
  // The LiDAR is the instance's own tileset, by a relative address, as it stands (the street at height 0).
  const { config, datasets } = map.vizConfig.spec.options.mapConfig;
  assert.equal(datasets[0].data.metadata.tile3dUrl, '/datasets/amsterdam-panoramas/lidar/tileset.json');
  const lidar = config.visState.layers.find((l) => l.type === 'tile3d');
  assert.equal(lidar.config.visConfig.groundTileset, false);
  // A click on a panorama picks it; the map never reads it back into the panoramas' own query.
  assert.deepEqual(map.vizConfig.spec.options.variableMappings.map((m) => [m.source, m.field, m.variable]), [['click', 'pano_id', 'pano']]);
  assert.ok(!sqlOf(map, 'A').includes('$pano'));
  // The viewer writes where it looks; nothing it reads depends on it.
  for (const refId of ['P', 'M', 'N', 'Y']) assert.ok(!/\$look|\$fov/.test(sqlOf(viewer, refId)), refId);
});

test('is provisioned in Pacha dashboards', () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the panoramas: nine missions since 2016 in the box, north in the middle of each picture', { timeout: 60_000 }, async () => {
  const years = await duckdb(STACK_URL, `SELECT year, count(*) AS n, min(latitude) AS s, max(latitude) AS n_, min(longitude) AS w, max(longitude) AS e FROM read_parquet('${DS}/panoramas.parquet') GROUP BY year ORDER BY year`);
  assert.ok(years.length >= 9, JSON.stringify(years));
  assert.equal(years[0].year, 2016);
  for (const y of years) {
    assert.ok(Number(y.n) > 300, JSON.stringify(y));
    assert.ok(IN_BOX({ latitude: y.s, longitude: y.w }) && IN_BOX({ latitude: y.n_, longitude: y.e }), JSON.stringify(y));
  }
  const total = years.reduce((s, y) => s + Number(y.n), 0);
  assert.ok(total > 11000, `${total} panoramas`);
  // The ground under each, from the LiDAR: Amsterdam's centre stands a metre or two over NAP.
  const [g] = await duckdb(STACK_URL, `SELECT min(ground_nap) AS lo, max(ground_nap) AS hi FROM read_parquet('${DS}/panoramas.parquet')`);
  assert.ok(g.lo > -2 && g.hi < 6, JSON.stringify(g));
});

test('the registers, with the heights the LiDAR measures', { timeout: 60_000 }, async () => {
  const [palace] = await duckdb(STACK_URL, `SELECT built, height_lidar, monument_status, architect FROM read_parquet('${DS}/buildings.parquet') WHERE monument ILIKE '%Koninklijk paleis%'`);
  assert.equal(palace.built, 1655);
  assert.equal(palace.monument_status, 'Rijksmonument');
  assert.match(palace.architect, /Campen/);
  assert.ok(palace.height_lidar > 25 && palace.height_lidar < 45, `${palace.height_lidar} m`);
  // The National Monument's obelisk is 22 m tall.
  const [obelisk] = await duckdb(STACK_URL, `SELECT height_lidar FROM read_parquet('${DS}/monuments.parquet') WHERE name = 'Nationaal Monument'`);
  assert.ok(obelisk.height_lidar > 19 && obelisk.height_lidar < 25, `${obelisk.height_lidar} m`);
  // Amsterdam is a city of elms.
  const [trees] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(*) FILTER (WHERE genus LIKE '%Ulmus%') AS elms, median(height_lidar) AS h FROM read_parquet('${DS}/trees.parquet')`);
  assert.ok(Number(trees.n) > 150, JSON.stringify(trees));
  assert.ok(Number(trees.elms) > Number(trees.n) / 2, JSON.stringify(trees));
  assert.ok(trees.h > 6 && trees.h < 20, JSON.stringify(trees));
});

test('the point cloud reaches the browser, the Parquet does not', { timeout: 60_000 }, async () => {
  const tileset = await fetch(new URL('/datasets/amsterdam-panoramas/lidar/tileset.json', STACK_URL));
  assert.equal(tileset.status, 200);
  assert.equal(tileset.headers.get('access-control-allow-origin'), '*');
  const json = await tileset.json();
  assert.equal(json.root.refine, 'ADD');
  const tile = await fetch(new URL(`/datasets/amsterdam-panoramas/lidar/${json.root.content.uri}`, STACK_URL));
  assert.equal(tile.status, 200);
  assert.equal(Buffer.from(await tile.arrayBuffer()).subarray(0, 4).toString(), 'pnts');
  const parquet = await fetch(new URL('/datasets/amsterdam-panoramas/panoramas.parquet', STACK_URL));
  assert.notEqual(parquet.status, 200);
});

test('from the panorama shown: the landmarks in sight where the picture shows them', { timeout: 60_000 }, async () => {
  const [shown] = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'P')));
  assert.equal(shown.pano_id, value('pano'));
  assert.match(shown.url_4000, /^https:\/\/t1\.data\.amsterdam\.nl\/panorama\/.+\/equirectangular\/panorama_4000\.jpg$/);
  const marks = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'M')));
  const at = (label) => marks.find((m) => m.label === label);
  // Seen in the 2025 picture on the east side of the square: the obelisk at 112°, De Bijenkorf at about 45°.
  assert.ok(at('Nationaal Monument')?.yaw > 105 && at('Nationaal Monument').yaw < 120, JSON.stringify(at('Nationaal Monument')));
  assert.ok(at('De Bijenkorf')?.yaw > 30 && at('De Bijenkorf').yaw < 60, JSON.stringify(at('De Bijenkorf')));
  for (const m of marks) assert.ok(m.pitch > -10 && m.pitch < 45, JSON.stringify(m));
  // The same count in the table and the viewer.
  assert.equal((await duckdb(STACK_URL, withVars(sqlOf(sight)))).length, marks.length);
  // Steps on to the next panoramas, and the same spot in every year.
  const steps = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'N')));
  assert.ok(steps.length >= 2 && steps.every((s) => s.distance_m >= 2 && s.distance_m <= 25), JSON.stringify(steps));
  const years = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'Y')));
  assert.ok(years.length >= 9 && years.every((y) => y.distance_m <= 25), JSON.stringify(years));
  // Another year shows that year's panorama nearest the one picked.
  const [old] = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'P'), { year: '2016' }));
  assert.equal(old.year, 2016);
  assert.ok(old.from_pick_m < 25, JSON.stringify(old));
});

test('the city serves the pictures to any page', { timeout: 60_000 }, async () => {
  const [shown] = await duckdb(STACK_URL, withVars(sqlOf(viewer, 'P')));
  for (const url of [shown.url_2000, shown.url_4000]) {
    // A JPEG (the 2025 mission's are sent as application/octet-stream, which a browser decodes all the same),
    // open to any page, since the viewer draws it in WebGL.
    const response = await fetch(url, { headers: { Origin: 'https://example.org', Range: 'bytes=0-15' } });
    assert.ok([200, 206].includes(response.status), url);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const head = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...head.subarray(0, 3)], [0xff, 0xd8, 0xff], url);
  }
});

test('opens with no panel in error, the viewer on the panorama', { timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('The panorama in 360°, with what the city knows of what it shows');
    await view.page.waitForSelector('.pano-view .pnlm-render-container', { timeout: 60_000 });
    await view.page.waitForFunction(() => document.querySelectorAll('.pano-view .pano-pin').length > 5, null, { timeout: 60_000 });
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
