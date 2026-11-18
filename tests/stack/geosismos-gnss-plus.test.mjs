// The geosismos-gnss-plus dashboard: Chilean GNSS station shifts from
// Geo-Sismos on a Kepler Plus map whose arrows measure the time brush. A
// handful of checks: conventions, the brush wiring, the network query, the
// built file of daily positions (skipped without datasets/geosismos/build.sh),
// one station's series, and that it opens without errors (skipped without
// Kepler Plus). The sources are public, so these tests need the internet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, duckdb } from '../lib/pacha.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'geosismos-gnss-plus';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const mapConfig = map.vizConfig.spec.options.mapConfig.config;

// The server query that fills a Chaski dataset, for a given window.
const serverSql = (name, from = '2025-01-01', to = '2026-09-20') =>
  dashboard.spec.variables
    .find((v) => v.spec.name === name)
    .spec.query.spec.source.query.rawSql.replaceAll('$__timeFrom()', `TIMESTAMP '${from}'`)
    .replaceAll('$__timeTo()', `TIMESTAMP '${to}'`);

const seriesSql = findAll(dashboard, (n) => typeof n.rawSql === 'string' && n.rawSql.includes('graphs?id_station'))[0]
  .rawSql.replaceAll('${station:raw}', 'ANTC')
  .replaceAll('$__timeFrom()', "TIMESTAMP '2025-01-01'")
  .replaceAll('$__timeTo()', "TIMESTAMP '2026-09-20'");

const FILE = 'http://feeds/datasets/geosismos/positions.parquet';
const status = (url) =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url]).trim();
const unbuilt = status(FILE) !== '200' && 'Geo-Sismos positions are not built on this stack (datasets/geosismos/build.sh)';

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
// Plus dashboards are provisioned here whether or not Kepler Plus is mounted.
const noPlusApp =
  (await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings')).status === 404 && 'Kepler Plus is not mounted';
const noPlus = noPlusApp;

let view;
after(async () => view && view.browser.close());

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'chaski', 'kepler', 'plus', 'business-charts', 'gps', 'seismic']);
  // Links that reload the dashboard stay on this one.
  assert.doesNotMatch(JSON.stringify(dashboard), /\/d\/geosismos-gnss[?$]/);
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
  assert.equal(sql.length > 0, true);
  assert.equal(sql.some((q) => /INSTALL/.test(q)), false);
  const names = findAll(dashboard, (n) => n.datasource && n.kind === 'DataQuery').map((n) => n.datasource.name);
  assert.ok(names.every((name) => ['duckdb', 'duckdbwasm', '-- Grafana --'].includes(name)));
});

test('the map arrows measure the time brush', () => {
  const brush = panelsByType(dashboard, 'ubica-timebrush-panel')[0];
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  // The brush is drawn a bar a day over the daily file, and steps by days.
  assert.equal(brush.vizConfig.spec.options.bucket, '1d');
  // A window set from outside, a click on an earthquake, brings the brush's axis to it.
  assert.equal(brush.vizConfig.spec.options.zoomToExternal, true);
  const [bars] = findAll(brush, (n) => typeof n.rawSql === 'string');
  assert.equal(bars.datasource?.name ?? brush.data.spec.queries[0].spec.query.datasource.name, 'duckdb');
  assert.match(bars.rawSql, /positions\.parquet/);
  // The arrows, the table and the figures read the brush's days ($brush), not $spark's buckets,
  // which count from the epoch so the cards and the latitude-time map put a day on its midnight.
  const edges = findAll(dashboard.spec.elements, (n) => typeof n.rawSql === 'string' && n.rawSql.includes('ends AS ('));
  assert.equal(edges.length, 9);
  assert.ok(edges.every((q) => q.rawSql.includes('FROM $brush') && !q.rawSql.includes('$spark')));
  assert.match(serverSql('brush'), /try_cast\(\$t0 AS TIMESTAMP\)/);
  assert.match(serverSql('spark'), /time_bucket\(to_days\(s\.days\), p\.day, TIMESTAMP '1970-01-01'\)/);
  const arrows = mapConfig.visState.layers.filter((l) => l.type === 'symbol');
  assert.deepEqual(arrows.map((l) => l.config.dataId).sort(), ['grafana-F', 'grafana-G', 'grafana-I']);
  // A click on an earthquake on the timeline moves the brush, not the window.
  const [timeline] = panelsByType(dashboard, 'volkovlabs-echarts-panel').filter((p) => p.title.startsWith('Pick the window'));
  const clickCode = timeline.vizConfig.spec.options.getOption;
  assert.match(clickCode, /'var-t0': new Date\(t0\)\.toISOString\(\)/);
  assert.match(clickCode, /setBrush\(ms - AROUND_DAYS \* DAY, ms \+ AROUND_DAYS \* DAY, at\)/);
  // ... and flies the map to it: the map centres on qlat/qlon, which the click writes.
  assert.ok(map.vizConfig.spec.options.variableMappings.some((m) => m.source === 'center' && m.variable === 'qlat' && m.variableTo === 'qlon'));
  assert.match(clickCode, /\['var-' \+ LAT_VAR\]/);
  // The earthquakes on the map are the brush's too, not the whole window's.
  const [quakeSql] = findAll(map, (n) => typeof n.rawSql === 'string' && n.rawSql.includes('FROM $quakes')).map((n) => n.rawSql);
  assert.match(quakeSql, /\$t0/);
  assert.match(quakeSql, /\$t1/);
});

test('a brush of one day measures that day: two days a station, a path of at most about 60 points', { skip: unbuilt }, async () => {
  const brushSql = (t0, t1) => serverSql('brush').replaceAll('$t0', `'${t0}'`).replaceAll('$t1', `'${t1}'`);
  const day = await duckdb(STACK_URL, brushSql('2025-03-01T00:00:00.000Z', '2025-03-02T00:00:00.000Z'));
  assert.ok(new Set(day.map((r) => r.id)).size > 80, 'stations with a position on 1 and 2 March 2025');
  assert.ok(day.every((r) => Number(r.days) === 2 && Number(r.steps) <= 2));
  const years = await duckdb(STACK_URL, brushSql('2021-10-12T00:00:00.000Z', '2026-09-08T00:00:00.000Z'));
  const perStation = Object.values(Object.groupBy(years, (r) => r.id)).map((rows) => rows.length);
  assert.ok(Math.max(...perStation) <= 61, `at most ${Math.max(...perStation)} path points a station`);
});

test('every chart shows the brush and takes part in the shared crosshair', () => {
  const charts = panelsByType(dashboard, 'volkovlabs-echarts-panel');
  assert.equal(charts.length, 4);
  for (const chart of charts) {
    const code = chart.vizConfig.spec.options.getOption;
    assert.match(code, /'\$\{t0\}'/, chart.title);
    assert.match(code, /type: 'data-hover'/, chart.title);
    assert.match(code, /getStream\(\{ type: 'data-hover' \}\)/, chart.title);
  }
});

test('the network query returns every station, and the largest 2025–2026 shift is centimetres', async () => {
  const rows = await duckdb(STACK_URL, serverSql('shifts'));
  assert.equal(rows.length, 158);
  assert.ok(rows.every((r) => r.latitude < -17 && r.latitude > -56 && r.longitude < -67 && r.longitude > -110));
  const moved = rows.filter((r) => r.horizontal_m != null);
  // Trying the ends a few days inward is what lifts this above the ~54 that
  // have a position on exactly the first and the last day.
  assert.ok(moved.length > 70, `${moved.length} stations with a shift`);
  const max = Math.max(...moved.map((r) => r.horizontal_m));
  assert.ok(max > 0.05 && max < 0.2, `largest shift ${max} m`);
  assert.ok(moved.every((r) => r.coverage >= 0 && r.coverage <= 1));
  assert.ok(new Date(rows[0].published) >= new Date('2026-09-20'));
});

test('the paths read only the built file, in at most about 120 buckets a station', { skip: unbuilt }, async () => {
  const sql = serverSql('spark');
  assert.deepEqual([...new Set(sql.match(/https?:\/\/[^'"\s]+/g))], [FILE]);
  const rows = await duckdb(STACK_URL, sql);
  const ids = new Set(rows.map((r) => r.id));
  assert.ok(ids.size > 120, `${ids.size} stations`);
  const per = Math.max(...[...ids].map((id) => rows.filter((r) => r.id === id).length));
  assert.ok(per <= 121, `${per} buckets for one station`);
  // The build drops PORT's unflagged run of metres-off days in June 2026.
  const port = rows.filter((r) => r.id === 'PORT' && r.east_mm != null);
  assert.ok(port.length && Math.max(...port.map((r) => Math.abs(r.east_mm))) < 300);
});

test('ANTC has a daily series in millimetres from its first good day', async () => {
  const rows = await duckdb(STACK_URL, seriesSql);
  assert.ok(rows.length > 400, `${rows.length} days`);
  assert.equal(new Date(rows[0].time).toISOString().slice(0, 10), '2025-01-01');
  const good = rows.find((r) => r.out_e === 0 && r.east_mm != null);
  assert.equal(good.east_mm, 0);
  const last = rows.filter((r) => r.out_n === 0 && r.north_mm != null).at(-1);
  assert.ok(Math.abs(last.north_mm) > 5 && Math.abs(last.north_mm) < 100, `north ${last.north_mm} mm`);
});

test('loads for an anonymous visitor with no panel in error', { skip: noPlus }, async () => {
  const datasets = ['shifts', 'quakes', 'plates', 'avail', ...(unbuilt ? [] : ['spark'])];
  view = await openDashboard(`/d/${UID}`, { datasets, timeoutMs: 90_000 });
  assert.ok(view.loadMs <= 90_000, `took ${view.loadMs} ms`);
  assert.equal(await view.panelErrors(), 0);
  // Over the brush, which opens on the whole window.
  const stations = await view.statNumber('Stations with a shift');
  assert.ok(stations > 70 && stations <= 158, `${stations} stations`);
  // The title carries the station: the chart was drawn for the default one.
  await view.panel('Daily position of ANTC · millimetres from its first day in the window');
  assert.equal(await view.panelErrors(), 0);
});
