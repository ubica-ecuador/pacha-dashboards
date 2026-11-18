// The denmark-ais-trajectories dashboard: the Danish Maritime Authority's AIS,
// read a day at a time by the recorder (recorder/feeds/ais-denmark.sql) into
// stops, trips, encounters and busy water, and read back by DuckDB on the
// server through the gateway. Every query is run as a visitor runs it, with the
// dashboard's variables filled in as Grafana fills them. Without the recorder
// profile only the empty recording is there; without Kepler Plus
// (compose.plus.yaml) the browser test is skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, duckdb, rowsOf } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'denmark-ais-trajectories';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const TABLES = ['vessels', 'tracks', 'stops', 'trips', 'encounters', 'cells'];
const RECORDED = 'http://feeds/recordings/ais-denmark';
const EMPTY = 'http://feeds/recordings/ais-denmark-empty';
const queries = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  p.spec.data.spec.queries.map((q) => ({ title: p.spec.title || p.spec.description, ref: q.spec.refId, sql: q.spec.query.spec.rawSql })),
);
const sqlOf = (title, ref = 'A') => queries.find((q) => q.title === title && q.ref === ref).sql;
const days = (
  await duckdb(STACK_URL, `SELECT DISTINCT day FROM read_json('${RECORDED}/manifest.json', columns = {url: 'VARCHAR', day: 'VARCHAR', "table": 'VARCHAR'}) ORDER BY day DESC`)
).map((r) => r.day);
const none = days.length === 0 && 'the recorder has read no day';

const fill = (sql, { picked = days.slice(0, 1), kind = '', ships = '' } = {}) =>
  sql
    .replaceAll('${dirs:singlequote}', [...picked.map((d) => `'${RECORDED}/${d}'`), `'${EMPTY}'`].join(', '))
    .replaceAll('${kind:sqlstring}', `'${kind}'`)
    .replaceAll('${ships:sqlstring}', `'${ships}'`);

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
// Plus dashboards are provisioned here whether or not Kepler Plus is mounted.
const noPlusApp =
  (await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings')).status === 404 && 'Kepler Plus is not mounted';
const skip = noPlusApp;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'plus', 'business-charts', 'maritime', 'mobility']);
});

test('reads the recordings through the gateway only', () => {
  const sql = JSON.stringify([queries, dashboard.spec.variables]);
  assert.match(sql, /http:\/\/feeds\/recordings\/ais-denmark/);
  assert.doesNotMatch(sql, /ais\.dk|amazonaws/);
});

test('the empty recording has every table with the recorded columns', async () => {
  const columns = async (from) =>
    (await duckdb(STACK_URL, `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ${from})`)).map((c) => `${c.column_name} ${c.column_type}`);
  for (const table of TABLES) {
    const empty = await columns(`'${EMPTY}/${table}.parquet'`);
    assert.ok(empty.length > 3, table);
    if (days.length) assert.deepEqual(await columns(`'${RECORDED}/${days[0]}/${table}.parquet'`), empty, table);
  }
});

test('every panel query runs with no day recorded', async () => {
  for (const { title, ref, sql } of queries) await assert.doesNotReject(run(fill(sql, { picked: [] })), `${title} ${ref}`);
});

test('every panel query runs over the days recorded, filtered and not', { skip: none }, async () => {
  const [ship] = await run(fill(sqlOf('Port to port: the longest trips')));
  for (const filters of [{ picked: days }, { kind: 'Cargo' }, { ships: ship.mmsi }]) {
    for (const { title, ref, sql } of queries) await assert.doesNotReject(run(fill(sql, filters)), `${title} ${ref} ${JSON.stringify(filters)}`);
  }
});

test('a day has thousands of ships, their stops and trips, and few encounters', { skip: none }, async () => {
  const [r] = await run(fill(queries.find((q) => q.sql.includes('"Ships heard"')).sql));
  assert.ok(r['Ships heard'] > 1000, `${r['Ships heard']} ships`);
  assert.ok(r.Stops > 1000 && r.Trips > 1000, `${r.Stops} stops, ${r.Trips} trips`);
  assert.ok(r['Encounters at sea'] < 100, `${r['Encounters at sea']} encounters`);
});

test('following a ship draws its whole day, every 30 s', { skip: none }, async () => {
  const [ship] = await run(fill(sqlOf('Port to port: the longest trips')));
  const trail = await run(fill(sqlOf('Trips, replayed'), { ships: ship.mmsi }));
  assert.equal(new Set(trail.map((p) => p.trip_id)).size, 1);
  assert.ok(trail.length > 100, `${trail.length} positions`);
});

test('the gateway streams a published day uncached, and nothing but days', () => {
  const day = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const head = compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', '-r', '0-99', `http://feeds/dma-ais/aisdk-${day}.zip`]);
  assert.match(head, /^HTTP\/1\.1 206/);
  assert.doesNotMatch(head, /X-Cache-Status/i);
  const status = (path) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://feeds${path}`]);
  assert.equal(status('/dma-ais/index.html'), '404');
  assert.equal(status('/dma-ais/2025/aisdk-2025-01-01.zip'), '404');
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('loads for an anonymous visitor, with no panel in error', { skip }, async () => {
  view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  assert.equal(await view.panelErrors(), 0);
});
