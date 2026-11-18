// The nyc-taxi-live dashboard: provisioned in Gallery, the week of trips that
// datasets/nyc-taxi/build.sh builds on each instance, and every panel query, as
// the file holds it, answering through Grafana with the variables of a fresh
// load (both cab types, no hexagon picked). Then a visitor opens it and no panel
// is in error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const dashboard = loadDashboard('dashboards/nyc-taxi-live.json');
const TRIPS = 'http://feeds/datasets/nyc-taxi/trips-2015-w38.parquet';
const queries = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  (p.spec.data?.spec.queries ?? []).map((q) => ({ title: p.spec.title, ref: q.spec.refId, sql: q.spec.query.spec.rawSql })),
);
// The datasource quotes a plain $var itself: an empty text variable is ''.
const fill = (sql, fare = ["''", "''"]) =>
  sql
    .replaceAll('${cab_type:sqlstring}', "'yellow','green'")
    .replaceAll('$from_zone', "''")
    .replaceAll('$to_zone', "''")
    .replaceAll('$fare_lo', fare[0])
    .replaceAll('$fare_hi', fare[1]);
const sqlOf = (title) => fill(panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'nyc-taxi-live');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'mobility', 'live', 'business-charts']);
  assert.doesNotMatch(JSON.stringify(dashboard), /\/testdata|sources-data|host\.docker\.internal/);
  assert.ok(queries.filter((q) => q.sql.includes('read_parquet')).every((q) => q.sql.includes(TRIPS)));
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/nyc-taxi-live');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the built week holds 3.09 million trips, every day of 14-20 September 2015, inside New York', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*) AS trips, count(DISTINCT pickup_time::DATE) AS days,
            min(pickup_time)::VARCHAR AS first, max(pickup_time)::VARCHAR AS last,
            min(pickup_lat) AS s, max(pickup_lat) AS n, min(pickup_lon) AS w, max(pickup_lon) AS e
     FROM read_parquet('${TRIPS}')`,
  );
  assert.equal(row.trips, 3086505);
  assert.equal(row.days, 7);
  assert.ok(row.first.startsWith('2015-09-14') && row.last.startsWith('2015-09-20'), JSON.stringify(row));
  assert.ok(row.s >= 40.49 && row.n <= 40.93 && row.w >= -74.27 && row.e <= -73.68, JSON.stringify(row));
});

test('every panel query answers, and taxis are on the road at any hour', async () => {
  for (const { title, ref, sql } of queries) {
    await assert.doesNotReject(duckdb(STACK_URL, fill(sql)), `${title} ${ref}`);
  }
  const [inTransit] = await duckdb(STACK_URL, sqlOf('Taxis in transit'));
  assert.ok(inTransit.taxis > 100, JSON.stringify(inTransit));
  const pickups = await duckdb(STACK_URL, sqlOf('Where people get in · last 10 minutes'));
  assert.ok(pickups.length > 50, `${pickups.length} pickup hexagons`);
});

test('opens with no panel in error', { timeout: 300_000 }, async () => {
  const view = await openDashboard('/d/nyc-taxi-live', { chaski: false, timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
