// The trimet-live-fleet dashboard, opened as an anonymous visitor. Its data is
// TriMet's live feed, so the checks are about shape, not numbers. It needs
// Kepler Plus (compose.plus.yaml) and a TriMet AppID (TRIMET_APP_ID in .env):
// without either, the tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/pacha.mjs';
import { api } from '../lib/pacha.mjs';
import { loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const DATASETS = ['vehicles', 'trips', 'tripstops', 'alerts', 'alert_routes', 'alert_stops', 'routes', 'stops'];

// Only one Chromium alive at a time, as in earthquakes.test.mjs. Auto refresh
// off: a reload every 30 s would keep the panels loading.
let current;
const open = async (query = '') => {
  if (current) await current.browser.close();
  current = await openDashboard(`/d/trimet-live-fleet?refresh=${query}`, { datasets: DATASETS, timeoutMs: 90_000 });
  return current;
};
after(async () => current && current.browser.close());

const provisioned = await api(STACK_URL, '/api/dashboards/uid/trimet-live-fleet');
// Plus dashboards are provisioned here whether or not Kepler Plus is mounted.
const noPlusApp =
  (await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings')).status === 404 && 'Kepler Plus is not mounted';
const keyed = compose(['exec', '-T', 'gateway', 'printenv', 'TRIMET_APP_ID']).trim() !== '';
const skip = (noPlusApp) || (!keyed && 'TRIMET_APP_ID is not set');

test('carries no AppID: the gateway adds it', () => {
  assert.doesNotMatch(JSON.stringify(loadDashboard('dashboards/trimet-live-fleet.json')), /appid=/i);
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('loads every dataset for an anonymous visitor, with no panel in error', { skip }, async () => {
  const view = await open();
  assert.equal(await view.panelErrors(), 0);
  const [counts] = await view.chaski(
    `SELECT (SELECT count(*) FROM datasets.vehicles)::INTEGER AS vehicles,
            (SELECT count(*) FROM datasets.trips)::INTEGER AS trips,
            (SELECT count(*) FROM datasets.tripstops)::INTEGER AS tripstops,
            (SELECT count(*) FROM datasets.routes)::INTEGER AS routes,
            (SELECT count(*) FROM datasets.stops)::INTEGER AS stops`,
  );
  assert.ok(counts.vehicles > 10, JSON.stringify(counts));
  assert.ok(counts.trips > 10, JSON.stringify(counts));
  assert.ok(counts.tripstops > counts.trips, JSON.stringify(counts));
  assert.ok(counts.routes > 50, JSON.stringify(counts));
  assert.ok(counts.stops > 1000, JSON.stringify(counts));
});

test('every vehicle gets a 3D model by its kind', { skip }, async () => {
  const view = current ?? (await open());
  const types = (await view.chaski('SELECT DISTINCT type FROM datasets.vehicles ORDER BY 1')).map((r) => r.type);
  assert.ok(types.includes('bus'), types.join());
  assert.ok(types.every((t) => ['bus', 'light rail', 'commuter rail', 'streetcar', 'aerial tram'].includes(t)), types.join());
});

test('a vehicle in the URL lists its next stops', { skip }, async () => {
  let view = current ?? (await open());
  // One running a trip with stops ahead in the feed.
  const [{ vehicle }] = await view.chaski(
    `SELECT v.vehicle FROM datasets.vehicles v JOIN datasets.tripstops u USING (trip)
     GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1 LIMIT 1`,
  );
  view = await open(`&var-vehicle=${vehicle}`);
  // The table's own rows, not view.panel(): that waits for every panel on the
  // page, and the 3D maps take their time in a browser without a GPU.
  const table = view.page
    .locator('[data-testid="data-testid Panel header Next stops of the selected vehicle"]')
    .locator('xpath=ancestor::*[@data-viz-panel-key][1]');
  await table.getByRole('row').nth(3).waitFor({ timeout: 60_000 });
  assert.doesNotMatch(await table.innerText(), /Click a vehicle on the map/);
});
