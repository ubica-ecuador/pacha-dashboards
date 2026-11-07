// The nyc-311-requests dashboard: four weeks of New York City's 311 service requests, read
// by the server from NYC Open Data through the gateway's /nyc311/ route into one Chaski
// dataset, with a free kepler map, Chaski filters and Mosaic charts on the same selection.
// The figures are checked against what the city is known to receive: about 3.5 million
// requests a year, some 10,000 a day, all inside the five boroughs.
// These tests need the internet (data.cityofnewyork.us).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'nyc-311-requests';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const dataset = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'requests')[0];
const [map] = panelsByType(dashboard, 'ubica-keplergl-panel');
const THEMES = ['Parking', 'Housing', 'Noise', 'Sanitation', 'Streets', 'Environment', 'Street life', 'Other'];

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'duckdb', 'kepler', 'mosaic']);
  assert.equal(dataset.source.type, 'datasource');
  assert.equal(dataset.source.datasource.uid, 'duckdb');
  // NYC Open Data only through the gateway's cache.
  for (const url of dataset.source.query.rawSql.match(/'[a-z]+:\/\/[^']+'/g)) assert.match(url, /^'http:\/\/feeds\/nyc311\//);
  // The filters write variables; a dataset reading one would reload on every move.
  for (const v of ['theme', 'borough', 'closed_in', 'agency', 'channel', 'requestFrom', 'requestTo', 'hour_lo', 'hour_hi', 'requestArea']) {
    assert.doesNotMatch(dataset.source.query.rawSql, new RegExp(`\\$${v}\\b`), v);
  }
  const options = map.vizConfig.spec.options;
  assert.equal(options.mosaicSelection, 'requestFilters');
  for (const q of map.data.spec.queries) assert.doesNotMatch(q.spec.query.spec.rawSql, /\$__crossfilter|\$requestFilters/);
  const [layer] = options.mapConfig.config.visState.layers;
  assert.deepEqual(layer.config.visConfig.colorRange.colorMap.map(([theme]) => theme), THEMES);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('four weeks of requests: about 10,000 a day, inside the five boroughs, in eight themes', { timeout: 180_000 }, async () => {
  // The dataset's SET statements first, then its query as the table measured.
  const sql = dataset.source.query.rawSql;
  const at = sql.indexOf('WITH r AS');
  const [row] = await duckdb(STACK_URL, `${sql.slice(0, at)}
    SELECT count(*)::DOUBLE AS n, epoch_ms(min(time))::DOUBLE AS first, epoch_ms(max(time))::DOUBLE AS last,
           count(*) FILTER (WHERE latitude IS NULL)::DOUBLE AS no_place,
           count(*) FILTER (WHERE latitude NOT BETWEEN 40.49 AND 40.92 OR longitude NOT BETWEEN -74.26 AND -73.69)::DOUBLE AS outside,
           count(DISTINCT theme)::DOUBLE AS themes,
           count(*) FILTER (WHERE theme NOT IN (${THEMES.map((t) => `'${t}'`).join(', ')}))::DOUBLE AS unknown_theme,
           count(*) FILTER (WHERE hours < 0)::DOUBLE AS negative_hours, count(DISTINCT day)::DOUBLE AS days
    FROM (${sql.slice(at)}) d`);
  const days = (row.last - row.first) / 86_400_000;
  assert.ok(days > 25 && days <= 28, `${days} days`);
  assert.ok(row.n / days > 7000 && row.n / days < 16000, `${row.n} requests, ${Math.round(row.n / days)} a day`);
  assert.ok(row.no_place / row.n < 0.05, `${row.no_place} without a place`);
  assert.equal(row.outside, 0);
  assert.equal(row.themes, 8);
  assert.equal(row.unknown_theme, 0);
  assert.equal(row.negative_hours, 0);
  assert.equal(row.days, 7);
  // The data trails the clock by about a day: no request from the future.
  assert.ok(row.last <= Date.now(), new Date(row.last).toISOString());
});

test('a second read of the requests comes from the gateway cache', { timeout: 180_000 }, () => {
  const day = new Date(Date.now() - 28 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds/nyc311/requests/${day}.csv`]);
  headers();
  assert.match(headers(), /X-Cache-Status: (HIT|UPDATING|STALE)/i);
});

test('opens with every panel drawn and no error', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['requests'], timeoutMs: 180_000 });
  try {
    const card = async (title) => (await (await view.panel(title)).innerText()).replace(title, '').trim();
    const requests = Number((await card('Requests')).replace(/\D/g, ''));
    assert.ok(requests > 200_000, `${requests} requests`);
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
