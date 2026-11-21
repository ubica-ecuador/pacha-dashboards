// mercator-true-size: map projections, and how much larger than life Mercator draws every country. Natural Earth's
// countries are read and measured in the browser (Chaski, spatial): the real area on the ellipsoid against the area
// on a Web Mercator map. A Mosaic panel draws them in the projection a menu picks, with Tissot's circles; a ranking,
// a latitude chart and a kepler web map share one selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';

const UID = 'mercator-true-size';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const el = (name) => dashboard.spec.elements[name].spec;
const options = (name) => el(name).vizConfig.spec.options;

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'kepler', 'mosaic', 'plus']);
  for (const name of ['countries', 'tissot', 'curve']) {
    const ds = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
    assert.equal(ds.source.type, 'sql', name);
  }
  // the projection is a param the menu writes
  assert.match(options('world').spec, /input: menu\n {8}label: Projection\n {8}as: \$proj/);
  assert.match(options('world').spec, /projectionType: \$proj/);
  // toggleY binds to the mark just before it: the bars, not their labels
  assert.match(options('ranking').spec, /- mark: barX\n(?: {4}.*\n)+ {2}- select: toggleY/);
  assert.equal(options('ranking').spec.match(/yDomain: \[(.*)\]/)[1].split("', '").length, 30);
  assert.match(options('ranking').variables, /column: name\n {2}variable: country/);
  assert.match(options('latitude').variables, /column: lat\n {2}from: lat_lo\n {2}to: lat_hi/);
  // the web map follows the same selection
  assert.equal(options('webmap').mosaicSelection, 'pick');
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('opens with no panel in error, and the areas are right', { timeout: 300_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['countries', 'tissot', 'curve'], timeoutMs: 150_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
    const rows = await view.chaski(`SELECT name, km2, inflation, rank FROM datasets.countries
      WHERE name IN ('Greenland', 'Ecuador', 'Russia')`);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    // Greenland is 2.17 million km², Russia 17.1 and Ecuador 0.26 (with its islands)
    assert.ok(Math.abs(Number(by.Greenland.km2) - 2.17e6) < 0.05e6, `Greenland ${by.Greenland.km2}`);
    assert.ok(Math.abs(Number(by.Russia.km2) - 17.1e6) < 0.3e6, `Russia ${by.Russia.km2}`);
    assert.ok(Math.abs(Number(by.Ecuador.km2) - 0.256e6) < 0.01e6, `Ecuador ${by.Ecuador.km2}`);
    // Mercator: Greenland some 16 times too large and first of the ranking, Ecuador on the equator true to size
    assert.ok(Number(by.Greenland.inflation) > 14 && Number(by.Greenland.inflation) < 19, by.Greenland.inflation);
    assert.equal(Number(by.Greenland.rank), 1);
    assert.ok(Number(by.Ecuador.inflation) < 1.05, by.Ecuador.inflation);
    const [{ n }] = await view.chaski('SELECT count(*) AS n FROM datasets.tissot');
    assert.equal(Number(n), 84);
  } finally {
    await view.browser.close();
  }
});
