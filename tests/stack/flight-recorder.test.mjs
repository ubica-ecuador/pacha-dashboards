// The recorder (compose profile `recorder`) and the recordings the gateway
// serves at http://feeds/recordings/, which is how Grafana's DuckDB, kept off
// local files, reads them. Without the profile only the fallback is tested: a
// manifest naming one empty file, with the recorder's columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, waitFor } from '../lib/pacha.mjs';
import { duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';

const MANIFEST = 'http://feeds/recordings/flights/manifest.json';
const EMPTY = 'http://feeds/recordings/flights-empty.parquet';
const running = compose(['ps', '--status', 'running', '--services']).split('\n').includes('recorder');
const off = !running && 'the recorder profile is off';

// Explicit columns: a fresh recorder's manifest is [], from which DuckDB detects none.
const manifest = async () =>
  duckdb(STACK_URL, `SELECT url FROM read_json('${MANIFEST}', columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})`);
const columns = async (from) =>
  (await duckdb(STACK_URL, `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ${from})`)).map(
    (c) => `${c.column_name} ${c.column_type}`,
  );

test('the manifest names files DuckDB can read', async () => {
  const list = (await manifest()).map((e) => `'${e.url}'`).join(', ');
  await duckdb(STACK_URL, `SELECT count(*) AS n FROM read_parquet([${list ? `${list}, ` : ''}'${EMPTY}'], union_by_name = true)`);
});

test('the empty recording has the feed columns', async () => {
  const empty = await columns(`'${EMPTY}'`);
  assert.equal(empty.length, 19);
  assert.deepEqual(empty.slice(0, 2), ['ts TIMESTAMP WITH TIME ZONE', 'hex VARCHAR']);
  assert.ok(empty.includes('cell UBIGINT'));
});

test('a file still being written is never served', () => {
  const status = compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
    'http://feeds/recordings/flights/manifest.json.tmp']);
  assert.equal(status, '404');
});

test('without a recording, the manifest names the empty file only', { skip: running && 'the recorder is on' }, async () => {
  assert.deepEqual((await manifest()).map((e) => e.url), [EMPTY]);
});

test('the recorder writes a poll a minute that DuckDB reads', { skip: off, timeout: 200_000 }, async () => {
  const urls = await waitFor(async () => {
    const entries = (await manifest()).filter((e) => e.url !== EMPTY);
    return entries.length > 0 && entries.map((e) => e.url);
  }, { timeoutMs: 150_000, intervalMs: 5_000, what: 'a recorded file in the manifest' });
  const list = urls.map((u) => `'${u}'`).join(', ');
  const [row] = await duckdb(STACK_URL, `SELECT count(*)::INTEGER AS n, count(DISTINCT hex)::INTEGER AS aircraft FROM read_parquet([${list}], union_by_name = true)`);
  assert.ok(row.aircraft > 1000, `only ${row.aircraft} aircraft`);
  // The newest file: older ones may predate a column.
  assert.deepEqual(await columns(`read_parquet(['${urls.at(-1)}'])`), await columns(`'${EMPTY}'`));
});

test('the recorder logs its polls', { skip: off }, async () => {
  const [row] = await duckdb(STACK_URL,
    `SELECT count(*)::INTEGER AS n, count(*) FILTER (WHERE status = 'ok')::INTEGER AS ok FROM read_parquet('http://feeds/recordings/flights/polls.parquet')`);
  assert.ok(row.ok > 0);
});
