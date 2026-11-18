// The shipping-chokepoints-freight dashboard: ships a day through the 28
// chokepoints of the IMF's PortWatch, the shipping lanes under them, and the
// BLS deep sea freight index from FRED. DuckDB reads the sources on the
// server, Chaski queries them in the browser. It needs Kepler Plus
// (compose.plus.yaml): without it, the browser tests are skipped; without
// FRED_API_KEY in .env, so are the freight ones.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, duckdb } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const dashboard = loadDashboard('dashboards/shipping-chokepoints-freight.json');
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;

let current;
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/shipping-chokepoints-freight');
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';
const fredKey = compose(['exec', '-T', 'gateway', 'printenv', 'FRED_API_KEY']).trim();
const noFredKey = !fredKey && 'FRED_API_KEY is not set';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'shipping-chokepoints-freight');
  assert.ok(dashboard.spec.description);
  for (const tag of ['chaski', 'duckdb', 'kepler', 'maritime', 'plus']) assert.ok(dashboard.spec.tags.includes(tag), tag);
});

test('reads PortWatch transits and FRED through the gateway, and no API key', () => {
  assert.match(serverSql('transits'), /http:\/\/feeds\/portwatch\/items\//);
  assert.match(serverSql('freight'), /http:\/\/feeds\/fred\/series\/PCU483111483111/);
  assert.doesNotMatch(JSON.stringify(dashboard), /api_key/);
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  const browserSql = findAll(dashboard, (n) => n.group === 'ubica-chaski-datasource' && typeof n.spec?.rawSql === 'string');
  assert.ok(browserSql.length >= 8);
  for (const { spec } of browserSql) {
    for (const line of spec.rawSql.split('\n').filter((l) => l.trim().startsWith('--'))) assert.doesNotMatch(line, /'/, line);
  }
});

test('leaves the quoting of the chokepoint to Chaski', () => {
  // Chaski quotes a variable itself: '$chokepoint' would reach DuckDB as ''chokepoint1''.
  for (const sql of findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql)) {
    assert.doesNotMatch(sql, /'\$\{?chokepoint/);
  }
});

test('the transits cover all 28 chokepoints, day by day, up to the last fortnight', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT portid)::INTEGER AS n, (current_date - max(time)::DATE)::INTEGER AS age FROM (${serverSql('transits')})`,
  );
  assert.equal(row.n, 28);
  assert.ok(row.age <= 14, `newest day is ${row.age} days old`);
});

test('every chokepoint has a place on the map', async () => {
  const rows = await duckdb(STACK_URL, serverSql('chokepoints'));
  assert.equal(rows.length, 28);
  assert.ok(rows.every((r) => Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180));
});

test('the lanes are three GeoJSON lines, small enough for the browser', async () => {
  const rows = await duckdb(STACK_URL, serverSql('lanes'));
  assert.deepEqual(rows.map((r) => r.lane).sort(), ['Major', 'Middle', 'Minor']);
  const bytes = rows.reduce((n, r) => n + r.geometry.length, 0);
  assert.ok(bytes < 500_000, `${bytes} bytes of lanes`);
});

test('the freight index reaches back before the Red Sea attacks', { skip: noFredKey }, async () => {
  const [row] = await duckdb(STACK_URL, `SELECT min(time) <= '2023-01-01' AS early, count(*)::INTEGER AS n FROM (${serverSql('freight')})`);
  assert.ok(row.early);
  assert.ok(row.n > 400, `only ${row.n} months`);
});

test('a click on a chokepoint picks it', () => {
  const { variableMappings } = map.vizConfig.spec.options;
  assert.deepEqual(variableMappings, [{ field: 'portid', source: 'click', variable: 'chokepoint' }]);
  assert.deepEqual(layers.map((l) => l.type).sort(), ['geojson', 'point', 'sparkline']);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads for an anonymous visitor, with no panel in error', { skip: skip || noFredKey }, async () => {
  current = await openDashboard('/d/shipping-chokepoints-freight', {
    datasets: ['transits', 'chokepoints', 'lanes', 'freight'],
    timeoutMs: 120_000,
  });
  assert.equal(await current.panelErrors(), 0);
});
