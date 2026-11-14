// borges-one-to-one, step 5 of the Borges ladder: the 1987 sheet laid at 1:1 over the town of Rhyolite and
// torn by the years, five by five from 1987, with the animals GBIF records in the town. The Time Brush writes
// t_lo and t_hi; the torn sheet, the animals and the cards follow its first year. See borges.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from '../lib/dashboards.mjs';
import { built, conventions, duckdb, load, opens, provisioned, STACK_URL, theMap, tif } from './borges.mjs';

const UID = 'borges-one-to-one';
const TOWN = [-116.845, 36.894, -116.813, 36.914];

test('follows the dashboards conventions', () => {
  const dashboard = conventions(UID, ['cartography', 'chaski', 'duckdb', 'kepler', 'plus', 'wildlife'],
    [['sheets', 'sheets.parquet'], ['stages', 'stages.parquet'], ['animals', 'animals.parquet']]);
  const [brush] = findAll(dashboard, (n) => n.vizConfig?.group === 'ubica-timebrush-panel');
  assert.equal(brush.vizConfig.spec.options.output, 'variables');
  const [sheet, animals] = theMap(dashboard).data.spec.queries.map((q) => q.spec.query.spec.rawSql);
  for (const sql of [sheet, animals]) assert.match(sql, /\$t_lo/);
  assert.match(sheet, /'http:\/\/feeds\/datasets\/borges\/' \|\| file AS raster_url FROM \$stages/);
  assert.match(animals, /WHERE year <= w\.y/);
});

test('is provisioned in Pacha dashboards', () => provisioned(UID));

test('the paper and the animals', { timeout: 60_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance: run its build.sh');
  // Eight stages of five years, back to back from 1987 to 2026, the paper going from whole to a fifth.
  const stages = await duckdb(STACK_URL, "SELECT * FROM 'http://feeds/datasets/borges/stages.parquet' ORDER BY stage");
  assert.equal(stages.length, 8);
  stages.forEach((s, k) => assert.deepEqual([Number(s.year_from), Number(s.year_to)], [1987 + 5 * k, 1991 + 5 * k]));
  assert.equal(Number(stages[0].paper_left), 1);
  for (let k = 1; k < 8; k++) assert.ok(Number(stages[k].paper_left) < Number(stages[k - 1].paper_left));
  assert.ok(Number(stages[7].paper_left) > 0.15 && Number(stages[7].paper_left) < 0.3);
  for (const s of stages) tif(s.file, TOWN);
  // The animals: in the town, with a year, under CC0 or CC BY 4.0 only.
  const [a] = await duckdb(STACK_URL, `SELECT count(*) AS n, count(DISTINCT animal) AS kinds, min(year) AS y0, max(year) AS y1,
      count(*) FILTER (WHERE latitude NOT BETWEEN ${TOWN[1]} AND ${TOWN[3]} OR longitude NOT BETWEEN ${TOWN[0]} AND ${TOWN[2]}) AS outside,
      count(*) FILTER (WHERE licence NOT IN ('CC0 1.0', 'CC BY 4.0') OR licence IS NULL) AS other_licence
    FROM 'http://feeds/datasets/borges/animals.parquet'`);
  assert.ok(Number(a.n) > 400 && Number(a.kinds) > 50, `${a.n} animals of ${a.kinds} kinds`);
  assert.deepEqual([Number(a.outside), Number(a.other_licence)], [0, 0]);
  assert.ok(Number(a.y1) <= new Date().getUTCFullYear());
});

test('opens torn, and whole in 1990', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/borges on this instance');
  for (const [query, year, paper] of [['', '2026', '22%'], ['?var-t_lo=1990-01-01T00:00:00.000Z&var-t_hi=1991-01-01T00:00:00.000Z', '1990', '100%']]) {
    const view = await opens(UID, query);
    try {
      await view.page.waitForFunction(([y, p]) => /The year\s+/.test(document.body.innerText) && document.body.innerText.includes(y)
        && document.body.innerText.replace(/\s+/g, '').includes(`Paperleft${p}`), [year, paper], { polling: 500 });
      assert.equal(await view.panelErrors(), 0);
    } finally {
      await view.browser.close();
    }
  }
});
