// The cyclone-clouds-3d dashboard: provisioned in Plus, the two files
// datasets/cyclone-clouds/build.sh makes (one ECMWF run around Super Typhoon
// In-fa), the browser dataset and the eye as Grafana runs them, and the page
// opening with no panel or Mosaic chart in error. It needs Kepler Plus
// (compose.plus.yaml) and the built files: without either, the tests that need
// them are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'cyclone-clouds-3d';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const noPlus = provisioned.status === 404 && 'Kepler Plus is not mounted';
const built = noPlus
  ? false
  : await duckdb(STACK_URL, "SELECT count(*) AS n FROM 'http://feeds/datasets/cyclone-clouds/centres.parquet'").then(
      () => true,
      () => false
    );
const skip = noPlus || (!built && 'datasets/cyclone-clouds/build.sh has not been run');

const [dataset] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'clouds');
const map = findAll(dashboard, (n) => n.id === 2 && n.vizConfig)[0];
const eyeSql = map.data.spec.queries.find((q) => q.spec.refId === 'B').spec.query.spec.rawSql;
const mosaics = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-chaski-mosaic-panel');

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  for (const tag of ['plus', 'chaski', 'duckdb', 'kepler', 'mosaic', 'weather']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  // Everything from the files built on the instance; nothing live.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql.replace(/^\s*--.*$/gm, '')).join('\n');
  for (const url of sql.match(/'https?:\/\/[^']+'/g)) assert.ok(url.startsWith("'http://feeds/datasets/cyclone-clouds/"), url);
  // The brushes write variables no dataset reads, or each brush would reload it.
  for (const name of ['dist_lo', 'dist_hi', 'h_lo', 'h_hi', 'b_lo', 'b_hi']) {
    assert.match(mosaics.map((p) => p.vizConfig.spec.options.variables).join('\n'), new RegExp(`\\b${name}\\b`), name);
    assert.doesNotMatch(dataset.source.query.rawSql, new RegExp(`\\$${name}\\b`), name);
  }
  // The map filters on the selection the charts and the Time Brush share; no 2-D
  // brush, which the map would ignore.
  assert.equal(map.vizConfig.spec.options.mosaicSelection, 'cloudFilters');
  for (const p of mosaics) assert.doesNotMatch(p.vizConfig.spec.options.spec, /intervalXY/, p.title);
  // A quote in a Chaski comment would hide $__crossfilter from Chaski.
  for (const q of findAll(dashboard, (n) => n.datasource?.name === 'duckdbwasm' && typeof n.spec?.rawSql === 'string')) {
    for (const line of q.spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('is provisioned in Plus', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('the browser dataset: nine steps, within 1,000 km of the eye, humid, on eleven levels', { skip }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS n, count(DISTINCT time) AS steps, count(DISTINCT level_hpa) AS levels,
            min(humidity_pct) AS rh, max(distance_km) AS far, min(bearing_deg) AS b0, max(bearing_deg) AS b1,
            count(DISTINCT height_class) AS classes, max(ring_share) AS share
     FROM (${dataset.source.query.rawSql})`
  );
  assert.ok(row.n > 20_000 && row.n < 200_000, `${row.n} voxels`);
  assert.equal(row.steps, 9);
  assert.equal(row.levels, 11);
  assert.equal(row.classes, 5);
  assert.ok(row.rh >= 90 && row.far <= 1000 && row.b0 >= 0 && row.b1 < 360, JSON.stringify(row));
  assert.ok(row.share > 0 && row.share <= 1.5, `ring share ${row.share}`);
});

test("the eye: one a step, a deep low moving north-west over the western Pacific", { skip }, async () => {
  const rows = await duckdb(STACK_URL, eyeSql);
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.ok(row.latitude > 10 && row.latitude < 30 && row.longitude > 135 && row.longitude < 160, JSON.stringify(row));
    assert.ok(row.eye_hpa > 900 && row.eye_hpa < 990, JSON.stringify(row));
  }
  assert.ok(rows.at(-1).latitude > rows[0].latitude && rows.at(-1).longitude < rows[0].longitude);
});

test('opens with no panel or Mosaic chart in error', { skip, timeout: 5 * 60_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['clouds'], timeoutMs: 180_000 });
  try {
    await view.page.waitForTimeout(15_000);
    assert.equal(await view.panelErrors(), 0);
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.page.getByTestId('mosaic-panel').count(), 3);
  } finally {
    await view.browser.close();
  }
});
