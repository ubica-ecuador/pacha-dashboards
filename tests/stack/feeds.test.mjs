// Pacha's gateway routes that this repo brings (gateway/*.conf.template): the
// ones that add a key on the way (TriMet's AppID, FRED's key) and adsb.lol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, duckdb, rawGet, STACK_URL } from '../lib/pacha.mjs';

// TriMet behind trimet-live-fleet. Every call needs an AppID, which the
// gateway adds from TRIMET_APP_ID; without one in .env TriMet refuses, and
// these tests are skipped.
const TRIMET = '/trimet/ws/v2/vehicles';
const trimetKey = compose(['exec', '-T', 'gateway', 'printenv', 'TRIMET_APP_ID']).trim();
const noTrimetKey = !trimetKey && 'TRIMET_APP_ID is not set';

test('DuckDB reads TriMet through feeds, the AppID added on the way', { skip: noTrimetKey }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT json_array_length(content::JSON, '$.resultSet.vehicle')::INTEGER AS n FROM read_text('http://feeds${TRIMET}')`,
  );
  assert.ok(row.n > 10, `only ${row.n} vehicles`);
});

test('TriMet is kept gzipped and handed over plain, once per cache period', { skip: noTrimetKey }, () => {
  const headers = (...extra) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', ...extra, `http://feeds${TRIMET}`]);
  headers();
  const plain = headers();
  assert.match(plain, /X-Cache-Status: HIT/i);
  assert.doesNotMatch(plain, /Content-Encoding/i);
  assert.match(headers('-H', 'Accept-Encoding: gzip'), /Content-Encoding: gzip/i);
});

test('the AppID never leaves the gateway', { skip: noTrimetKey }, () => {
  const answer = compose(['exec', '-T', 'grafana', 'curl', '-s', '-D', '-', `http://feeds${TRIMET}`]);
  assert.ok(!answer.includes(trimetKey));
});

// PortWatch and FRED behind shipping-chokepoints-freight. PortWatch's weekly
// CSV, from the address the ArcGIS Hub link redirects to; FRED through its
// API, with the key the gateway adds from FRED_API_KEY. Without one in .env,
// FRED refuses and its tests are skipped.
const CHOKEPOINTS = '/portwatch/items/3da2b9ca97684916b75c4013f95d18ab.csv';

test('DuckDB reads PortWatch through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `SELECT count(DISTINCT portid)::INTEGER AS n FROM read_csv('http://feeds${CHOKEPOINTS}')`);
  assert.equal(row.n, 28);
});

test('the PortWatch CSV is fetched once a day and then served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${CHOKEPOINTS}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

const FRED = '/fred/series/PCU483111483111';
const fredKey = compose(['exec', '-T', 'gateway', 'printenv', 'FRED_API_KEY']).trim();
const noFredKey = !fredKey && 'FRED_API_KEY is not set';

test('DuckDB reads FRED through feeds, the key added on the way', { skip: noFredKey }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT len(observations)::INTEGER AS n FROM read_json('http://feeds${FRED}')`,
  );
  assert.ok(row.n > 400, `only ${row.n} months`);
});

test('the FRED key never leaves the gateway', { skip: noFredKey }, () => {
  const answer = compose(['exec', '-T', 'grafana', 'curl', '-s', '-D', '-', `http://feeds${FRED}`]);
  assert.ok(!answer.includes(fredKey));
});

// adsb.lol's whole world, behind air-traffic-world and the recorder.
const WORLD = '/adsblol/world';

test('DuckDB reads every aircraft in the world through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT len(ac)::INTEGER AS n FROM read_json('http://feeds${WORLD}', columns = {ac: 'JSON[]'})`,
  );
  assert.ok(row.n > 1000, `only ${row.n} aircraft`);
});

test('adsb.lol is asked once a minute at most', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${WORLD}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});
