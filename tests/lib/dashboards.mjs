// Pacha's dashboard helpers, reading this repo's files. Everything else is in
// ./pacha.mjs.
import { readFileSync } from 'node:fs';

export { findAll, datasetSql, panelsByType, panelTitled } from '../../../pacha/tests/lib/dashboards.mjs';

// loadDashboard('dashboards/<uid>.json'), relative to this repo's root.
export function loadDashboard(relativePath) {
  return JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}
