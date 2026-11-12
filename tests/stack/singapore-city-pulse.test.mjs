// The singapore-city-pulse dashboard: Singapore's free taxis, rain gauges, HDB car parks and heat
// stress, live from data.gov.sg through the gateway's /datagovsg/ routes, with a week of them hour
// by hour in Chaski (three server datasets joined in the browser) under a Kepler Plus map and a
// time brush. The figures are checked against what the city is known to have: about 13,000 taxis
// (so a few thousand free at once), some 85 rain gauges, about 2,000 HDB car parks with 700,000
// car lots, all inside Singapore.
// These tests need the internet (data.gov.sg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'singapore-city-pulse';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const datasets = Object.fromEntries(findAll(dashboard, (n) => n.kind === 'dataset').map((d) => [d.name, d]));
const serverSql = (name) => datasets[name].source.query.rawSql;
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
const allSql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql);
// Singapore with its islands, generously.
const INSIDE = (lat, lng) => `${lat} BETWEEN 1.15 AND 1.48 AND ${lng} BETWEEN 103.6 AND 104.1`;

// A server dataset's SET statements, then its query into a temp table: the week as the browser gets it.
const intoTable = (sql, table) => {
  const at = sql.indexOf('\nWITH');
  return `${sql.slice(0, at)}\nCREATE OR REPLACE TEMP TABLE ${table} AS${sql.slice(at)};\n`;
};

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['business-charts', 'chaski', 'duckdb', 'kepler', 'live', 'mobility', 'plus', 'weather']);
  assert.deepEqual(Object.keys(datasets), ['sgRain', 'sgTaxisOld', 'sgTaxisNew', 'sgSteps']);
  for (const name of ['sgRain', 'sgTaxisOld', 'sgTaxisNew']) assert.equal(datasets[name].source.datasource.uid, 'duckdb');
  // data.gov.sg only through the gateway's cache.
  for (const sql of [...allSql, ...['sgRain', 'sgTaxisOld', 'sgTaxisNew'].map(serverSql)]) {
    for (const url of sql.match(/'[a-z]+:\/\/[^']*'/g) ?? []) assert.match(url, /^'http:\/\/feeds\/datagovsg\//, url);
  }
  // The brush writes the window; the map reads it and writes nothing back.
  assert.deepEqual(brush.vizConfig.spec.options.variables, { from: 't0', to: 't1' });
  assert.ok(!map.vizConfig.spec.options.variableMappings?.length);
  const layers = map.vizConfig.spec.options.mapConfig.config.visState.layers;
  assert.deepEqual(layers.map((l) => [l.id, l.type, l.config.dataId]), [
    ['taxis', 'point', 'grafana-B'], ['gauges', 'point', 'grafana-A'], ['carparks', 'point', 'grafana-C'], ['rain', 'surface', 'grafana-A'],
  ]);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the week: 168 hours of some 85 gauges in Singapore, a few thousand free taxis, holidays apart', { timeout: 180_000 }, async () => {
  const steps = datasets.sgSteps.source.sql.replace(/\$sgTaxisOld/g, 't_old').replace(/\$sgTaxisNew/g, 't_new').replace(/\$sgRain/g, 't_rain');
  const [row] = await duckdb(STACK_URL, `${intoTable(serverSql('sgRain'), 't_rain')}${intoTable(serverSql('sgTaxisOld'), 't_old')}${intoTable(serverSql('sgTaxisNew'), 't_new')}
    CREATE OR REPLACE TEMP TABLE t_steps AS ${steps};
    SELECT count(DISTINCT time)::DOUBLE AS hours, count(DISTINCT station)::DOUBLE AS gauges,
           epoch_ms(max(time))::DOUBLE AS last,
           count(*) FILTER (WHERE NOT (${INSIDE('latitude', 'longitude')}))::DOUBLE AS outside,
           min(island)::DOUBLE AS fewest, max(island)::DOUBLE AS most,
           (sum(rain_hour) / count(DISTINCT station))::DOUBLE AS week_mm,
           max(rain_hour)::DOUBLE AS wettest_hour,
           count(*) FILTER (WHERE usual IS NULL)::DOUBLE AS no_usual, count(*)::DOUBLE AS n,
           count(DISTINCT day_kind)::DOUBLE AS day_kinds,
           count(DISTINCT CAST(time + INTERVAL 8 HOUR AS DATE)) FILTER (WHERE day_kind = 'Weekend or holiday')::DOUBLE AS rest_days
    FROM t_steps`);
  assert.equal(row.hours, 168);
  assert.ok(row.gauges >= 70 && row.gauges <= 100, `${row.gauges} gauges`);
  assert.equal(row.outside, 0);
  // Ending at the last whole hour.
  assert.ok(Date.now() - row.last < 2 * 3_600_000, new Date(row.last).toISOString());
  assert.ok(row.fewest > 300 && row.most < 6000, `${row.fewest} to ${row.most} free taxis`);
  // Singapore gets about 2,100 to 2,500 mm a year: a week is tens of mm, a month's worth at most.
  assert.ok(row.week_mm >= 0 && row.week_mm < 400, `${row.week_mm} mm a gauge`);
  assert.ok(row.wettest_hour < 200, `${row.wettest_hour} mm in an hour`);
  assert.ok(row.no_usual / row.n < 0.05, `${row.no_usual} of ${row.n} without a usual`);
  assert.equal(row.day_kinds, 2);
  assert.ok(row.rest_days >= 2, `${row.rest_days} weekend or holiday days`);
});

test('the latest snapshots: free taxis, car parks and heat stress, all fresh and in Singapore', { timeout: 120_000 }, async () => {
  const sqlOf = (title) => dashboard.spec.elements[Object.keys(dashboard.spec.elements).find((k) => dashboard.spec.elements[k].spec.title === title)]
    .spec.data.spec.queries[0].spec.query.spec.rawSql;
  const [taxis] = await duckdb(STACK_URL, sqlOf('Free taxis'));
  assert.ok(taxis['Free taxis'] > 300 && taxis['Free taxis'] < 6000, `${taxis['Free taxis']} free taxis`);
  assert.ok(Date.now() - taxis.Snapshot < 15 * 60_000, new Date(taxis.Snapshot).toISOString());
  const [lots] = await duckdb(STACK_URL, sqlOf('Car lots free'));
  assert.ok(lots.Lots > 500_000 && lots.Lots < 900_000, `${lots.Lots} car lots`);
  assert.ok(lots['Car lots free'] > 0.1 && lots['Car lots free'] < 0.95, `${lots['Car lots free']} free`);
  const [heat] = await duckdb(STACK_URL, sqlOf('Heat stress'));
  assert.ok(heat.WBGT > 18 && heat.WBGT < 40, `${heat.WBGT} °C WBGT`);
  // The map's car parks and taxis, now (the brush's end empty).
  const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql.replace(/\$t[01]\b/g, "''");
  const [parks] = await duckdb(STACK_URL, `SELECT count(*)::DOUBLE AS n, count(*) FILTER (WHERE NOT (${INSIDE('latitude', 'longitude')}))::DOUBLE AS outside,
    count(*) FILTER (WHERE free_pct NOT BETWEEN 0 AND 100)::DOUBLE AS bad FROM (${mapSql('C').replace(/\nORDER BY free_pct$/, '')})`);
  assert.ok(parks.n > 1500 && parks.n < 2500, `${parks.n} car parks`);
  assert.equal(parks.outside, 0);
  assert.equal(parks.bad, 0);
  const [cabs] = await duckdb(STACK_URL, `SELECT count(*)::DOUBLE AS n, count(*) FILTER (WHERE NOT (${INSIDE('latitude', 'longitude')}))::DOUBLE AS outside FROM (${mapSql('B')})`);
  assert.ok(cabs.n > 300 && cabs.n < 6000, `${cabs.n} taxis on the map`);
  assert.ok(cabs.outside / cabs.n < 0.01, `${cabs.outside} taxis outside`);
});

test('a past snapshot comes from the gateway cache', { timeout: 120_000 }, () => {
  // Yesterday at noon, Singapore time.
  const noon = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds/datagovsg/taxis/${noon}T12:00:00`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('opens with every panel drawn and no error', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['sgRain', 'sgTaxisOld', 'sgTaxisNew', 'sgSteps'], timeoutMs: 180_000 });
  try {
    const free = await view.statNumber('Free taxis');
    assert.ok(free > 300 && free < 6000, `${free} free taxis`);
    await view.panel('Free taxis through the day');
    await view.panel('About the data');
    assert.equal(await view.panelErrors(), 0);
    const [steps] = await view.chaski('SELECT count(*) AS n, count(DISTINCT time) AS hours FROM datasets.sgSteps');
    assert.equal(Number(steps.hours), 168);
  } finally {
    await view.browser.close();
  }
});
