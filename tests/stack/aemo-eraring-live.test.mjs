// The aemo-eraring-live dashboard: provisioned in Plus, the recorder keeping
// AEMO's five-minute SCADA through the gateway, the units table and model that
// datasets/eraring/build.sh makes, the queries as the file holds them, and the
// page opening with no panel in error. It needs Kepler Plus (compose.plus.yaml),
// the recorder (COMPOSE_PROFILES=recorder) and the built files: without them,
// the tests that need them are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'aemo-eraring-live';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const noPlus = provisioned.status === 404 && 'Kepler Plus is not mounted';
const manifestSql = `SELECT url FROM read_json('http://feeds/recordings/aemo-scada/manifest.json',
  columns = {url: 'VARCHAR', "from": 'TIMESTAMPTZ', "to": 'TIMESTAMPTZ'})`;
const recorded = noPlus ? [] : await duckdb(STACK_URL, manifestSql).catch(() => []);
const real = recorded.filter((r) => !r.url.endsWith('-empty.parquet'));
const built = noPlus
  ? false
  : await duckdb(STACK_URL, "SELECT count(*) AS n FROM 'http://feeds/datasets/eraring/units.parquet'").then(
      () => true,
      () => false,
    );
const skip =
  noPlus ||
  (!built && 'datasets/eraring/build.sh has not been run') ||
  (real.length === 0 && 'the recorder has no AEMO SCADA yet (COMPOSE_PROFILES=recorder)');

// A panel's SQL with the recorded files in place of $files, and the last day as the time range.
const files = () => [...real.map((r) => r.url), 'http://feeds/recordings/aemo-scada-empty.parquet'];
const sqlOf = (title) =>
  panelTitled(dashboard, title)
    .data.spec.queries[0].spec.query.spec.rawSql.replaceAll('${files:singlequote}', files().map((u) => `'${u}'`).join(', '))
    .replaceAll('$__timeFrom()', "(now() - INTERVAL 1 DAY)")
    .replaceAll('$__timeTo()', 'now()');

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  for (const tag of ['plus', 'duckdb', 'kepler', 'energy', 'live']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  // The readings come from the recorder through the gateway; nothing asks AEMO from a panel.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql).join('\n');
  assert.doesNotMatch(sql, /nemweb\.com\.au/);
  // The recorded files come from the recorder's manifest (the files variable).
  assert.match(JSON.stringify(dashboard.spec.variables), /http:\/\/feeds\/recordings\/aemo-scada\/manifest\.json/);
});

test('is provisioned in Plus', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('the recorder keeps every unit of the market every five minutes, the newest under a quarter of an hour old', { skip }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(DISTINCT duid) AS units, count(DISTINCT ts) AS intervals, max(ts) AS newest,
            count(*) FILTER (WHERE duid LIKE 'ER0_') AS eraring
     FROM read_parquet([${files().map((u) => `'${u}'`).join(', ')}])`,
  );
  assert.ok(row.units > 400, `${row.units} units`);
  assert.ok(row.eraring >= 4 * 12, `${row.eraring} Eraring readings`);
  assert.ok(Date.now() - row.newest < 15 * 60_000, `newest ${new Date(row.newest).toISOString()}`);
});

test('the map has the four units, each with a reading within its 720 MW and a state', { skip }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf('Eraring now, each unit in the colour of what it is doing'));
  assert.deepEqual(rows.map((r) => r.duid), ['ER01', 'ER02', 'ER03', 'ER04']);
  for (const row of rows) {
    assert.ok(row.mw >= -50 && row.mw <= 800, JSON.stringify(row));
    assert.ok(['Full load', 'Running', 'Low load', 'Offline'].includes(row.state), JSON.stringify(row));
    assert.match(row.reading, /AEST$/);
  }
});

test('the gateway serves the model to browsers as a glTF binary', { skip }, async () => {
  const res = await fetch(new URL('/datasets/eraring/model.glb', STACK_URL));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
});

test('opens with no panel in error', { skip, timeout: 180_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 90_000 });
  try {
    for (const title of ['Eraring now, each unit in the colour of what it is doing', 'Output by unit, every five minutes (MW)']) {
      await view.panel(title);
    }
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
