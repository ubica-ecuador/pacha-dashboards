// The Borges ladder: five dashboards from datasets/borges/build.sh, linked one to the next. Four USGS sheets
// around Rhyolite, Nevada, each a quarter of the one before (borges-empire, -province, -district, -town), and
// the last laid at 1:1 over the town and torn by the years (borges-one-to-one). Shared by their test files.
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

export const FEEDS = 'http://feeds/datasets/borges';
export const LADDER = ['borges-empire', 'borges-province', 'borges-district', 'borges-town', 'borges-one-to-one'];
export const SHEETS = {
  'borges-empire': { level: 'empire', file: 'empire-1908.tif', year: 1908, scale: 250000, card: '1:250,000' },
  'borges-province': { level: 'province', file: 'province-1942.tif', year: 1942, scale: 125000, card: '1:125,000' },
  'borges-district': { level: 'district', file: 'district-1954.tif', year: 1954, scale: 62500, card: '1:62,500' },
  'borges-town': { level: 'town', file: 'town-1987.tif', year: 1987, scale: 24000, card: '1:24,000' },
};

export const load = (uid) => loadDashboard(`dashboards/${uid}.json`);
export const dataset = (dashboard, name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
export const theMap = (dashboard) => panelsByType(dashboard, 'ubica-keplerplus-panel')[0];
export const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/sheets.parquet`]) === '200';

// What every dashboard of the ladder shares: its tags, server datasets from this repo's files, a map painted
// by Pacha's tile server over the satellite, the five links in order, and the story's way down and up.
export function conventions(uid, tags, datasets) {
  const dashboard = load(uid);
  assert.equal(dashboard.metadata.name, uid);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, tags);
  for (const [name, file] of datasets) {
    const d = dataset(dashboard, name);
    assert.equal(d.source.type, 'datasource');
    assert.equal(d.source.datasource.uid, 'duckdb');
    assert.deepEqual(d.source.query.rawSql.match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${file}'`]);
  }
  const map = theMap(dashboard);
  const o = map.vizConfig.spec.options;
  assert.deepEqual([o.rasterPainted, o.rasterServerUrl, o.basemap], [true, '/titiler', 'grafana-satellite']);
  // The panel's own painted layer: kepler's rasterTile would take the scans for satellite reflectance.
  const layers = o.mapConfig.config.visState.layers;
  assert.deepEqual(layers.filter((l) => l.config.dataId === 'grafana-A-raster').map((l) => l.type), ['cogPainted']);
  for (const q of map.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdbwasm');
  assert.deepEqual(dashboard.spec.links.map((l) => l.url), LADDER.map((u) => `/d/${u}`));
  const story = findAll(dashboard, (n) => typeof n.content === 'string' && n.content.includes('](/d/borges-')).map((n) => n.content).join('\n');
  const i = LADDER.indexOf(uid);
  if (i < LADDER.length - 1) assert.match(story, new RegExp(`\\]\\(/d/${LADDER[i + 1]}\\)`), 'a way down the ladder');
  if (i > 0) assert.match(story, new RegExp(`\\]\\(/d/${LADDER[i === LADDER.length - 1 ? 0 : i - 1]}\\)`), 'a way back');
  return dashboard;
}

export async function provisioned(uid) {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${uid}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
}

// The tile server reads the GeoTIFF through the gateway, in Web Mercator, inside the neatline.
export function tif(file, [w, s, e, n]) {
  const info = JSON.parse(compose(['exec', '-T', 'grafana', 'curl', '-s', `http://titiler/cog/info?url=${FEEDS}/${file}`]));
  assert.match(info.crs, /3857/);
  const [x0, y0, x1, y1] = info.bounds.map((v, k) => (k % 2 ? (Math.atan(Math.sinh(v / 6378137)) * 180) / Math.PI : (v / 6378137) * (180 / Math.PI)));
  for (const [got, want] of [[x0, w], [y0, s], [x1, e], [y1, n]]) assert.ok(Math.abs(got - want) < 0.01, `${file}: ${got} against ${want}`);
  return info;
}

export async function opens(uid, query = '') {
  const view = await openDashboard(`/d/${uid}${query}`, { datasets: ['sheets'], timeoutMs: 120_000 });
  view.page.setDefaultTimeout(120_000);
  await (await view.panel(theMap(load(uid)).title)).locator('canvas').first().waitFor();
  return view;
}

export { duckdb, STACK_URL };
