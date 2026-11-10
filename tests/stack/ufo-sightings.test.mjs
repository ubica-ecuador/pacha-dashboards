// The ufo-sightings dashboard: the reports to NUFORC, 1906 to 2014, built by Grafana Assistant from a
// prompt (#30DayMapChallenge 2026, day 10) and reviewed with SQL. Its Chaski dataset reads
// datasets/ufo-sightings/nuforc.parquet on the server and cleans it. Without that file, the data
// tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, compose, duckdb, openDashboard, STACK_URL } from '../lib/pacha.mjs';
import { findAll, loadDashboard, panelsByType } from '../lib/dashboards.mjs';

const UID = 'ufo-sightings';
const FILE = 'http://feeds/datasets/ufo-sightings/nuforc.parquet';
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const dataset = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === 'ufo')[0];
const sql = dataset.source.query.rawSql;
const built = () =>
  compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', FILE]) === '200';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'mosaic', 'plus']);
  assert.equal(dataset.source.type, 'datasource');
  assert.equal(dataset.source.datasource.uid, 'duckdb');
  assert.deepEqual(sql.match(/'[a-z]+:\/\/[^']+'/g), [`'${FILE}'`]);
  // It opens on the reports' own years: on the last 30 days the Chaski filters emptied every chart.
  const { from, to } = dashboard.spec.timeSettings;
  assert.ok(from.startsWith('1906') && to.startsWith('2014'), `${from} to ${to}`);
  assert.equal(panelsByType(dashboard, 'ubica-keplerplus-panel').length, 1);
});

test('is provisioned in Pacha dashboards', async () => {
  const { status, json } = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'dashboards');
});

test('July 4th is the top day of the year', { timeout: 120_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/ufo-sightings on this instance: run its build.sh');
  const [all] = await duckdb(STACK_URL, `WITH u AS (${sql}) SELECT count(*) AS n, min(year) AS y0, max(year) AS y1 FROM u`);
  assert.equal(Number(all.n), 80331);
  assert.ok(all.y0 === 1906 && all.y1 === 2014, `${all.y0} to ${all.y1}`);
  const days = await duckdb(STACK_URL, `WITH u AS (${sql}) SELECT strftime(time, '%m-%d') AS md, any_value(doy) AS doy, count(*) AS n
    FROM u GROUP BY 1 ORDER BY n DESC`);
  assert.equal(days[0].md, '07-04');
  assert.equal(days[0].doy, 186, 'day of year on a fixed calendar');
  const median = days.map((d) => Number(d.n)).sort((a, b) => a - b)[Math.floor(days.length / 2)];
  assert.ok(Number(days[0].n) > 5 * median, `${days[0].n} on July 4th, ${median} on a typical day`);
  const [peak] = await duckdb(STACK_URL, `WITH u AS (${sql}) SELECT hour, count(*) AS n FROM u GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  assert.equal(peak.hour, 21, 'the 9 pm hour, as the headline says');
});

test('opens with every panel drawn and stays filled', { timeout: 400_000 }, async (t) => {
  if (!built()) return t.skip('no datasets/ufo-sightings on this instance');
  const view = await openDashboard(`/d/${UID}`, { datasets: ['ufo'], timeoutMs: 180_000 });
  view.page.setDefaultTimeout(240_000);
  try {
    const count = async () => (await (await view.panel('Sightings in view')).innerText()).replace(/\D/g, '');
    await view.page.waitForFunction(() => /80,331 of 80,331 sightings/.test(document.body.innerText), null, { polling: 500 });
    assert.equal(await count(), '80331');
    await view.page.waitForTimeout(20_000);
    assert.equal(await count(), '80331', 'the card stays filled');
    for (const title of ['Sightings by year', 'Hour of day', 'Day of week', 'Day of year']) {
      await (await view.panel(title)).locator('svg').first().waitFor();
    }
    assert.equal(await view.panelErrors(), 0);
    assert.deepEqual(await view.page.getByTestId('mosaic-error').allInnerTexts(), []);
  } finally {
    await view.browser.close();
  }
});
