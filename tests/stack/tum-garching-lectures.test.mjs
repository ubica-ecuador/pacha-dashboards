// The tum-garching-lectures dashboard: TUM's Garching campus on a Kepler Plus map with Floors,
// two buildings floor by floor from OpenStreetMap's indoor mapping and a day of lectures from
// NavigaTUM (datasets/tum-garching), read by the server DuckDB.
// The figures are checked against the campus: the Mathematics and Informatics and the
// Mechanical Engineering buildings, floors -1 to 4, thousands of rooms, the day's lectures in
// quarter hours between 07:00 and 21:00 in Garching. It needs Kepler Plus: without it, the
// tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'tum-garching-lectures';
const DS = 'http://feeds/datasets/tum-garching';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = Object.values(dashboard.spec.elements).flatMap((e) => e.spec.data.spec.queries);
const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
// The quarter the dashboard opens on, 14:00 in Garching, as Grafana writes ${__from} and ${__to}.
const FROM = Date.parse(dashboard.spec.timeSettings.from);
const windowed = (sql, from = FROM) => sql.replaceAll('${__from}', String(from)).replaceAll('${__to}', String(from + 900_000));

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'duckdb', 'kepler', 'plus']);
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g)) assert.ok(url.startsWith(`'${DS}/`), url);
  }
  const floors = map.vizConfig.spec.options.floors;
  assert.equal(floors.enabled, true);
  assert.deepEqual([floors.variable, floors.buildingVariable, floors.selectVariable], ['floor', 'building', 'room']);
  assert.equal(floors.queryFloors.G, 'facade');
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the campus: two buildings, floors -1 to 4, thousands of rooms in Garching, facades around them', { timeout: 120_000 }, async () => {
  const [row] = await duckdb(STACK_URL, `
    WITH r AS (SELECT * FROM read_parquet('${DS}/rooms.parquet'))
    SELECT (SELECT count(*) FROM r)::DOUBLE AS rooms,
           (SELECT string_agg(DISTINCT building, ',' ORDER BY building) FROM r) AS buildings,
           (SELECT count(*) FROM r WHERE NOT regexp_matches(level, '^-?[0-4](;-?[0-4])*$'))::DOUBLE AS odd_levels,
           (SELECT count(*) FROM r WHERE kind = 'Lecture hall')::DOUBLE AS halls,
           (SELECT count(*) FROM read_parquet('${DS}/facades.parquet'))::DOUBLE AS facades,
           (SELECT count(*) FROM read_parquet('${DS}/slabs.parquet'))::DOUBLE AS floors`);
  assert.ok(row.rooms > 3000 && row.rooms < 6000, `${row.rooms} rooms`);
  assert.equal(row.buildings, 'MI,MW');
  assert.equal(row.odd_levels, 0);
  assert.ok(row.halls >= 5, `${row.halls} lecture halls`);
  assert.ok(row.facades > 80, `${row.facades} facades`);
  assert.ok(row.floors >= 8 && row.floors <= 12, `${row.floors} floors`);
  // Every room inside the campus.
  const outside = await duckdb(STACK_URL, `
    SELECT count(*)::DOUBLE AS n FROM read_parquet('${DS}/rooms.parquet')
    WHERE NOT ST_Within(ST_GeomFromGeoJSON(geometry), ST_MakeEnvelope(11.664, 48.2615, 11.676, 48.269))`);
  assert.equal(outside[0].n, 0);
});

test('the day: lectures in quarter hours from 07:00 to 21:00, the ones on now lit and on callouts', { timeout: 120_000 }, async () => {
  const quarters = await duckdb(STACK_URL, `SELECT time::DOUBLE AS t, rooms_in_lecture::DOUBLE AS n FROM read_parquet('${DS}/quarters.parquet') ORDER BY t`);
  assert.equal(quarters.length, 56);
  assert.equal(new Date(quarters[0].t).toISOString(), '2026-11-10T06:00:00.000Z');
  assert.ok(Math.max(...quarters.map((q) => q.n)) > 40, 'a busy afternoon');
  const lit = await duckdb(STACK_URL, windowed(mapSql('F')));
  const callouts = await duckdb(STACK_URL, windowed(mapSql('H')));
  const now = quarters.find((q) => q.t === FROM).n;
  assert.equal(lit.length, now);
  assert.equal(callouts.length, now);
  for (const row of callouts) assert.ok(row.min_left > 0 && row.min_left <= 480 && row.title, JSON.stringify(row));
  // Lectures at night: none.
  assert.equal((await duckdb(STACK_URL, windowed(mapSql('F'), Date.parse('2026-11-10T02:00:00Z')))).length, 0);
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    for (const title of ['TUM Garching: rooms in a lecture', 'On now']) await view.panel(title);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
