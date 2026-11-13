// The who-visits-whom dashboard: animals seen visiting flowers, from Global Biotic Interactions (GloBI).
// Three Chaski datasets read datasets/pollinators/*.parquet on the server (the visits in numbers, the
// visitors' and the plants' names); a fourth joins them in the browser for the Mosaic panels and the
// Kepler Plus map, which share one crossfilter selection. Without those files, the data tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'who-visits-whom';
const FEEDS = 'http://feeds/datasets/pollinators';
const SELECTION = 'visitFilters';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const dataset = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0];
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${FEEDS}/visits.parquet`]) === '200';
// The browser's dataset, run on the server with the three it reads as subqueries.
const visits = () =>
  ['visitRows', 'visitorNames', 'plantNames'].reduce(
    (s, name) => s.replaceAll(`$${name}`, `(${dataset(name).source.query.rawSql})`),
    dataset('visits').source.sql,
  );

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'plus', 'wildlife']);
  for (const [name, file] of [['visitRows', 'visits'], ['visitorNames', 'visitors'], ['plantNames', 'plants']]) {
    const d = dataset(name);
    assert.equal(d.source.type, 'datasource');
    assert.equal(d.source.datasource.uid, 'duckdb');
    assert.deepEqual(d.source.query.rawSql.match(/'[a-z]+:\/\/[^']+'/g), [`'${FEEDS}/${file}.parquet'`]);
  }
  assert.equal(dataset('visits').source.type, 'sql');
  assert.doesNotMatch(dataset('visits').source.sql, /:\/\//);
  // Every Mosaic panel reads the joined dataset on the one selection; the map follows it, and the
  // Timeline plays the month filter of the filters variable named after it.
  const mosaics = panelsByType(dashboard, 'ubica-chaski-mosaic-panel');
  assert.equal(mosaics.length, 9);
  for (const p of mosaics) {
    const spec = p.vizConfig.spec.options.spec;
    assert.match(spec, new RegExp(`${SELECTION}: \\{ select: crossfilter \\}`));
    assert.match(spec, new RegExp(`from: visits, filterBy: \\$${SELECTION}`));
  }
  const [map] = panelsByType(dashboard, 'ubica-keplerplus-panel');
  const o = map.vizConfig.spec.options;
  assert.deepEqual([o.mosaicSelection, o.mosaicColumns, o.mosaicArea], [SELECTION, 'longitude, latitude', true]);
  // Every row of the dataset, birds and bats drawn last so the insects do not hide them.
  const mapSql = map.data.spec.queries[0].spec.query.spec.rawSql;
  assert.match(mapSql, /^FROM \$visits$/m);
  assert.match(mapSql, /ORDER BY visitor_group IN \('Birds', 'Bats'\)/);
  assert.equal(map.vizConfig.spec.options.mapConfig.config.uiState.mapControls.mapLegend.active, true);
  const [timeline] = panelsByType(dashboard, 'ubica-chaski-filters-panel');
  assert.deepEqual([timeline.vizConfig.spec.options.filters, timeline.vizConfig.spec.options.timeline], [SELECTION, 'month']);
  const [filters] = findAll(dashboard, (n) => n.kind === 'filters');
  assert.deepEqual(filters.filters.map((f) => [f.name, f.column, f.from, f.to]), [['month', 'month_mid', '$m_lo', '$m_hi']]);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('animals on flowers, named and placed', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/pollinators on this instance: run its build.sh');
  // GloBI's snapshot of 10 September 2026, read whole.
  const [all] = await duckdb(STACK_URL, `WITH v AS (${visits()}) SELECT count(*) AS n, sum(records) AS records,
    count(DISTINCT visitor) AS visitors, count(DISTINCT plant) AS plants, count(DISTINCT link) AS pairs, count(DISTINCT place) AS places,
    count(*) FILTER (WHERE visitor IS NULL OR plant IS NULL OR visitor_group IS NULL OR plant_family IS NULL) AS unnamed,
    count(*) FILTER (WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180) AS off_earth,
    count(*) FILTER (WHERE "month" NOT BETWEEN 1 AND 12) AS bad_month FROM v`);
  assert.deepEqual([all.n, all.records, all.visitors, all.plants, all.pairs, all.places, all.unnamed, all.off_earth, all.bad_month].map(String),
    ['528123', '1309430', '13845', '12072', '178611', '118264', '0', '0', '0']);
  // The groups the bars and the map are coloured by, and nothing else.
  const groups = (await duckdb(STACK_URL, `WITH v AS (${visits()}) SELECT DISTINCT visitor_group AS g FROM v ORDER BY g`)).map((r) => r.g);
  assert.deepEqual(groups, ['Bats', 'Bees', 'Beetles', 'Birds', 'Butterflies and moths', 'Hoverflies', 'Other flies', 'Other insects', 'Wasps and ants']);
  // The headline: the honey bee on the most plants, wild carrot with the most visitors.
  const [bee] = await duckdb(STACK_URL, `WITH v AS (${visits()}) SELECT visitor, count(DISTINCT plant) AS k FROM v GROUP BY 1 ORDER BY k DESC LIMIT 1`);
  assert.deepEqual([bee.visitor, String(bee.k)], ['Apis mellifera', '3520']);
  const [carrot] = await duckdb(STACK_URL, `WITH v AS (${visits()}) SELECT plant, count(DISTINCT visitor) AS k FROM v GROUP BY 1 ORDER BY k DESC LIMIT 1`);
  assert.deepEqual([carrot.plant, String(carrot.k)], ['Daucus carota', '1016']);
  // A date of 1 January is a year alone: January stays the north's quietest month, July its busiest.
  const months = await duckdb(STACK_URL, `WITH v AS (${visits()}) SELECT "month" AS m, count(DISTINCT place) AS n FROM v
    WHERE latitude > 23.44 AND "month" IS NOT NULL GROUP BY 1 ORDER BY n`);
  assert.equal(String(months.at(-1).m), '7');
  assert.ok(['1', '12'].includes(String(months[0].m)));
});

test('opens with every panel drawn', { timeout: 300_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/pollinators on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['visits'], timeoutMs: 180_000 });
  view.page.setDefaultTimeout(180_000);
  try {
    await view.page.waitForFunction(() => /Records\s+1,309,430/.test(document.body.innerText), null, { polling: 500 });
    for (const title of ['Who visits whom: the interaction matrix', 'The most visited plants', 'The visitors on the most plants']) {
      await (await view.panel(title)).locator('[data-testid="mosaic-panel"] svg rect').first().waitFor();
    }
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
