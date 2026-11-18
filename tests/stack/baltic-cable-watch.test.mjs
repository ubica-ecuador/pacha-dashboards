// The baltic-cable-watch dashboard and its alert rule: Digitraffic's AIS live
// through the gateway, the cables and their fences from datasets/baltic-cables
// (built on each instance), the rule provisioned from
// provisioning/alerting/baltic-cable-watch.yaml. The server reads ships, cables
// and alerts into three Chaski datasets; every panel filters them in the
// browser. Ships come and go, so the checks are about shape and ranges, not
// counts. The dashboard needs Kepler Plus (compose.plus.yaml): without it, its
// browser tests are skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, duckdb } from '../lib/pacha.mjs';
import { findAll, loadDashboard } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/pacha.mjs';
import { openDashboard } from '../lib/pacha.mjs';

const UID = 'baltic-cable-watch';
const DATASETS = ['ships', 'lingering', 'cables'];
const dashboard = loadDashboard(`dashboards/${UID}.json`);
const panelQueries = findAll(dashboard, (n) => n.kind === 'Panel').flatMap((p) =>
  p.spec.data.spec.queries.map((q) => ({ title: p.spec.title, ref: q.spec.refId, query: q.spec.query })),
);
const serverSql = (name) => findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name)[0].source.query.rawSql;
const CABLES = "'http://feeds/datasets/baltic-cables/cables.parquet'";
const HISTORY = 'Alerts over the last 24 hours';
const historySql = panelQueries.find((q) => q.title === HISTORY).query.spec.rawSql;
const browserQueries = panelQueries.filter((q) => q.title !== HISTORY);
const ruleFile = readFileSync(new URL(`../../grafana/alerting/${UID}.yaml`, import.meta.url), 'utf8');

let view;
after(async () => view && view.browser.close());

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['chaski', 'duckdb', 'kepler', 'plus', 'maritime', 'network', 'energy', 'alerting', 'live']);
  // The server fills the datasets; every panel reads them in the browser.
  for (const name of DATASETS) {
    const [source] = findAll(dashboard, (n) => n.kind === 'dataset' && n.name === name).map((n) => n.source);
    assert.equal(source.datasource.uid, 'duckdb', name);
  }
  // Every panel but the alert history, which the server reads from Grafana's own API.
  for (const { title, query } of browserQueries) assert.equal(query.datasource.name, 'duckdbwasm', title);
  assert.equal(panelQueries.find((q) => q.title === HISTORY).query.datasource.name, 'duckdb');
});

test('reads every source through the gateway only', () => {
  for (const name of ['ships', 'cables']) assert.match(serverSql(name), /http:\/\/feeds\//, name);
  for (const text of [JSON.stringify(dashboard), ruleFile]) {
    assert.doesNotMatch(text, /meri\.digitraffic\.fi|submarinecablemap\.com\/api|ows\.emodnet|overpass/);
  }
});

test('has no apostrophe in a comment of a browser query, where Chaski would read a quote', () => {
  for (const { title, ref, query } of browserQueries) {
    for (const line of query.spec.rawSql.split('\n')) {
      const comment = line.split('--')[1];
      assert.ok(comment === undefined || !comment.includes("'"), `${title} ${ref}: ${line}`);
    }
  }
});

test('the cables: telecom, power and gas, each named once, with a fence', async () => {
  const rows = await duckdb(STACK_URL, `SELECT cable, kind, km, ST_GeometryType(fence) AS fence FROM ${CABLES}`);
  assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ['gas', 'power', 'telecom']);
  assert.equal(new Set(rows.map((r) => r.cable)).size, rows.length, 'a cable name is an alert label: unique');
  const km = Object.fromEntries(rows.map((r) => [r.cable, r.km]));
  // Known lengths at sea: Estlink 2 about 145 km, Balticconnector 77 km offshore, C-Lion1 about 1,170 km.
  assert.ok(km['HVDC Estlink 2'] > 130 && km['HVDC Estlink 2'] < 170, km['HVDC Estlink 2']);
  assert.ok(km.Balticconnector > 70 && km.Balticconnector < 110, km.Balticconnector);
  assert.ok(km['C-Lion1'] > 1000 && km['C-Lion1'] < 1300, km['C-Lion1']);
  const fenced = rows.filter((r) => /POLYGON/.test(r.fence));
  assert.ok(fenced.length >= rows.length - 10, `${fenced.length} of ${rows.length} fenced`);
});

test('the ships are live and in the waters Digitraffic hears', async () => {
  const rows = await duckdb(STACK_URL, serverSql('ships'));
  assert.ok(rows.length > 100, `${rows.length} ships`);
  for (const r of rows) {
    assert.ok(r.latitude > 53 && r.latitude < 67 && r.longitude > 9 && r.longitude < 33, JSON.stringify(r));
    assert.equal(typeof r.mmsi, 'string', 'mmsi as text: the alert label it is matched with');
    assert.ok(r.knots === null || (r.knots >= 0 && r.knots < 102.3), JSON.stringify(r));
  }
  const newest = Math.max(...rows.map((r) => Number(new Date(r.time))));
  assert.ok(Date.now() - newest < 10 * 60_000, `newest position ${new Date(newest).toISOString()}`);
  for (const r of rows.filter((r) => r.watch === 'Lingering')) assert.match(r.type, /^(Cargo|Tanker)$/, JSON.stringify(r));
  for (const r of rows) assert.match(r.alert, /^(Alert|Watching|No alert)$/, JSON.stringify(r));
  // An alert only on a ship the rule watches.
  for (const r of rows.filter((r) => r.alert !== 'No alert')) assert.match(r.type, /^(Cargo|Tanker)$/, JSON.stringify(r));
});

test('every server query runs: the datasets and the rule', async () => {
  for (const name of DATASETS) await assert.doesNotReject(duckdb(STACK_URL, serverSql(name)), name);
  const lingering = await duckdb(STACK_URL, serverSql('lingering'));
  for (const r of lingering) assert.match(r.alert, /^(Alert|Watching|Clear|Not evaluated yet)$/, JSON.stringify(r));
});

test('the alert history counts the alerts minute by minute', async () => {
  const rows = await duckdb(STACK_URL, historySql);
  // One row a minute over the range of the request (a few minutes from the test helper).
  assert.ok(rows.length > 0, `${rows.length} minutes`);
  for (const r of rows) assert.ok(r.firing >= 0 && r.pending >= 0 && r.firing + r.pending < 500, JSON.stringify(r));
});

test('the alert rule is provisioned, evaluates, and anyone can read its alerts', async () => {
  const rule = await api(STACK_URL, `/api/v1/provisioning/alert-rules/${UID}`);
  assert.equal(rule.status, 200);
  assert.equal(rule.json.for, '15m');
  assert.equal(rule.json.labels.watch, 'baltic-cables');
  assert.equal(rule.json.provenance, 'file');
  const rules = await api(STACK_URL, '/api/prometheus/grafana/api/v1/rules', { anonymous: true });
  assert.equal(rules.status, 200);
  const found = rules.json.data.groups.flatMap((g) => g.rules).find((r) => r.uid === UID);
  assert.ok(found, 'the rule is in the alerting API');
  assert.notEqual(found.health, 'error', found.lastError);
  for (const alert of found.alerts ?? []) {
    for (const label of ['mmsi', 'ship', 'cable', 'signature']) assert.ok(alert.labels[label], `${label} in ${JSON.stringify(alert.labels)}`);
  }
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('loads the datasets for an anonymous visitor, with no panel in error', { skip }, async () => {
  view = await openDashboard(`/d/${UID}?refresh=`, { datasets: DATASETS, timeoutMs: 90_000 });
  assert.equal(await view.panelErrors(), 0);
  const [{ ships }] = await view.chaski('SELECT count(*)::DOUBLE AS ships FROM datasets.ships');
  assert.ok(Number(ships) > 100, `${ships} ships in the browser`);
  assert.equal(await view.statNumber('Ships heard'), Number(ships));
});
