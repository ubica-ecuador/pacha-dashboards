// The nuclear-power dashboard: every nuclear power reactor in the world, entering service and shutting
// down year by year (GeoNuclearData, from the IAEA's PRIS), and the electricity they made by country
// (Our World in Data). Its two Chaski datasets read datasets/nuclear-power/*.parquet on the server.
// Without those files, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'nuclear-power';
const FEEDS = 'http://feeds/datasets/nuclear-power';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const sql = (name) => dataset(name).source.query.rawSql;
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/reactors.parquet`]) === '200';
// The window a panel reads, as the time brush writes it, for the SQL run on the server.
const inWindow = (s, lo, hi) =>
  s.replaceAll('$t_lo', `'${lo}T00:00:00.000Z'`).replaceAll('$t_hi', `'${hi}T00:00:00.000Z'`).replaceAll('$country', "''");

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['business-charts', 'chaski', 'duckdb', 'energy', 'kepler', 'plus']);
  for (const name of ['reactors', 'generation']) {
    assert.equal(dataset(name).source.type, 'datasource');
    assert.equal(dataset(name).source.datasource.uid, 'duckdb');
    assert.deepEqual(sql(name).match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${name}.parquet'`]);
  }
  // The time brush writes the window (t_lo, t_hi) by whole years over 1954 to 2024, floating at the
  // bottom of the screen; every panel but the chart of the electricity reads it.
  const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
  const b = brush.vizConfig.spec.options;
  assert.deepEqual([b.variables, b.bucket, b.domain, b.pinned, b.pinnedPosition],
    [{ from: 't_lo', to: 't_hi' }, '1y', 'dashboard', 'always', 'floating']);
  assert.deepEqual([dashboard.spec.timeSettings.from, dashboard.spec.timeSettings.to], ['1954-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z']);
  // The map: one layer per state at the window's end, each its own query on the window.
  const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
  const sqls = map.data.spec.queries.map((q) => q.spec.query.spec.rawSql);
  assert.equal(sqls.length, 5);
  for (const s of sqls) assert.match(s, /try_cast\(\$t_lo AS TIMESTAMP\).*try_cast\(\$t_hi AS TIMESTAMP\)/s);
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => l.config.dataId), ['grafana-B', 'grafana-C', 'grafana-A', 'grafana-E', 'grafana-D']);
  // The ranking picks a country, which the cards, the map and the time brush follow.
  const charts = panelsByType(dashboard, 'volkovlabs-echarts-panel');
  const ranking = charts.find((p) => /const VAR = 'country'/.test(p.vizConfig.spec.options.getOption));
  assert.match(ranking.vizConfig.spec.options.getOption, /\$\{country\}/);
  for (const s of [...sqls, brush.data.spec.queries[0].spec.query.spec.rawSql]) assert.match(s, /\$country = '' OR country = \$country/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('seventy years of reactors and their electricity', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nuclear-power on this instance: run its build.sh');
  const [all] = await duckdb(STACK_URL, `WITH r AS (${sql('reactors')}) SELECT count(*) AS n, count(started) AS dated,
    strftime(min(started), '%Y') AS first, count(*) FILTER (WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180) AS off_earth,
    count(*) FILTER (WHERE shut_down < started) AS backwards, count(*) FILTER (WHERE status = 'Under Construction') AS building FROM r`);
  assert.deepEqual([all.n, all.dated, all.first, all.off_earth, all.backwards, all.building].map(String), ['759', '639', '1954', '0', '0', '59']);
  // The cards on two windows: 2023, the default, and 1986, when Chernobyl-4 was the one shut down.
  const card = async (title, lo, hi) => {
    const [panel] = panelsByType(dashboard, 'stat').filter((p) => p.title === title);
    const s = panel.data.spec.queries[0].spec.query.spec.rawSql.replaceAll('$reactors', `(${sql('reactors')}) AS reactors`);
    return Number(Object.values((await duckdb(STACK_URL, inWindow(s, lo, hi)))[0])[0]);
  };
  assert.equal(await card('Reactors in service', '2023-01-01', '2024-01-01'), 435);
  assert.equal(Math.round(await card('Gigawatts in service', '2023-01-01', '2024-01-01')), 380);
  assert.equal(await card('Shut down in the window', '2023-01-01', '2024-01-01'), 5);
  assert.equal(await card('Shut down in the window', '1986-01-01', '1987-01-01'), 1);
  // The decades of the boom, and China since 2000.
  const [boom] = await duckdb(STACK_URL, `WITH r AS (${sql('reactors')}) SELECT
    count(*) FILTER (WHERE year(started) BETWEEN 1980 AND 1989) AS eighties, count(*) FILTER (WHERE year(started) BETWEEN 1990 AND 1999) AS nineties,
    count(*) FILTER (WHERE started >= '2000-01-01') AS since2000, count(*) FILTER (WHERE started >= '2000-01-01' AND country = 'China') AS china FROM r`);
  assert.deepEqual([boom.eighties, boom.nineties, boom.since2000, boom.china].map(String), ['228', '53', '120', '52']);
  // The electricity: Japan after Fukushima, Germany out, the World's record and its falling share.
  const twh = async (country, year) => {
    const [row] = await duckdb(STACK_URL, `WITH g AS (${sql('generation')}) SELECT round(twh) AS twh, share FROM g WHERE country = '${country}' AND "year" = ${year}`);
    return row;
  };
  assert.equal(Number((await twh('Japan', 2010)).twh), 292);
  assert.equal(Number((await twh('Japan', 2014)).twh), 0);
  assert.equal(Number((await twh('Germany', 2024)).twh), 0);
  assert.ok(Number((await twh('World', 2025)).twh) > 2800);
  // Its share of the World's electricity has about halved since its peak in 1996.
  assert.ok(Number((await twh('World', 1996)).share) > 1.9 * Number((await twh('World', 2025)).share));
});

test('opens with every panel drawn', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/nuclear-power on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['reactors', 'generation'], timeoutMs: 180_000 });
  view.page.setDefaultTimeout(180_000);
  try {
    await view.page.waitForFunction(() => /Reactors in service\s+435/.test(document.body.innerText), null, { polling: 500 });
    for (const title of ["Who has the power: GW in service at the window's end", 'The electricity they made, 1965 to 2025']) {
      await (await view.panel(title)).locator('canvas').first().waitFor();
    }
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
