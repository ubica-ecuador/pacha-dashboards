// urban-sciences-comfort: how warm or cool the Urban Sciences Building's rooms feel, as the PMV of ISO 7730, from
// the readings the recorder keeps for urban-sciences-building (recorder/feeds/urban-sciences-building.sql) and the
// plan of datasets/urban-sciences-building. The week, with its PMV for the clothes and activity picked, loads once
// into Chaski ($comfort, with $plan and $shell); the Time Brush moves the map's time filter. The PMV is checked
// against ISO 7730's own examples, the week against indoor air. The recording's tests are skipped while the
// recorder has written nothing, the page's without Kepler Plus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'urban-sciences-comfort';
const DS = 'http://feeds/datasets/urban-sciences-building';
const FEED = 'http://feeds/recordings/urban-sciences-building';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const datasets = Object.fromEntries(findAll(dashboard, (n) => n.kind === 'dataset').map((n) => [n.name, n.source.query.rawSql]));
const withChoice = (sql, clo = '1.0', met = '1.2') =>
  sql.replaceAll('${clo:sqlstring}', `'${clo}'`).replaceAll('${met:sqlstring}', `'${met}'`);
// The PMV macros of the comfort dataset, before its readings.
const macros = withChoice(datasets.comfort.slice(0, datasets.comfort.indexOf('-- Server side')));

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';
const manifest = await duckdb(STACK_URL,
  `SELECT count(*)::DOUBLE AS n FROM read_json('${FEED}/manifest.json', columns = {url: 'VARCHAR'})`).catch(() => [{ n: 0 }]);
const unrecorded = !(manifest[0]?.n > 0) && 'the recorder has written nothing for this feed';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'chaski', 'duckdb', 'kepler', 'plus']);
  assert.deepEqual(Object.keys(datasets).sort(), ['comfort', 'plan', 'shell']);
  for (const sql of Object.values(datasets)) {
    assert.match(sql, /^-- (PMV|Server side)/);
    for (const url of sql.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.ok(url.startsWith(`'${DS}/`) || url.startsWith(`'${FEED}/`), url);
  }
  const [map] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-keplerplus-panel');
  // Every map query reads the browser's datasets: moving the Time Brush asks the server nothing.
  for (const q of map.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdbwasm', q.spec.refId);
  const o = map.vizConfig.spec.options;
  assert.equal(o.timeSync, 'variables');
  assert.deepEqual(o.timeVariables, { from: 't0', to: 't1' });
  assert.deepEqual([o.floors.enabled, o.floors.field, o.floors.variable], [true, 'level', 'floor']);
  const [filter] = o.mapConfig.config.visState.filters;
  assert.deepEqual([filter.type, filter.dataId.sort()], ['timeRange', ['grafana-A', 'grafana-F']]);
  const [brush] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-timebrush-panel');
  assert.deepEqual([brush.vizConfig.spec.options.output, brush.vizConfig.spec.options.variables], ['variables', { from: 't0', to: 't1' }]);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('the PMV matches ISO 7730\'s examples', async () => {
  // ISO 7730:2005 Annex D: 22 °C and 27 °C, 60 %, 0.1 m/s, 1.2 met, 0.5 clo: PMV −0.75 and +0.77, PPD 17 %.
  const rows = await duckdb(STACK_URL, `${macros}
    SELECT ta, round(pmv(ta, 60, 0.1, 1.2, 0.5), 2) AS pmv, round(ppd(pmv(ta, 60, 0.1, 1.2, 0.5))) AS ppd,
           feels(pmv(ta, 60, 0.1, 1.2, 0.5)) AS feels
    FROM (VALUES (22.0), (27.0)) v(ta) ORDER BY ta`);
  assert.ok(Math.abs(rows[0].pmv + 0.75) <= 0.02 && Math.abs(rows[1].pmv - 0.77) <= 0.02, JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => r.ppd), [17, 17]);
  assert.deepEqual(rows.map((r) => r.feels), ['Slightly cool', 'Slightly warm']);
});

test('the plan: some 300 rooms with sensors, seven floors', { timeout: 120_000 }, async () => {
  const [row] = await duckdb(STACK_URL, `SELECT count(*)::DOUBLE AS rooms, count(DISTINCT level)::DOUBLE AS floors,
    count(*) FILTER (WHERE geometry LIKE '{"type":"%Polygon%')::DOUBLE AS shapes FROM (${datasets.plan})`);
  assert.ok(row.rooms > 250 && row.rooms < 350, `${row.rooms} rooms`);
  assert.equal(row.floors, 7);
  assert.equal(row.shapes, row.rooms);
});

test('the week: rooms hour by hour, indoor temperatures, the PMV moves with the clothes', { skip: unrecorded, timeout: 180_000 }, async () => {
  const sum = (clo) => {
    const sql = withChoice(datasets.comfort, clo);
    const i = sql.lastIndexOf('SELECT room_key, t AS time');
    return `${sql.slice(0, i)}SELECT count(*)::DOUBLE AS n, count(DISTINCT room_key)::DOUBLE AS rooms,
      count(DISTINCT time)::DOUBLE AS hours, min(temp_c) AS tmin, max(temp_c) AS tmax, avg(pmv) AS pmv,
      count(*) FILTER (WHERE pmv IS NULL)::DOUBLE AS no_pmv
      FROM (${sql.slice(i).replace(/ORDER BY time, room_key\s*$/, '')})`;
  };
  const [jumper] = await duckdb(STACK_URL, sum('1.0'));
  const [shirt] = await duckdb(STACK_URL, sum('0.7'));
  assert.ok(jumper.rooms >= 20 && jumper.rooms < 120, `${jumper.rooms} rooms`);
  assert.ok(jumper.hours >= 24 && jumper.hours <= 169, `${jumper.hours} hours`);
  assert.equal(jumper.no_pmv, 0);
  assert.ok(jumper.tmin > 5 && jumper.tmax < 40, `${jumper.tmin} to ${jumper.tmax} °C`);
  assert.ok(jumper.pmv > -2 && jumper.pmv < 1.5, `mean PMV ${jumper.pmv}`);
  assert.ok(shirt.pmv < jumper.pmv - 0.3, `a shirt feels cooler: ${shirt.pmv} against ${jumper.pmv}`);
});

test('opens with no panel in error', { skip: skip || unrecorded, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['comfort', 'plan', 'shell'], timeoutMs: 180_000 });
  try {
    for (const title of ['How every room feels, floor by floor', 'Feels, on average']) await view.panel(title);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
