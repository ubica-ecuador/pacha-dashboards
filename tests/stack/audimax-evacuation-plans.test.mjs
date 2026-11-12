// The audimax-evacuation-plans dashboard: Universität Hamburg's Audimax on a Kepler Plus map
// with Floors, drawn from the three evacuation plans photographed on its walls, each aligned on
// the map and its rooms traced over it; the people and the CO2 in the rooms are simulated in the
// SQL itself. It needs Kepler Plus: without it, the tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'audimax-evacuation-plans';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
const [brush] = panelsByType(dashboard, 'ubica-timebrush-panel');
const sqlOf = (panel) => panel.data.spec.queries[0].spec.query.spec.rawSql;
const FROM = Date.parse(dashboard.spec.timeSettings.from);
const windowed = (sql, from = FROM) => sql.replaceAll('${__from}', String(from)).replaceAll('${__to}', String(from + 900_000));

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const plus = await api(STACK_URL, '/api/plugins/ubica-keplerplus-app/settings');
const skip = plus.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['air-quality', 'buildings', 'duckdb', 'kepler', 'plus']);
  for (const panel of [map, brush]) assert.equal(panel.data.spec.queries[0].spec.query.datasource.name, 'duckdb');
  const floors = map.vizConfig.spec.options.floors;
  // A plan per floor, carried in the dashboard (within Plus's upload limit), placed by its points.
  assert.deepEqual(Object.keys(floors.plans).sort(), ['0', '1', '2']);
  for (const [id, plan] of Object.entries(floors.plans)) {
    assert.match(plan, /^data:image\/jpeg;base64,/);
    assert.ok(plan.length * 0.75 < 1_000_000, `plan ${id}: ${plan.length} characters`);
    assert.ok(floors.planPoints[id].length >= 3, `plan ${id}: ${floors.planPoints[id].length} points`);
    assert.ok(floors.planRooms[id].length > 0, `plan ${id}: no rooms`);
  }
  assert.deepEqual(floors.planRoomsData, { refId: 'E', field: 'room' });
});

test('is provisioned in Pacha dashboards', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'dashboards');
});

test('every room traced on a plan has its reading each quarter, in a sane range', { timeout: 120_000 }, async () => {
  const rooms = await duckdb(STACK_URL, windowed(sqlOf(map)));
  const traced = Object.values(map.vizConfig.spec.options.floors.planRooms).flat().map((r) => r.name);
  assert.equal(rooms.length, 18);
  for (const row of rooms) {
    assert.ok(row.co2_ppm >= 400 && row.co2_ppm < 2500, JSON.stringify(row));
    assert.ok(row.latitude > 53.56 && row.latitude < 53.57 && row.longitude > 9.98 && row.longitude < 9.99, JSON.stringify(row));
    assert.match(row.occupancy, /^(empty|[\d,]+ people)$/);
  }
  const named = new Set(rooms.map((r) => r.room));
  assert.ok(traced.filter((name) => named.has(name)).length >= 15, 'the readings name the traced rooms');
  const day = await duckdb(STACK_URL, sqlOf(brush));
  assert.equal(day.length, 52);
  assert.ok(Math.max(...day.map((q) => q.people)) > 1000, 'a full hall');
});

test('opens with no panel in error', { skip, timeout: 240_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { chaski: false, timeoutMs: 180_000 });
  try {
    await view.panel('Audimax, Universität Hamburg: indoor air (simulated readings)');
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
