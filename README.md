# Pacha dashboards

The dashboards of the [live gallery](https://pacha.ubica.dev) that are not part of
[Pacha](https://github.com/ubica-ecuador/pacha) itself, with what each one needs from the
stack: its gateway routes and the datasets an instance builds for it. Pacha is the stack
(Grafana, DuckDB, Chaski, Kepler, the gateway); this repo is content for it.

> Not affiliated with Grafana Labs.

## Running them

Clone this repo beside Pacha and add the overlay that mounts it:

```sh
git clone https://github.com/ubica-ecuador/pacha
git clone https://github.com/ubica-ecuador/pacha-dashboards
cd pacha
# in .env
DASHBOARDS_DIR=../pacha-dashboards
COMPOSE_FILE=compose.yaml:compose.dashboards.yaml   # add compose.plus.yaml for the Plus ones
docker compose up --wait
```

The dashboards appear in the folder **Pacha dashboards**. Those tagged `plus` need
[Kepler Geospatial Maps Plus](https://docs.ubica.dev/plus/) (Pacha's `compose.plus.yaml`); the
rest run on the free stack.

## What is here

| Path | What | Reaches the stack |
|------|------|-------------------|
| `dashboards/<uid>.json` | one file per dashboard, in Grafana's format | Git Sync, within a minute of a push (or a save, locally) |
| `gateway/<feed>.conf.template` | `location` blocks of the gateway's `feeds` server | when the gateway starts |
| `gateway/http/<feed>.conf.template` | what those need at `http` level: `proxy_cache_path`, `map`, `limit_req_zone`, throttle servers | when the gateway starts |
| `datasets/<name>/build.sh` | data an instance builds for itself, served at `http://feeds/datasets/<name>/...` | when the script is run |
| `recorder/feeds/<feed>.sql` | a live feed the recorder keeps, served at `http://feeds/recordings/<feed>/` | when the recorder starts |
| `screenshots/<uid>.jpg` | the dashboard's card on Pacha's home page, a 16:9 crop of its map about 700 × 394 | served by the gateway at `/home/screenshots/`, after Pacha's own |
| `tests/stack/<uid>.test.mjs` | a handful of tests per dashboard, on Pacha's helpers | `npm run test:stack` |
| `grafana/repositories/` | the Git Sync repository that syncs `dashboards/` | Pacha mounts it |

Keys a route needs are `FEED_*` variables in Pacha's `.env`, written into the route by the
gateway at start (`${FEED_SOMETHING}` in the template). Never in a dashboard or its SQL.

## Tests

```sh
# Pacha's tests/lib, from ../pacha, with its node_modules (npm ci there once)
STACK_URL=http://127.0.0.1:3000 npm run test:stack
```

## Licence

Apache 2.0, like Pacha. Each dashboard's data keeps its own licence, named in the dashboard.
