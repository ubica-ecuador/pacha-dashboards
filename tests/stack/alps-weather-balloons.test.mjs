// alps-weather-balloons: a week of radiosondes from six launch sites round the Alps (SondeHub's archive, read once
// by datasets/alps-radiosondes/build.sh), each flight on a Kepler Plus map as a Route at its own heights over the
// relief with its track on the ground, its profile under the map, and its height, temperature and wind on charts
// that share the crosshair. It needs Kepler Plus and the built files: without them, the tests that need them skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'alps-weather-balloons';
const FEEDS = 'http://feeds/datasets/alps-radiosondes';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
const sqlOf = (v) => v.query.spec.__legacyStringValue;

const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const noPlus = plus.status === 404 && 'Kepler Plus is not mounted';
const built = await duckdb(STACK_URL, `SELECT count(*) AS n FROM '${FEEDS}/flights.parquet'`).then(
  () => true,
  () => false,
);
const notBuilt = !built && 'datasets/alps-radiosondes/build.sh has not been run';
// A variable's query as Grafana sends it, for a site and a time range.
const bound = (sql, { site = '06610', flight = 'W4140299', from, to }) =>
  sql
    .replaceAll('${site:raw}', site)
    .replaceAll('${flight:raw}', flight)
    .replaceAll('$__timeFrom()', `TIMESTAMPTZ '${from}'`)
    .replaceAll('$__timeTo()', `TIMESTAMPTZ '${to}'`);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'plus', 'weather']);
  assert.equal(dashboard.spec.cursorSync, 'Crosshair'); // the route's profile and the charts share the moment
  // Every query reads the dataset's files, nothing else, and quotes a variable itself (:raw).
  const sql = findAll(dashboard, (n) => typeof n?.rawSql === 'string' || typeof n?.__legacyStringValue === 'string').map(
    (n) => n.rawSql ?? n.__legacyStringValue,
  );
  assert.ok(sql.length >= 10);
  for (const s of sql) {
    for (const url of s.match(/'[a-z]+:\/\/[^']+'/g) ?? []) assert.match(url, /^'http:\/\/feeds\/datasets\/alps-radiosondes\/\w+\.parquet'$/);
    assert.doesNotMatch(s, /'\$\{(flight|site)\}'/);
  }
  // The flight follows the site and the time range; the map re-centres on it through clat/clon, kept in the URL.
  assert.equal(variable('flight').hide, 'hideVariable');
  assert.equal(variable('flight').refresh, 'onTimeRangeChanged');
  assert.equal(variable('clat').skipUrlSync, false);
  assert.deepEqual(map.vizConfig.spec.options.variableMappings, [
    { field: '', source: 'center', variable: 'clat', variableTo: 'clon', zoom: 6.8 },
  ]);
  // The flight as a Route at its own heights, with the profile, and the same rows on the ground, without one.
  const layers = Object.fromEntries(map.vizConfig.spec.options.mapConfig.config.visState.layers.map((l) => [l.id, l]));
  assert.equal(layers.flight.type, 'route');
  assert.deepEqual(layers.flight.config.columns, { altitude: 'altitude', id: 'flight', lat: 'latitude', lng: 'longitude', sortBy: 'time' });
  assert.equal(layers.flight.config.visConfig.routeDrawAt, 'data');
  assert.equal(layers.flight.config.visConfig.routeHeights, 'data');
  assert.equal(layers.flight.config.visConfig.routeProfile, true);
  assert.equal(layers.track.type, 'route');
  assert.equal(layers.track.config.dataId, layers.flight.config.dataId);
  assert.equal(layers.track.config.visConfig.routeDrawAt, 'ground');
  assert.equal(layers.track.config.visConfig.routeProfile, false);
  // The table's links set the range, the site and the map's centre.
  const links = findAll(dashboard, (n) => typeof n?.url === 'string' && n.url.includes('var-site='));
  assert.equal(links.length, 1);
  assert.match(links[0].url, /from=\$\{__data\.fields\.from_ms\}&to=\$\{__data\.fields\.to_ms\}&var-site=.*&var-clat=.*&var-clon=/);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('the week of flights: six sites, sane heights, one frame a second', { skip: notBuilt, timeout: 60_000 }, async () => {
  const [f] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(DISTINCT site) AS sites, min(top_altitude) AS low,
      max(top_altitude) AS high, min(first_heard) AS t0, max(last_heard) AS t1 FROM '${FEEDS}/flights.parquet'`);
  assert.equal(Number(f.sites), 6);
  assert.ok(Number(f.n) > 60 && Number(f.n) < 90, `${f.n} flights`); // about eleven launches a day for a week
  assert.ok(f.low > 12000 && f.high < 40000, `tops ${f.low} to ${f.high} m`);
  // The magnitude check: Payerne's sounding of 12 UTC on 13 November crossed the Swiss Alps to East Tyrol,
  // 37.2 km up in a polar night jet of about 120 m/s.
  const [p] = await duckdb(STACK_URL, `SELECT top_altitude, path_km, strongest_wind FROM '${FEEDS}/flights.parquet' WHERE serial = 'W4140299'`);
  assert.ok(p.top_altitude > 37000 && p.top_altitude < 37500, `${p.top_altitude} m`);
  assert.ok(p.path_km > 400 && p.path_km < 480, `${p.path_km} km`);
  assert.ok(p.strongest_wind > 100 && p.strongest_wind < 130, `${p.strongest_wind} m/s`);
  // From launch to landing a frame a second: never two in the same second, no long silence, no glitched speed.
  const [g] = await duckdb(STACK_URL, `WITH s AS (SELECT epoch(time - lag(time) OVER w) AS dt, wind
      FROM '${FEEDS}/frames.parquet' WINDOW w AS (PARTITION BY serial ORDER BY frame))
    SELECT count(*) FILTER (WHERE dt <= 0) AS repeated, max(dt) AS gap, max(wind) AS wind FROM s`);
  assert.equal(Number(g.repeated), 0);
  assert.ok(g.gap <= 600, `a silence of ${g.gap} s`);
  assert.ok(g.wind <= 150, `${g.wind} m/s`);
});

test('the time range and the site pick the flight', { skip: notBuilt, timeout: 60_000 }, async () => {
  const pick = async (args) => (await duckdb(STACK_URL, bound(sqlOf(variable('flight')), args)))[0].__value;
  const sounding = { from: '2026-11-13T10:55:00Z', to: '2026-11-13T14:05:00Z' };
  assert.equal(await pick({ ...sounding, site: '06610' }), 'W4140299'); // the default: Payerne
  // Another site at the same hours gives its own flight of the same sounding; Innsbruck flies at 03 UTC only.
  const munich = await pick({ ...sounding, site: '10868' });
  assert.notEqual(munich, 'none');
  const [m] = await duckdb(STACK_URL, `SELECT site, first_heard FROM '${FEEDS}/flights.parquet' WHERE serial = '${munich}'`);
  assert.equal(m.site, '10868');
  assert.equal(await pick({ ...sounding, site: '11120' }), 'none');
  // The centre the map opens on lies just south of the flight.
  const [c] = await duckdb(STACK_URL, bound(sqlOf(variable('clat')), { flight: 'W4140299' }));
  assert.ok(c.v > 46 && c.v < 46.6, `clat ${c.v}`);
});

test('opens with its cards, its map and no panel in error', { skip: noPlus || notBuilt, timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 120_000 });
  const { page } = view;
  page.setDefaultTimeout(120_000);
  try {
    await page.waitForFunction(() => /37\.2 km at 13:23 UTC/.test(document.body.innerText), null, { polling: 500 });
    assert.match(await page.locator('body').innerText(), /119 m\/s \(429 km\/h\) at 36\.2 km/);
    assert.match(await page.locator('body').innerText(), /The flight at its heights: Payerne, Fri 13 Nov, 11:00 UTC/);
    await view.panel('The week\'s flights: pick one');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
