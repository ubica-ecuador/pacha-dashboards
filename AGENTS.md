# Pacha dashboards, for agents

Dashboards for [Pacha](https://github.com/ubica-ecuador/pacha), kept apart from the stack.
**This repo works only with a Pacha clone beside it** (`../pacha`): the stack, its rules and
the skill are there.

Read `../pacha/AGENTS.md` first: its rules hold here unchanged (preview before a push on a
GitHub-synced instance, never write into a synced folder by API, merge onto the latest save,
datasources by uid only, secrets only in `.env` through the gateway, no visual claim without a
screenshot, basic tests, commit only your own changes, ask before restarting shared services).
Then the skill, linked here as `.claude/skills/build-dashboard` (it lives in Pacha); its paths
such as `dashboards/gallery/<uid>.json` are Pacha's, the files to copy from.

## Where things go

New dashboards are made here, not in Pacha.

- **The dashboard:** `dashboards/<uid>.json`, flat. Git Sync puts it in the folder "Pacha
  dashboards" (uid `dashboards`). A Plus dashboard is tagged `plus`, like every Plus dashboard;
  the tag vocabulary is Pacha's `dashboards/README.md` (a new theme tag is a one-line change
  there).
- **A gateway route:** `gateway/<feed>.conf.template`, its `location` blocks only, as they would
  read in Pacha's `gateway/feeds.conf`; cache zones, `map`s and throttle servers in
  `gateway/http/<feed>.conf.template`. Name zones and paths after the feed: they share one
  nginx with Pacha's routes. A key is `${FEED_<NAME>}` in the template and `FEED_<NAME>` in
  Pacha's `.env`. Routes load only when the gateway starts: validate with
  `docker compose run --rm --no-deps -T gateway nginx -t` from Pacha, and ask before restarting
  the gateway.
- **A dataset:** `datasets/<name>/build.sh`, as in Pacha; the files it writes are git-ignored
  and served at `http://feeds/datasets/<name>/<file>.parquet` (and `.glb` to browsers), after
  Pacha's own datasets of the same name, so pick a name Pacha does not use.
- **Its card on the home page:** Pacha's home lists this folder's dashboards with the Gallery
  (and those tagged `plus` with Plus). Its picture is `screenshots/<uid>.jpg`, a 16:9 crop of
  the map about 700 × 394 (Pacha's `scripts/screenshots.mjs` takes one; move it here). Without
  one the card shows a plain background.
- **Tests:** `tests/stack/<uid>.test.mjs`. Import `loadDashboard` and the other dashboard
  helpers from `../lib/dashboards.mjs`, everything else (Grafana, DuckDB, the browser, the
  stack's URL) from `../lib/pacha.mjs`. Run with `npm run test:stack` (it sets
  `PACHA_DIR=../pacha`).

A change to the stack itself (an image, a plugin, a datasource, the gateway's own server)
belongs in Pacha.

**Your instance.** As in Pacha: facts about one deployment go in `CLAUDE.local.md`, git-ignored.
