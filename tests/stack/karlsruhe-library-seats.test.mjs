// The karlsruhe-library-seats dashboard: the free seats of 16 reading rooms and libraries of
// Karlsruhe from the KIT Library's Seatfinder, through the gateway's /kit-seatfinder/ route, on a
// Kepler Plus map with Floors (each room on its floor of its building, OpenStreetMap outlines).
// It needs Kepler Plus: without it, the provisioning and browser tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'karlsruhe-library-seats';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
const sqlOf = (panel, refId) => panel.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
// As Grafana sends them: the datasource quotes a variable, the time range in epoch ms included.
const NOW = Date.now();
const bound = (sql, to = NOW, from = to - 12 * 3600e3) =>
  sql.replaceAll('${__from}', `'${from}'`).replaceAll('${__to}', `'${to}'`).replaceAll('$room', "''");
const IN_KARLSRUHE = (r) => r.latitude > 48.99 && r.latitude < 49.1 && r.longitude > 8.38 && r.longitude < 8.44;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['buildings', 'business-charts', 'duckdb', 'kepler', 'live', 'plus']);
  for (const panel of [map, brush]) {
    for (const q of panel.data.spec.queries) assert.equal(q.spec.query.datasource.name, 'duckdb');
  }
  const floors = map.vizConfig.spec.options.floors;
  assert.equal(floors.enabled, true);
  assert.deepEqual(floors.badge, { agg: 'sum', field: 'free', label: 'free seats' });
  assert.deepEqual(floors.queryFloors, { G: 'facade' });
  assert.equal(floors.selectVariable, 'room');
  // Every read of the Seatfinder goes through the gateway's cache, never to the source.
  assert.ok(!JSON.stringify(dashboard).includes('seatfinder.bibliothek.kit.edu/karlsruhe/getdata'));
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('every room has its place and floor, and the open ones a sane count', { timeout: 120_000 }, async () => {
  const rooms = await duckdb(STACK_URL, bound(sqlOf(map, 'A')));
  assert.equal(rooms.length, 16);
  for (const r of rooms) {
    assert.ok(IN_KARLSRUHE(r), JSON.stringify(r));
    assert.match(r.level, /^-?\d+(;-?\d+)*$/);
    if (r.seats !== null) {
      assert.ok(r.free >= 0 && r.free <= r.seats && r.seats > 0 && r.seats < 400, JSON.stringify(r));
      assert.ok(r.pct_taken >= 0 && r.pct_taken <= 100, JSON.stringify(r));
    }
  }
  // KIT Library South is open day and night, and estimated every 5 minutes: its six rooms are always counted.
  const south = rooms.filter((r) => r.building === 'KIT-S');
  assert.equal(south.length, 6);
  assert.ok(south.every((r) => r.source === 'estimate'), JSON.stringify(south));
});

test('each room stands inside its building, and the floors and shells are its outline', { timeout: 120_000 }, async () => {
  const slabs = await duckdb(STACK_URL, sqlOf(map, 'C'));
  const facades = await duckdb(STACK_URL, sqlOf(map, 'G'));
  assert.equal(facades.length, 12);
  assert.ok(slabs.length >= 20);
  for (const f of facades) assert.ok(f.height_m >= 3 && f.height_m <= 60, JSON.stringify(f));
  // The rooms' points against the outlines, in the server's spatial extension.
  const roomsCte = sqlOf(map, 'A').match(/rooms\(code[\s\S]*?\n\)/)[0];
  const outlines = sqlOf(map, 'G').match(/footprints\(building[\s\S]*?\n\)/)[0];
  const outside = await duckdb(
    STACK_URL,
    `WITH ${roomsCte}, ${outlines}
     SELECT r.code FROM rooms r
     WHERE NOT EXISTS (SELECT 1 FROM footprints f WHERE f.building = r.building
                       AND ST_Contains(ST_GeomFromGeoJSON(f.geometry), ST_Point(r.longitude, r.latitude)))`
  );
  assert.deepEqual(outside, []);
});

test('the week hour by hour, and the day against the usual', { timeout: 180_000 }, async () => {
  const week = await duckdb(STACK_URL, bound(sqlOf(brush, 'A')));
  assert.ok(week.length >= 7 * 24, `${week.length} hours`);
  const peak = Math.max(...week.map((h) => h['Seats taken']));
  assert.ok(peak > 300 && peak < 2000, `peak ${peak} seats taken`);
  const [day] = panelsByType(dashboard, 'volkovlabs-echarts-panel');
  const rows = await duckdb(STACK_URL, bound(sqlOf(day, 'A')));
  const kinds = new Set(rows.map((r) => r.day_kind));
  assert.ok(kinds.has('Weekday') && kinds.has('Weekend'), [...kinds].join());
  for (const r of rows) assert.ok(r.hour >= 0 && r.hour < 24 && r.pct >= 0 && r.pct <= 100, JSON.stringify(r));
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('Karlsruhe libraries: free seats floor by floor');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
