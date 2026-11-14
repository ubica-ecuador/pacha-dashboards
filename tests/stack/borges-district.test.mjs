// borges-district, step 3 of the Borges ladder: a district: Bullfrog, 1954, at 1:62,500, the railway grade abandoned and Bullfrog in ruins.
// The sheet over the satellite, the frame of the next map, its scale and sizes. See borges.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { built, conventions, duckdb, opens, provisioned, SHEETS, STACK_URL, theMap, tif } from './borges.mjs';

const UID = 'borges-district';
const SHEET = SHEETS[UID];

test('follows the dashboards conventions', () => {
  const dashboard = conventions(UID, ['cartography', 'chaski', 'duckdb', 'kepler', 'plus'], [['sheets', 'sheets.parquet']]);
  const [sheet, next] = theMap(dashboard).data.spec.queries.map((q) => q.spec.query.spec.rawSql);
  assert.match(sheet, new RegExp(`'http://feeds/datasets/borges/${SHEET.file}' AS raster_url`));
  assert.match(next, /AS geojson/);
  assert.match(next, /WHERE level = 'town'/);
});

test('is provisioned in Pacha dashboards', () => provisioned(UID));

test('the sheet, and the next inside it', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance: run its build.sh');
  const rows = await duckdb(STACK_URL, "SELECT * FROM 'http://feeds/datasets/borges/sheets.parquet' ORDER BY scale DESC");
  const i = rows.findIndex((r) => r.level === SHEET.level);
  const [me, next] = [rows[i], rows[i + 1]];
  assert.deepEqual([Number(me.year), Number(me.scale)], [SHEET.year, SHEET.scale]);
  // The next map lies inside this one and covers a quarter of it or less.
  assert.ok(next.west >= me.west && next.east <= me.east && next.south >= me.south && next.north <= me.north);
  assert.ok((next.east - next.west) * (next.north - next.south) <= ((me.east - me.west) * (me.north - me.south)) / 4 + 1e-9);
  // A sheet of paper a few tens of centimetres wide, as printed.
  assert.ok(me.paper_w_cm > 30 && me.paper_w_cm < 50 && me.paper_h_cm > 40 && me.paper_h_cm < 60);
  tif(SHEET.file, [-117.0, 36.75, -116.75, 37.0]);
});

test('opens with the sheet and its cards', { timeout: 240_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance');
  const view = await opens(UID);
  try {
    await view.page.waitForFunction((scale) => document.body.innerText.includes(scale), SHEET.card, { polling: 500 });
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
