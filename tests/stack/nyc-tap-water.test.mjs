// nyc-tap-water: New York's drinking water on its way through the mains, from DEP's sampling stations since 2015
// (datasets/nyc-tap-water): free chlorine, temperature and bacteria per sample, stations placed on the street map.
// A Chaski timeline, a temperature brush in Mosaic, the boroughs and a drawn area filter a kepler map and the figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'nyc-tap-water';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'city', 'kepler', 'mosaic', 'plus']);
  for (const name of ['samples', 'stations']) {
    const ds = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
    assert.equal(ds.source.type, 'datasource', name);
    assert.equal(ds.source.datasource.uid, 'duckdb', name);
    assert.match(ds.source.query.rawSql, /http:\/\/feeds\/datasets\/nyc-tap-water\//, name);
  }
  // the temperature brush writes the two variables the filters read
  assert.match(options('warm').variables, /column: temperature\n {2}from: temp_lo\n {2}to: temp_hi/);
  assert.equal(options('timeline').filters, 'waterFilters');
  assert.equal(options('map').areaVariable, 'waterArea');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('opens with no panel in error, and the samples are sane', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['samples', 'stations'], timeoutMs: 180_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    // some 20,000 samples a year at some 390 stations, nearly all of them placed
    const [s] = await view.chaski(`SELECT count(*) AS n, count(DISTINCT site) AS sites, min(t) AS first,
      median(chlorine) AS chlorine, median(temperature) AS temperature FROM datasets.samples`);
    assert.ok(Number(s.n) > 150_000, `samples ${s.n}`);
    assert.ok(Number(s.sites) > 350 && Number(s.sites) < 450, `sites ${s.sites}`);
    assert.ok(String(s.first).startsWith('2015') || Number(s.first) < Date.UTC(2015, 1, 1), `first ${s.first}`);
    // tap water carries about half a milligram of free chlorine per litre, and runs at 5 to 20 °C
    assert.ok(Number(s.chlorine) > 0.3 && Number(s.chlorine) < 0.9, `chlorine ${s.chlorine}`);
    assert.ok(Number(s.temperature) > 8 && Number(s.temperature) < 18, `temperature ${s.temperature}`);
    const [p] = await view.chaski(`SELECT count(*) FILTER (WHERE latitude BETWEEN 40.48 AND 40.93
      AND longitude BETWEEN -74.27 AND -73.68) AS placed, count(*) AS n FROM datasets.stations`);
    assert.ok(Number(p.placed) / Number(p.n) > 0.9, `placed ${p.placed} of ${p.n}`);
    // summer runs lower than winter: the share with almost none left is higher in July than in January
    const rows = await view.chaski(`SELECT m, avg(low) AS low FROM datasets.samples WHERE m IN (1, 7) GROUP BY m ORDER BY m`);
    assert.ok(Number(rows[1].low) > 2 * Number(rows[0].low), JSON.stringify(rows));
  } finally {
    await view.browser.close();
  }
});
