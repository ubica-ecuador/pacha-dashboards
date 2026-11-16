#!/bin/sh
# Builds what alps-weather-balloons draws: a week of weather balloons from six launch sites round the
# Alps (Payerne, München, Innsbruck, Udine, Novara and Cuneo), 8 to 14 November 2026, each flight from
# launch to landing as the amateur receivers of SondeHub heard it, one frame a second.
#
#   sites.parquet    the six sites, where SondeHub places them
#   flights.parquet  one row a flight: when it was first and last heard, how high it went and when,
#                    how far it drifted, its coldest air and its strongest wind, and at what height
#   frames.parquet   one row a second of each flight: time, place, height (GPS, metres), rise rate and
#                    horizontal speed (m/s, the balloon's own, so the wind's), heading and temperature
#
# The week does not change: run this once. About 80 downloads of a megabyte each from SondeHub's
# archive (history.sondehub.org, the files of the AWS Open Data bucket sondehub-history), not kept, and
# none from its API, which asks not to be polled. The gateway serves the files at
# http://feeds/datasets/alps-radiosondes/; nothing to restart.
#
# The data: SondeHub Radiosonde Telemetry (https://registry.opendata.aws/sondehub-telemetry),
# CC BY-SA 2.0, received by radiosonde_auto_rx and other stations run by amateurs; the sensors'
# readings are not calibrated. The sondes are launched by MeteoSwiss, the DWD, GeoSphere Austria,
# and the Aeronautica Militare.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.6

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case $(uname -m) in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No DuckDB CLI for $(uname -m)" >&2; exit 1 ;;
esac
echo "DuckDB $DUCKDB_VERSION ..."
curl -fsSL -o "$work/duckdb.zip" "https://github.com/duckdb/duckdb/releases/download/v$DUCKDB_VERSION/duckdb_cli-linux-$arch.zip"
unzip -q "$work/duckdb.zip" -d "$work"

echo "The week's flights from SondeHub's archive ..."
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")
mv "$work/sites.parquet" "$work/flights.parquet" "$work/frames.parquet" "$here/"
echo "Done: $(ls "$here"/*.parquet | tr '\n' ' ')"
