// The wildfires-power-grid dashboard: NASA FIRMS's VIIRS fires through the
// gateway and the high-voltage grid built on this instance from Overture Maps
// (datasets/power-grid/build.sh), crossed in DuckDB on the server into three
// Chaski datasets that the browser cross-filters with Mosaic. The datasets'
// SQL runs here as a visitor's browser asks for it, with the variables filled
// in as Grafana fills them. It needs Kepler Plus (compose.plus.yaml): without
// it, the browser test is skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, rowsOf } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'wildfires-power-grid';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const REGIONS = { 'central-brazil': 'South_America', 'southern-africa': 'Southern_Africa', 'eastern-australia': 'Australia_NewZealand', california: 'USA_contiguous_and_Hawaii' };
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const serverSql = (name) => variable(name).query.spec.source.query.rawSql;
const fill = (sql, region, km = '5') =>
  sql
    .replaceAll('${region:sqlstring}', `'${region}'`)
    .replaceAll('${region:raw}', region)
    .replaceAll('${firms:raw}', REGIONS[region])
    .replaceAll('${km:raw}', km)
    .replaceAll('${km}', km);

async function run(sql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from: 'now-7d', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql: sql, rawQuery: true, format: 1 }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 500));
  return rowsOf(res.json);
}

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'plus', 'energy', 'satellite']);
  // Panels read the browser datasets only; the server is reached through them.
  const panels = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) => p.spec.data.spec.queries);
  assert.ok(panels.every((q) => q.spec.query.datasource.name === 'duckdbwasm'));
});

test('reads every source through the gateway only', () => {
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  assert.match(sql, /http:\/\/feeds\/firms\//);
  assert.match(sql, /http:\/\/feeds\/datasets\/power-grid\/lines\.parquet/);
  assert.doesNotMatch(sql, /https?:\/\/(?!feeds\/)/);
});

test('the grid of every region, from the file built on this instance', { timeout: 300_000 }, async () => {
  for (const region of Object.keys(REGIONS)) {
    const rows = await run(fill(serverSql('grid'), region));
    const km = rows.reduce((sum, r) => sum + Number(r.km), 0);
    assert.ok(rows.length > 100 && km > 5000, `${region}: ${rows.length} lines, ${Math.round(km)} km`);
    assert.ok(rows.every((r) => r.kv >= 200 && JSON.parse(r.geom).type === 'LineString'), region);
  }
});

test('every fire gets a distance to the grid, capped at 50 km, in every region', { timeout: 300_000 }, async () => {
  for (const region of Object.keys(REGIONS)) {
    const rows = await run(fill(serverSql('fires'), region));
    assert.ok(rows.length > 0, `${region}: no detection this week`);
    assert.ok(rows.every((r) => r.line_km >= 0 && r.line_km <= 50 && r.band && r.voltage), region);
    const week = Date.now() - 9 * 86400_000;
    assert.ok(rows.every((r) => new Date(r.time).getTime() > week), `${region}: a detection older than the week`);
  }
});

test('pairs reach no further than the distance, and a wider distance reaches more line', { timeout: 300_000 }, async () => {
  const pairs = async (km) => run(fill(serverSql('pairs'), 'central-brazil', km));
  const [near, far] = [await pairs('2'), await pairs('10')];
  assert.ok(near.length > 0, 'no fire within 2 km of a line');
  assert.ok(far.length > near.length);
  for (const [rows, km] of [[near, 2], [far, 10]]) {
    assert.ok(rows.every((r) => r.fire_km <= km + 0.01 && r.line_km <= r.fire_km + 0.01));
    // The stretch a fire reaches is at most twice the distance long.
    assert.ok(rows.every((r) => r.b_km - r.a_km <= 2 * km + 0.01 && r.b_km >= r.a_km));
  }
});

test('the gateway caches FIRMS, and serves the grid file', () => {
  const headers = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]);
  const firms = '/firms/noaa-20-viirs-c2/J1_VIIRS_C2_South_America_7d.csv';
  headers(firms);
  assert.match(headers(firms), /X-Cache-Status: (HIT|STALE|UPDATING)/i);
  assert.match(headers('/datasets/power-grid/lines.parquet'), /^HTTP\/1\.1 200/);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel in error', { skip, timeout: 240_000 }, async () => {
  view = await openDashboard(`/d/${UID}`, { datasets: ['grid', 'fires', 'pairs'], timeoutMs: 180_000 });
  assert.equal(await view.panelErrors(), 0);
  await view.page.getByTestId('mosaic-panel').first().locator('svg').waitFor({ timeout: 60_000 });
  assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  const [{ n }] = await view.chaski('SELECT count(*)::INTEGER AS n FROM datasets.fires');
  assert.ok(n > 0);
  assert.ok((await view.statNumber('Km of line mapped')) > 5000);
});
