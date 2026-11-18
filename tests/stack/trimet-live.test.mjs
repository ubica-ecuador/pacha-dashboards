// The trimet-live dashboard (Gallery, free Kepler panel): TriMet's live Web
// Services API, read by DuckDB on the server through the gateway, which adds
// the AppID. Without TRIMET_APP_ID in .env TriMet answers 403, and the tests
// that need its data are skipped. The Plus version is
// plus/dashboards/trimet-live-fleet.json.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, duckdb } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const dashboard = loadDashboard('dashboards/trimet-live.json');
const sqls = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
const sqlOf = (title, refId = 'A') =>
  panelTitled(dashboard, title).data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
// The filters at their defaults ("All"), as Grafana writes them into the SQL.
const ALL = {
  mode: "'MAX light rail','FX bus rapid transit','Bus','WES commuter rail','Streetcar','Aerial tram'",
  route: "'__all__'",
  punctuality: "'__all__'",
  in_traffic: "'__all__'",
  vehicle: "''",
};
const fill = (sql) => sql.replace(/\$(\w+)/g, (m, name) => ALL[name] ?? m);

const keyed = compose(['exec', '-T', 'gateway', 'printenv', 'TRIMET_APP_ID']).trim() !== '';
const skip = !keyed && 'TRIMET_APP_ID is not set';

let current;
after(async () => current && current.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'trimet-live');
  assert.ok(dashboard.spec.description);
  for (const tag of ['duckdb', 'kepler', 'transit', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
});

test('reads TriMet only through the gateway, and carries no AppID', () => {
  assert.ok(sqls.length >= 12);
  const text = JSON.stringify(dashboard);
  assert.doesNotMatch(text, /sources-data|testdata|INSTALL|appid=/i);
  for (const sql of sqls) {
    for (const [url] of sql.matchAll(/'https?:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/trimet\/ws\/(v2|V1)\//, url);
  }
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/trimet-live');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the fleet is vehicles around Portland, with a delay each', { skip }, async () => {
  const rows = await duckdb(STACK_URL, fill(sqlOf('Most delayed vehicles now')));
  assert.ok(rows.length > 0);
  const [service] = await duckdb(STACK_URL, fill(sqlOf('Service right now')));
  assert.ok(service['Vehicles in service'] > 50, JSON.stringify(service));
  assert.ok(service['On time'] >= 0 && service['On time'] <= 100, JSON.stringify(service));
  const fleet = await duckdb(STACK_URL, fill(sqlOf('Fleet now — colored by punctuality')));
  for (const v of fleet) assert.ok(v.latitude > 45 && v.latitude < 46 && v.longitude > -123.5 && v.longitude < -122, JSON.stringify(v));
});

test('loads for an anonymous visitor, with no panel in error', { skip }, async () => {
  current = await openDashboard('/d/trimet-live?refresh=', { chaski: false, timeoutMs: 90_000 });
  assert.equal(await current.panelErrors(), 0);
});
