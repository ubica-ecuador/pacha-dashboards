// borges-map-of-the-empire: Borges' map of the Empire the size of the Empire (On Exactitude in Science, 1946) in
// five tabs, from datasets/borges/build.sh. Four USGS sheets around Rhyolite, Nevada, each a quarter of the one
// before (1:250,000 in 1908 to 1:24,000 in 1987), then the 1987 sheet laid at 1:1 over the town and torn by the
// years, with the animals GBIF records there. The story's buttons move between tabs (dtab in the URL); a ring marks
// Rhyolite on every map. Without the dataset's files on the instance, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'borges-map-of-the-empire';
const FEEDS = 'http://feeds/datasets/borges';
const TABS = ['1 · The Empire in 1908', '2 · A province in 1942', '3 · A district in 1954', '4 · A town in 1987',
  '5 · The town at one to one', '6 · About the data'];
const SHEETS = [ // file, the scale card, the neatline (NAD27 degrees), the level in sheets.parquet
  ['empire-1908.tif', '1:250,000', [-117, 36, -116, 37], 'empire'],
  ['province-1942.tif', '1:125,000', [-117, 36.5, -116.5, 37], 'province'],
  ['district-1954.tif', '1:62,500', [-117, 36.75, -116.75, 37], 'district'],
  ['town-1987.tif', '1:24,000', [-116.875, 36.875, -116.75, 37], 'town'],
];
const TOWN = [-116.845, 36.894, -116.813, 36.914];
const GNIS = [36.90384, -116.82924]; // Rhyolite, feature 845627
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const tabs = dashboard.spec.layout.spec.tabs;
const panelsIn = (i) => tabs[i].spec.layout.spec.items.map((it) => dashboard.spec.elements[it.spec.element.name].spec);
const mapIn = (i) => panelsIn(i).find((p) => p.vizConfig.group === 'ubica-keplerplus-panel');
const sqlOf = (map) => map.data.spec.queries.map((q) => q.spec.query.spec.rawSql);
const storyIn = (i) => panelsIn(i).map((p) => p.vizConfig.spec.options?.content).filter((c) => typeof c === 'string').join('\n');
const tabUrl = (i) => `/d/${UID}?dtab=${TABS[i].replaceAll(' ', '-')}`;
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/sheets.parquet`]) === '200';

// The tile server reads a GeoTIFF through the gateway, in Web Mercator, inside its neatline.
function tif(file, [w, s, e, n]) {
  const info = JSON.parse(compose(['exec', '-T', 'grafana', 'curl', '-s', `http://titiler/cog/info?url=${FEEDS}/${file}`]));
  assert.match(info.crs, /3857/);
  const deg = info.bounds.map((v, k) => (k % 2 ? (Math.atan(Math.sinh(v / 6378137)) * 180) / Math.PI : (v / 6378137) * (180 / Math.PI)));
  [w, s, e, n].forEach((want, k) => assert.ok(Math.abs(deg[k] - want) < 0.01, `${file}: ${deg[k]} against ${want}`));
}

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['cartography', 'chaski', 'duckdb', 'kepler', 'plus', 'wildlife']);
  for (const name of ['sheets', 'stages', 'animals']) {
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    assert.deepEqual(dataset(name).source.query.rawSql.match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${name}.parquet'`]);
  }
  assert.equal(dashboard.spec.layout.kind, 'TabsLayout');
  assert.deepEqual(tabs.map((t) => t.spec.title), TABS);
  for (let i = 0; i < 5; i++) {
    const map = mapIn(i);
    const o = map.vizConfig.spec.options;
    // Painted by Pacha's tile server over the satellite: kepler's rasterTile took the scans for reflectance.
    assert.deepEqual([o.rasterPainted, o.rasterServerUrl, o.basemap], [true, '/titiler', 'grafana-satellite']);
    const layers = o.mapConfig.config.visState.layers;
    assert.deepEqual(layers.filter((l) => l.config.dataId === 'grafana-A-raster').map((l) => l.type), ['cogPainted']);
    assert.equal(layers[0].id, 'rhyolite', 'the ring on top');
    const sql = sqlOf(map);
    assert.ok(sql.some((q) => q.includes(`SELECT ${GNIS[0]} AS latitude, ${GNIS[1]} AS longitude, 'Rhyolite' AS label`)), `tab ${i + 1}: the ring`);
    if (i < 4) {
      assert.match(sql[0], new RegExp(`'${FEEDS}/${SHEETS[i][0]}' AS raster_url`));
      assert.ok(storyIn(i).includes(`](${tabUrl(i + 1)})`), `tab ${i + 1}: a button to the next tab`);
    }
  }
  assert.ok(storyIn(4).includes(`](${tabUrl(0)})`), 'the 1:1 goes back to the Empire');
  const [brush] = panelsIn(4).filter((p) => p.vizConfig.group === 'ubica-timebrush-panel');
  assert.equal(brush.vizConfig.spec.options.output, 'variables');
  const [sheet, animals] = sqlOf(mapIn(4));
  assert.match(sheet, /'http:\/\/feeds\/datasets\/borges\/' \|\| file AS raster_url FROM \$stages/);
  assert.match(animals, /WHERE year <= w\.y/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the sheets nested and in place', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance: run its build.sh');
  const rows = await duckdb(STACK_URL, `SELECT * FROM '${FEEDS}/sheets.parquet' ORDER BY scale DESC`);
  assert.deepEqual(rows.map((r) => r.level), ['empire', 'province', 'district', 'town', 'one-to-one']);
  for (let i = 0; i < 4; i++) {
    const [me, next] = [rows[i], rows[i + 1]];
    // The next map lies inside this one and covers a quarter of it or less, on a sheet a few tens of cm wide.
    assert.ok(next.west >= me.west && next.east <= me.east && next.south >= me.south && next.north <= me.north, me.level);
    assert.ok((next.east - next.west) * (next.north - next.south) <= ((me.east - me.west) * (me.north - me.south)) / 4 + 1e-9);
    assert.ok(me.paper_w_cm > 30 && me.paper_w_cm < 50 && me.paper_h_cm > 40 && me.paper_h_cm < 60, me.level);
    tif(SHEETS[i][0], SHEETS[i][2]);
  }
});

test('the paper and the animals', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance');
  // Eight stages of five years, back to back from 1987 to 2026, the paper going from whole to a fifth.
  const stages = await duckdb(STACK_URL, `SELECT * FROM '${FEEDS}/stages.parquet' ORDER BY stage`);
  assert.equal(stages.length, 8);
  stages.forEach((s, k) => assert.deepEqual([Number(s.year_from), Number(s.year_to)], [1987 + 5 * k, 1991 + 5 * k]));
  assert.equal(Number(stages[0].paper_left), 1);
  for (let k = 1; k < 8; k++) assert.ok(Number(stages[k].paper_left) < Number(stages[k - 1].paper_left));
  assert.ok(Number(stages[7].paper_left) > 0.15 && Number(stages[7].paper_left) < 0.3);
  for (const s of stages) tif(s.file, TOWN);
  // The animals: in the town, with a year, under CC0 or CC BY 4.0 only.
  const [a] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(DISTINCT animal) AS kinds, max(year) AS y1,
      count(*) FILTER (WHERE latitude NOT BETWEEN ${TOWN[1]} AND ${TOWN[3]} OR longitude NOT BETWEEN ${TOWN[0]} AND ${TOWN[2]}) AS outside,
      count(*) FILTER (WHERE licence NOT IN ('CC0 1.0', 'CC BY 4.0') OR licence IS NULL) AS other_licence
    FROM '${FEEDS}/animals.parquet'`);
  assert.ok(Number(a.n) > 400 && Number(a.kinds) > 50, `${a.n} animals of ${a.kinds} kinds`);
  assert.deepEqual([Number(a.outside), Number(a.other_licence)], [0, 0]);
  assert.ok(Number(a.y1) <= new Date().getUTCFullYear());
});

test('opens on the Empire and unfolds tab by tab', { timeout: 400_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['sheets'], timeoutMs: 120_000 });
  const page = view.page;
  page.setDefaultTimeout(120_000);
  const shows = (texts) => page.waitForFunction((ts) => ts.every((x) => document.body.innerText.replace(/\s+/g, '').includes(x)),
    texts.map((x) => x.replace(/\s+/g, '')), { polling: 500 });
  try {
    await shows([SHEETS[0][1]]);
    await page.getByRole('link', { name: /Unfold the map of a province/ }).click();
    await shows([SHEETS[1][1]]);
    assert.match(decodeURIComponent(page.url()), /dtab=2-·-A-province-in-1942/);
    await page.goto(`${STACK_URL}${tabUrl(4)}`);
    await shows(['The year2026', 'Paper left22%']);
    await page.goto(`${STACK_URL}${tabUrl(4)}&var-t_lo=1990-01-01T00:00:00.000Z&var-t_hi=1991-01-01T00:00:00.000Z`);
    await shows(['The year1990', 'Paper left100%']);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
