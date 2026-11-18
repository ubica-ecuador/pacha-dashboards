// The air-traffic-world dashboard: adsb.lol live through the gateway, and the
// history the recorder (compose profile `recorder`) keeps, read back through
// http://feeds/recordings/. Every DuckDB query is run on the server with the
// dashboard's variables filled in as Grafana fills them: the recorded files
// that overlap the range, a picked aircraft or none, no drawn area.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';

const dashboard = loadDashboard('dashboards/air-traffic-world.json');
const EMPTY = 'http://feeds/recordings/flights-empty.parquet';

const panelSql = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  p.spec.data.spec.queries.map((q) => ({ title: p.spec.title, ref: q.spec.refId, sql: q.spec.query.spec.rawSql })),
);
const filesSql = findAll(dashboard, (n) => n.kind === 'QueryVariable' && n.spec.name === 'files')[0].spec.query.spec
  .__legacyStringValue;

async function run(sql, { from = 'now-1h', to = 'now' } = {}) {
  // Anonymous, as a visitor sends it: no admin password to get wrong.
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    anonymous: true,
    body: { from, to, queries: [{ refId: 'A', datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' }, rawSql: sql, rawQuery: true, format: 1 }] },
  });
  return rowsOf(res.json);
}

const quote = (s) => `'${s.replaceAll("'", "''")}'`;
// Every filter variable empty unless given, as on a fresh load.
const fill = (sql, { files, ...vars }) =>
  sql
    .replaceAll('${files:singlequote}', files.map(quote).join(','))
    .replace(/\$\{(\w+):sqlstring\}/g, (_, name) => quote(vars[name] ?? ''))
    .replaceAll('${zscale}', "'20'")
    .replaceAll('$__interval_ms', '60000');

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'air-traffic-world');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'plus', 'business-charts', 'aviation', 'live']);
});

test('the files variable always lists the empty recording', async () => {
  const urls = (await run(filesSql)).map((r) => r.url);
  assert.ok(urls.includes(EMPTY));
  const old = (await run(filesSql, { from: 'now-30d', to: 'now-29d' })).map((r) => r.url);
  assert.deepEqual(old, [EMPTY]);
});

test('every panel query runs over the recording', async () => {
  const files = (await run(filesSql)).map((r) => r.url);
  const [{ hex }] = await run(`SELECT hex FROM read_parquet([${files.map(quote).join(',')}]) WHERE ts > now() - INTERVAL 30 MINUTE LIMIT 1`).catch(() => [{ hex: '' }]);
  for (const { title, ref, sql } of panelSql) {
    for (const vars of [{ files }, { files, hex }]) {
      await assert.doesNotReject(run(fill(sql, vars)), `${title} ${ref} with ${JSON.stringify({ hex: vars.hex })}`);
    }
  }
});

test('the drawn area replays the aircraft inside it', async () => {
  const files = (await run(filesSql)).map((r) => r.url);
  const tracks = panelSql.find((p) => p.title.startsWith('Tracks'));
  const area = 'POLYGON((-10 35, 30 35, 30 60, -10 60, -10 35))';
  const rows = await run(fill(tracks.sql, { files, area }));
  if (files.length > 1) assert.ok(rows.length > 0, 'no aircraft over Europe in the last hour');
  for (const r of rows) {
    assert.ok(r.latitude >= 35 && r.latitude <= 60 && r.longitude >= -10 && r.longitude <= 30);
  }
});

test('with nothing recorded, history panels return no rows and no errors', async () => {
  // The main map also draws the live feed on top of the recording: not a history-only panel.
  for (const { title, sql } of panelSql.filter((p) => p.sql.includes('${files:singlequote}') && !p.sql.includes('adsblol'))) {
    const rows = await run(fill(sql, { files: [EMPTY] }));
    const empty = rows.length === 0 || rows.every((r) => Object.values(r).every((v) => v === 0 || v === null));
    assert.ok(empty, `${title}: ${JSON.stringify(rows).slice(0, 200)}`);
  }
});

test('the main map draws every aircraft in the world, even with nothing recorded', async () => {
  const map = panelSql.find((p) => p.title.startsWith('Every aircraft'));
  const rows = await run(fill(map.sql, { files: [EMPTY] }));
  assert.ok(new Set(rows.map((r) => r.icao24)).size > 1000, `only ${rows.length} rows`);
  assert.ok(rows.every((r) => r.latitude !== null && r.longitude !== null && r.time !== null));
});

test('a filter set by a chart narrows every panel', async () => {
  const files = (await run(filesSql)).map((r) => r.url);
  const kinds = panelSql.find((p) => p.title === 'Kind of flight');
  const all = await run(fill(kinds.sql, { files }));
  if (files.length < 2) return; // nothing recorded yet
  const airline = await run(fill(kinds.sql, { files, model: 'A320' }));
  assert.ok(airline.length > 0 && airline.length <= all.length);
  const map = panelSql.find((p) => p.title.startsWith('Every aircraft'));
  const military = await run(fill(map.sql, { files, kind: 'Military' }));
  assert.ok(military.every((r) => r.kind === 'Military'));
});
