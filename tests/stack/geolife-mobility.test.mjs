// The geolife-mobility dashboard: GeoLife's GPS trajectories, cleaned and
// analysed by datasets/geolife/build.sh into Parquet that the gateway serves to
// Grafana's DuckDB only, then read as Chaski datasets. The datasets' SQL runs
// here as Grafana runs it, with the dashboard's variables filled in. On a stack
// where the files were never built, the data tests are skipped; the map needs
// Kepler Plus (compose.plus.yaml), and without it the browser tests are too.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api, duckdb } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const dashboard = loadDashboard('dashboards/geolife-mobility.json');
const DATASETS = ['cleaning', 'sampling', 'trips', 'speed', 'speeds', 'stops', 'flows', 'trip_fixes'];

const datasetSql = (name) => {
  const [query] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name);
  return query.source.query.rawSql;
};
const fill = (sql, { mode = 'all', cell = '2000', minTrips = '20', trip = '48891' } = {}) =>
  sql
    .replaceAll('${mode:sqlstring}', `'${mode}'`)
    .replaceAll('${cell:raw}', cell)
    .replaceAll('${min_trips:raw}', minTrips)
    .replaceAll('${trip:sqlstring}', `'${trip}'`);
const status = (url) =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url]).trim();

const built = status('http://feeds/datasets/geolife/cleaning.parquet') === '200';
const unbuilt = !built && 'GeoLife is not built on this stack (datasets/geolife/build.sh)';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'geolife-mobility');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'plus', 'business-charts', 'mobility', 'gps']);
});

test('every dataset reads the built files through the gateway, and nothing else does', () => {
  for (const name of DATASETS) {
    const urls = datasetSql(name).match(/(?:https?:)?\/\/[^'\s)]+/g) ?? [];
    assert.ok(urls.length > 0, `${name} reads nothing`);
    for (const url of urls) assert.match(url, /^http:\/\/feeds\/datasets\/geolife\/[a-z_]+\.parquet$/, `${name}: ${url}`);
  }
  const panels = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) => p.spec.data.spec.queries);
  for (const q of panels) assert.equal(q.spec.query.datasource.name, 'duckdbwasm');
});

test('the gateway serves the files to Grafana only, and nothing but Parquet', { skip: unbuilt }, async () => {
  assert.equal(status('http://feeds/datasets/geolife/build.sql'), '404');
  assert.equal(status('http://feeds/datasets/geolife/.gitignore'), '404');
  const outside = await fetch(new URL('/datasets/geolife/trips.parquet', STACK_URL));
  assert.equal(outside.status, 404);
});

test('the cleaning: every file read, nearly every fix kept, about 50,000 trips', { skip: unbuilt }, async () => {
  const steps = await duckdb(STACK_URL, datasetSql('cleaning'));
  assert.equal(steps.length, 6);
  assert.equal(Number(steps[0].fixes), 24876978);
  assert.equal(Number(steps[0].trips), 18670);
  const kept = Number(steps[4].fixes) / Number(steps[0].fixes);
  assert.ok(kept > 0.95 && kept < 1, `kept ${kept}`);
  assert.ok(Number(steps[4].trips) > 45000 && Number(steps[4].trips) < 55000, `trips ${steps[4].trips}`);
  const [trips] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS n, count(*) FILTER (beijing)::INTEGER AS beijing, count(DISTINCT uid)::INTEGER AS people
     FROM (${datasetSql('trips')})`,
  );
  assert.equal(trips.n, Number(steps[4].trips));
  assert.equal(trips.beijing, Number(steps[5].trips));
  assert.equal(trips.people, 181);
});

test('speeds: walking is slower than the car, and Beijing has thousands of cells', { skip: unbuilt }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `WITH s AS (${datasetSql('speeds')})
     SELECT sum(kmh * fixes) FILTER (mode = 'walk') / sum(fixes) FILTER (mode = 'walk') AS walk,
            sum(kmh * fixes) FILTER (mode = 'car') / sum(fixes) FILTER (mode = 'car') AS car,
            (SELECT count(*) FROM (${datasetSql('speed')}) WHERE mode = 'all')::INTEGER AS cells
     FROM s`,
  );
  assert.ok(row.walk > 2 && row.walk < 8, `walking ${row.walk} km/h`);
  assert.ok(row.car > 20, `car ${row.car} km/h`);
  assert.ok(row.cells > 5000, `${row.cells} cells`);
});

test('flows: links between distinct places, none under the fewest trips picked', { skip: unbuilt }, async () => {
  const links = await duckdb(STACK_URL, fill(datasetSql('flows')));
  assert.ok(links.length > 100, `${links.length} links`);
  for (const l of links) {
    assert.ok(l.trips >= 20, JSON.stringify(l));
    assert.ok(l.lat0 !== l.lat1 || l.lng0 !== l.lng1, JSON.stringify(l));
    assert.ok(l.place0 && l.place1, JSON.stringify(l));
  }
  const walking = await duckdb(STACK_URL, fill(datasetSql('flows'), { mode: 'walk', cell: '500', minTrips: '5' }));
  assert.ok(walking.length > 0 && walking.length < links.length, `${walking.length} walking links`);
});

test('the trip followed by default: one row group, labelled bus and walk', { skip: unbuilt }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS fixes, array_to_string(list_sort(list(DISTINCT mode)), ',') AS modes FROM (${fill(datasetSql('trip_fixes'))})`,
  );
  assert.equal(row.fixes, 1619);
  assert.ok(row.modes.includes('bus') && row.modes.includes('walk'), String(row.modes));
});

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/geolife-mobility', { anonymous: true });
// Plus dashboards are provisioned here whether or not Kepler Plus is mounted.
const noPlusApp =
  (await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings')).status === 404 && 'Kepler Plus is not mounted';
const skip = unbuilt || (noPlusApp);

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('loads for an anonymous visitor within 45 s, every tab with no panel in error', { skip }, async () => {
  view = await openDashboard('/d/geolife-mobility', { datasets: DATASETS });
  assert.ok(view.loadMs <= 45_000, `took ${view.loadMs} ms`);
  for (const tab of ['1 · Cleaning', '2 · Speed & stops', '3 · Generalized flows', '4 · One trip up close']) {
    await view.page.getByRole('tab', { name: tab }).click();
    await view.page.waitForTimeout(3000);
    assert.equal(await view.panelErrors(), 0, tab);
  }
});
