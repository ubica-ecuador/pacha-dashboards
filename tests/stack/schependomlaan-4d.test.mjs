// The schependomlaan-4d dashboard: provisioned in Plus, the browser datasets as
// Grafana's DuckDB fills them from the files datasets/schependomlaan/build.sh
// makes, with the figures the schedule gives, the model served to browsers by
// the gateway, and the page opening with no panel or Mosaic chart in error. It
// needs Kepler Plus (compose.plus.yaml) and the built files: without either,
// the tests that need them are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'schependomlaan-4d';
const DATASETS = ['parts', 'daily', 'tasks', 'taskdays'];
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
// Plus dashboards are provisioned here whether or not Kepler Plus is mounted.
const noPlusApp =
  (await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings')).status === 404 && 'Kepler Plus is not mounted';
const noPlus = noPlusApp;
const built = noPlus
  ? false
  : await duckdb(STACK_URL, "SELECT count(*) AS n FROM 'http://feeds/datasets/schependomlaan/parts.parquet'").then(
      () => true,
      () => false,
    );
const skip = noPlus || (!built && 'datasets/schependomlaan/build.sh has not been run');

const sqlOf = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
const mosaics = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-chaski-mosaic-panel');
const brush = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-timebrush-panel')[0];

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  for (const tag of ['plus', 'chaski', 'duckdb', 'kepler', 'mosaic', 'buildings']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  // Everything from the files built on the instance.
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql.replace(/^\s*--.*$/gm, '')).join('\n');
  for (const url of sql.match(/'https?:\/\/[^']+'/g)) assert.ok(url.startsWith("'http://feeds/datasets/schependomlaan/"), url);
  // The Time Brush drives the Mosaic panels on their one Selection, on the datasets' time column.
  assert.equal(brush.vizConfig.spec.options.mosaicSelection, 'build');
  assert.equal(brush.vizConfig.spec.options.mosaicColumn, 'time');
  assert.equal(mosaics.length, 6);
  for (const p of mosaics) assert.match(p.vizConfig.spec.options.spec, /build: \{ select: crossfilter \}/, p.title);
  // No dataset reads the window, or every move would reload it.
  for (const name of DATASETS) assert.doesNotMatch(sqlOf(name), /\$t[01]\b|\$\{t[01]/, name);
});

test('is provisioned in Pacha dashboards', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('one row per element of the model, each placed at its origin in Nijmegen', { skip }, async () => {
  const rows = await duckdb(STACK_URL, sqlOf('parts'));
  assert.equal(rows.length, 3505);
  assert.equal(new Set(rows.map((r) => r.guid)).size, 3505);
  for (const row of rows) {
    assert.ok(row.time <= row.finish_date, row.guid);
    assert.ok(Math.abs(row.latitude - 51.8419) < 0.001 && Math.abs(row.longitude - 5.8362) < 0.001, row.guid);
  }
});

test('on 30 June 2015, 559 elements are built and 295 under construction, as the schedule has it', { skip }, async () => {
  const [row] = await duckdb(STACK_URL, `SELECT * FROM (${sqlOf('daily')}) WHERE time = TIMESTAMP '2015-06-30'`);
  assert.deepEqual([row.built_n, row.active_n, row.still_n, row.late_n].map(Number), [559, 295, 2651, 7]);
});

test('the schedule has the 27 tasks, fit-out last from September to December, a row per day each runs', { skip }, async () => {
  const tasks = await duckdb(STACK_URL, sqlOf('tasks'));
  assert.equal(tasks.length, 27);
  const fitOut = tasks.find((r) => r.task === 'Fit-out');
  assert.equal(new Date(fitOut.start).toISOString().slice(0, 10), '2015-09-07');
  assert.equal(new Date(fitOut.time).toISOString().slice(0, 10), '2015-12-31');
  const days = tasks.reduce((sum, r) => sum + Math.round((r.time - r.start) / 86_400_000) + 1, 0);
  const [{ n }] = await duckdb(STACK_URL, `SELECT count(*) AS n FROM (${sqlOf('taskdays')})`);
  assert.equal(Number(n), days);
});

test('the gateway serves the model to browsers as a glTF binary', { skip }, async () => {
  const res = await fetch(new URL('/datasets/schependomlaan/model.glb', STACK_URL));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4);
  assert.equal(new TextDecoder().decode(head), 'glTF');
});

test('opens with no panel or Mosaic chart in error, the cards at the window the brush opens with', { skip, timeout: 5 * 60_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: DATASETS, timeoutMs: 180_000 });
  try {
    await view.page.waitForTimeout(15_000);
    assert.equal(await view.panelErrors(), 0);
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    const built = await (await view.panel('Built')).locator('svg text').first().textContent();
    assert.equal(built, '559');
  } finally {
    await view.browser.close();
  }
});
