// citibike-pulse: Citi Bike's stations on an average weekday or weekend day of a month (datasets/citibike): where
// the bikes leave from and pile up in the hours picked on a Mosaic chart, and the busiest links between H3 cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'citibike-pulse';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'kepler', 'mosaic', 'plus']);
  for (const name of ['stations', 'hourly', 'links']) {
    const ds = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
    assert.equal(ds.source.type, 'datasource', name);
    assert.equal(ds.source.datasource.uid, 'duckdb', name);
    assert.match(ds.source.query.rawSql, /http:\/\/feeds\/datasets\/citibike\//, name);
  }
  // the hours brush writes the two variables the filters read
  assert.match(options('hours').variables, /column: hour\n {2}from: hFrom\n {2}to: hTo/);
  assert.equal(options('map').areaVariable, 'bikeArea');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('opens with no panel in error, and the trips are sane', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['stations', 'hourly', 'links'], timeoutMs: 180_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    // some 2,400 stations, all in or around New York
    const [s] = await view.chaski(`SELECT count(*) AS n, count(*) FILTER (WHERE latitude BETWEEN 40.5 AND 41
      AND longitude BETWEEN -74.3 AND -73.7) AS placed FROM datasets.stations`);
    assert.ok(Number(s.n) > 1500 && Number(s.n) < 4000, `stations ${s.n}`);
    assert.equal(Number(s.placed), Number(s.n));
    // an average weekday carries 100,000 to 300,000 trips, and every bike taken out is brought in somewhere
    const [d] = await view.chaski(`SELECT sum(bikes_out) AS o, sum(bikes_in) AS i FROM datasets.hourly WHERE day = 'Weekday'`);
    assert.ok(Number(d.o) > 100_000 && Number(d.o) < 300_000, `weekday trips ${d.o}`);
    assert.ok(Math.abs(Number(d.o) - Number(d.i)) / Number(d.o) < 0.01, JSON.stringify(d));
    // the morning rush: more trips start at 8 than at 3, and the morning moves more bikes out of place than the whole day
    const [r] = await view.chaski(`WITH b AS (SELECT name, sum(bikes_in - bikes_out) FILTER (WHERE hour BETWEEN 7 AND 9) AS am,
        sum(bikes_in - bikes_out) AS allday FROM datasets.hourly WHERE day = 'Weekday' GROUP BY name)
      SELECT sum(greatest(am, 0)) AS am, sum(greatest(allday, 0)) AS allday FROM b`);
    assert.ok(Number(r.am) > 2 * Number(r.allday), JSON.stringify(r));
    const [l] = await view.chaski(`SELECT count(*) AS n, count(DISTINCT hour) AS hours FROM datasets.links WHERE day = 'Weekday'`);
    assert.ok(Number(l.n) > 1000 && Number(l.hours) === 24, JSON.stringify(l));
  } finally {
    await view.browser.close();
  }
});
