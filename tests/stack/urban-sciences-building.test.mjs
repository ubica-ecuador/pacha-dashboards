// The urban-sciences-building dashboard: Newcastle University's Urban Sciences Building on a Kepler
// Plus map with Floors, its plan from datasets/urban-sciences-building and its readings live from
// the Urban Observatory's stream, as the recorder keeps them (recorder/feeds/urban-sciences-building.sql).
// The figures are checked against the building: seven floors, some 450 units of which about 300
// have sensors in the API, in Newcastle; readings in the range of indoor air. The recording's tests
// are skipped while the recorder has written nothing, the page's without Kepler Plus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'urban-sciences-building';
const DS = 'http://feeds/datasets/urban-sciences-building';
const FEED = 'http://feeds/recordings/urban-sciences-building';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const queries = Object.values(dashboard.spec.elements).flatMap((e) => e.spec.data?.spec.queries ?? []);
const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const filesSql = dashboard.spec.variables.find((v) => v.spec.name === 'files').spec.query.spec.__legacyStringValue;
// A panel query over the last day, with the files variable as Grafana fills it.
const now = Date.now();
const timed = (sql) => sql.replaceAll('$__timeFrom()', `to_timestamp(${(now - 86_400_000) / 1000})`)
  .replaceAll('$__timeTo()', `to_timestamp(${now / 1000})`);
async function overTheDay(sql) {
  const files = (await duckdb(STACK_URL, timed(filesSql))).map((r) => `'${r.url}'`).join(', ');
  return duckdb(STACK_URL, sql.replaceAll('${files:singlequote}', files)
    .replaceAll('${__from}', `'${now - 86_400_000}'`).replaceAll('${__to}', `'${now}'`)  // quoted, as the datasource writes them
    .replaceAll('$floor', "''").replaceAll('$room', "''"));
}

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';
const manifest = await duckdb(STACK_URL,
  `SELECT count(*)::DOUBLE AS n FROM read_json('${FEED}/manifest.json', columns = {url: 'VARCHAR'})`).catch(() => [{ n: 0 }]);
const unrecorded = !(manifest[0]?.n > 0) && 'the recorder has written nothing for this feed';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['air-quality', 'buildings', 'duckdb', 'kepler', 'plus']);
  for (const q of queries) {
    assert.equal(q.spec.query.datasource.name, 'duckdb');
    for (const url of q.spec.query.spec.rawSql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${DS}/`), url);
  }
  assert.ok(filesSql.includes(`'${FEED}/manifest.json'`) && filesSql.includes(`'${DS}/stream-empty.parquet'`));
  const floors = map.vizConfig.spec.options.floors;
  assert.equal(floors.enabled, true);
  assert.deepEqual([floors.field, floors.variable, floors.selectVariable], ['level', 'floor', 'room']);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the plan: seven floors, some 450 units in Newcastle, about 300 with sensors', { timeout: 120_000 }, async () => {
  const [row] = await duckdb(STACK_URL, `
    WITH u AS (SELECT * FROM read_parquet('${DS}/rooms.parquet'))
    SELECT (SELECT count(*) FROM u)::DOUBLE AS units,
           (SELECT count(*) FROM u WHERE entity_id IS NOT NULL)::DOUBLE AS with_entity,
           (SELECT count(DISTINCT room_key) FROM u)::DOUBLE AS keys,
           (SELECT string_agg(DISTINCT floor, ',' ORDER BY floor) FROM u) AS floors,
           (SELECT count(*) FROM read_parquet('${DS}/floors.parquet'))::DOUBLE AS slabs,
           (SELECT count(*) FROM read_parquet('${DS}/walls.parquet'))::DOUBLE AS walls,
           (SELECT round(sum(area_m2)) FROM u)::DOUBLE AS m2,
           (SELECT count(*) FROM u WHERE NOT ST_Within(ST_GeomFromText(wkt), ST_MakeEnvelope(-1.6265, 54.9732, -1.6240, 54.9743)))::DOUBLE AS outside`);
  assert.ok(row.units > 400 && row.units < 500, `${row.units} units`);
  assert.ok(row.with_entity > 250 && row.with_entity < 350, `${row.with_entity} with an entity`);
  assert.equal(row.keys, row.units);
  assert.equal(row.floors, '1,2,3,4,5,6,G');
  assert.deepEqual([row.slabs, row.walls], [7, 7]);
  // The building's net floor area, every unit: about 10,800 m².
  assert.ok(row.m2 > 9000 && row.m2 < 13000, `${row.m2} m²`);
  assert.equal(row.outside, 0);
  const kinds = await duckdb(STACK_URL, `SELECT kind, count(DISTINCT entity_id)::DOUBLE AS rooms FROM read_parquet('${DS}/points.parquet') GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(kinds.map((k) => k.kind), ['co2', 'lux', 'occupancy', 'rh', 'temp']);
  assert.ok(kinds.find((k) => k.kind === 'co2').rooms > 200, 'CO2 in most rooms');
});

test('the empty recording has the feed\'s columns', async () => {
  const feed = readFileSync(new URL(`../../recorder/feeds/${UID}.sql`, import.meta.url), 'utf8');
  const select = feed.slice(feed.indexOf('\nSELECT'), feed.indexOf('\nFROM m'));
  const names = [...select.matchAll(/ AS ([a-z_]+)(?=,|\n|$)/g)].map((m) => m[1]);
  const empty = await duckdb(STACK_URL, `DESCRIBE SELECT * FROM read_parquet('${DS}/stream-empty.parquet')`);
  assert.deepEqual(empty.map((c) => c.column_name), names);
  assert.equal(empty[0].column_type, 'TIMESTAMP WITH TIME ZONE');
});

test('the recording: rooms with CO2 now, the newest reading minutes old, values of indoor air', { skip: unrecorded, timeout: 120_000 }, async () => {
  const [latest] = await overTheDay(`SELECT epoch_ms(max(ts))::DOUBLE AS ms FROM read_parquet([\${files:singlequote}])`);
  assert.ok(now - latest.ms < 3_600_000, `the newest reading is ${Math.round((now - latest.ms) / 60_000)} min old`);
  const dials = await overTheDay(mapSql('F'));
  assert.ok(dials.length >= 20, `${dials.length} rooms with CO2`);
  for (const d of dials) assert.ok(d.co2_ppm >= 300 && d.co2_ppm < 5000, JSON.stringify(d));
  const rooms = await overTheDay(mapSql('A'));
  assert.ok(rooms.length > 250);
  for (const r of rooms.filter((r) => r.temp_c != null)) assert.ok(r.temp_c > 5 && r.temp_c < 40, JSON.stringify(r));
});

test('opens with no panel in error', { skip: skip || unrecorded, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    for (const title of ['Every room, floor by floor', 'Rooms by CO2']) await view.panel(title);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
