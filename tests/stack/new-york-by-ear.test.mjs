// The new-york-by-ear dashboard: what SONYC's 56 acoustic sensors in New York heard, 2016 to 2019, as
// volunteers tagged 18,510 recordings (SONYC-UST v2), by hour, month and block. Its two Chaski datasets
// read datasets/nyc-sounds/*.parquet on the server. Without those files, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'new-york-by-ear';
const FEEDS = 'http://feeds/datasets/nyc-sounds';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const sql = (name) => dataset(name).source.query.rawSql;
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/sounds.parquet`]) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['business-charts', 'chaski', 'city', 'duckdb', 'kepler', 'mosaic', 'plus']);
  for (const [name, file] of [['recordings', 'recordings'], ['sounds', 'sounds']]) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    assert.deepEqual(sql(name).match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${file}.parquet'`]);
  }
  // Time: a range filter over the hour each recording was made, set by Kepler Plus's time brush, which
  // floats at the bottom of the screen, plays it, and takes part in the Mosaic selection.
  const filters = findAll(dashboard, (n) => n.kind === 'filters' && n.refId === 'soundFilters')[0];
  assert.deepEqual(filters.filters.find((f) => f.name === 'time'), {
    as: 'time', column: 'time', from: '$t_lo', label: 'Months', name: 'time', to: '$t_hi', type: 'range', upper: 'closed',
  });
  const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
  const b = brush.vizConfig.spec.options;
  assert.deepEqual([b.variables, b.mosaicSelection, b.mosaicColumn, b.pinned, b.pinnedPosition],
    [{ from: 't_lo', to: 't_hi' }, 'soundFilters', 'time', 'always', 'floating']);
  assert.match(brush.data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$soundFilters, -time\)/);
  // The Kepler Plus map is re-queried under the filters (no Mosaic selection on it) for the picked
  // sound: blocks for the dots and the Surface, blocks by quarter for the Sparkline cards, which keep
  // the whole series (-time) and follow the crosshair of the Grafana time series.
  const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
  const sqls = map.data.spec.queries.map((q) => q.spec.query.spec.rawSql);
  for (const s of sqls) assert.match(s, /sound = \$mapSound AND \$__crossfilter\(\$soundFilters, -area[,)]/);
  assert.match(sqls[1], /\$__crossfilter\(\$soundFilters, -area, -time\)/);
  const options = map.vizConfig.spec.options;
  assert.equal(options.areaVariable, 'soundArea');
  const layers = options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => l.type), ['sparkline', 'point', 'surface']);
  assert.equal(layers[0].config.visConfig.sparkCrosshair, true);
  assert.equal(dashboard.spec.cursorSync, 'Crosshair');
  // The months: a native time series on the Chaski dataset, all months and the timeline's window.
  const [months] = panelsByType(dashboard, 'timeseries');
  assert.equal(months.data.spec.queries[0].spec.query.datasource.name, 'duckdbwasm');
  assert.match(months.data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$soundFilters, -time\)/);
  assert.equal(dashboard.spec.timeSettings.from, '2016-05-01T00:00:00.000Z');
  // The heatmap picks the sound for the map and the months: a click writes mapSound, never empty.
  const [heat] = panelsByType(dashboard, 'volkovlabs-echarts-panel');
  assert.match(heat.data.spec.queries[0].spec.query.spec.rawSql, /\$__crossfilter\(\$soundFilters\)/);
  const code = heat.vizConfig.spec.options.getOption;
  assert.match(code, /const VAR = 'mapSound'/);
  assert.match(code, /\$\{mapSound\}/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the sound keeps a timetable', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-sounds on this instance: run its build.sh');
  const [all] = await duckdb(STACK_URL, `WITH r AS (${sql('recordings')}) SELECT count(*) AS n, count(DISTINCT sensor_id) AS sensors,
    min("year") AS y0, max("year") AS y1, strftime(min("time"), '%Y-%m-%d') AS t0, strftime(max("time"), '%Y-%m-%d') AS t1,
    count(*) FILTER (WHERE strftime("time", '%a') <> "day") AS wrong_day FROM r`);
  assert.deepEqual([Number(all.n), Number(all.sensors), all.y0, all.y1], [18510, 56, '2016', '2019']);
  // The date rebuilt from year, week and day falls on the recording's day of the week, inside the range.
  assert.deepEqual([all.t0, all.t1, Number(all.wrong_day)], ['2016-05-07', '2019-12-29', 0]);
  const share = async (sound, where) => {
    const [row] = await duckdb(STACK_URL, `WITH s AS (${sql('sounds')}) SELECT 100 * avg(present) AS pct FROM s WHERE sound = '${sound}' AND ${where}`);
    return row.pct;
  };
  const day = 'hour BETWEEN 7 AND 17';
  const evening = 'hour BETWEEN 18 AND 22';
  const night = '(hour >= 23 OR hour <= 6)';
  assert.ok((await share('Jackhammers, drills', day)) > 3 * (await share('Jackhammers, drills', night)), 'jackhammers keep office hours');
  assert.ok((await share('Voices', evening)) > 2 * (await share('Voices', night)), 'voices belong to the evening');
  assert.ok((await share('Engines', night)) > (await share('Engines', day)) + 5, 'engines take the night');
  for (const part of [day, evening, night]) {
    const pct = await share('Sirens, horns, alarms', part);
    assert.ok(pct > 10 && pct < 25, `sirens at every hour: ${pct}`);
  }
  // And a calendar: music comes with summer, dogs with winter.
  assert.ok((await share('Music', 'quarter("time") = 3')) > 2 * (await share('Music', 'quarter("time") = 1')), 'music comes with summer');
  const winter = 'month("time") IN (12, 1, 2)';
  const summer = 'month("time") IN (6, 7, 8)';
  assert.ok((await share('Dogs', winter)) > 2 * (await share('Dogs', summer)), 'dogs with winter');
});

test('opens with every panel drawn', { timeout: 400_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nyc-sounds on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['recordings', 'sounds'], timeoutMs: 180_000 });
  view.page.setDefaultTimeout(240_000);
  try {
    await view.page.waitForFunction(() => /18,510 of 18,510 recordings/.test(document.body.innerText), null, { polling: 500 });
    const card = (await (await view.panel('Recordings heard')).innerText()).replace(/\D/g, '');
    assert.equal(card, '18510');
    for (const title of ['Recordings by hour', 'Every year, the same city']) {
      await (await view.panel(title)).locator('svg').first().waitFor();
    }
    await (await view.panel('What the sensors heard, hour by hour: click a sound to map it')).locator('canvas').first().waitFor();
    await (await view.panel('Music, month by month, across the city')).locator('.u-over').waitFor();
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
