#!/bin/sh
# Builds what new-york-by-ear draws: what the SONYC acoustic sensors of New York heard, as tagged
# by volunteers (SONYC-UST v2, NYU, CC BY 4.0: zenodo.org/record/3966543). 18,510 recordings of
# ten seconds from 56 sensors in Manhattan, Brooklyn and Queens, 2016 to 2019, each placed at its
# city block and timed to the hour, each heard by three volunteers on Zooniverse:
#
#   recordings.parquet  one row per recording: the sensor, its block and borough, the hour it
#                       was recorded (time, rebuilt from SONYC's year, week, day of the week and
#                       hour, which are kept too), and the eight sound classes (engines,
#                       jackhammers and drills, other impacts, powered saws, sirens and horns,
#                       music, voices, dogs), each 1 when most of its volunteers tagged it
#   sounds.parquet      the same, one row per recording and sound class (present, 1 or 0)
#
# The recordings are not a random sample of the city's sound: SONYC chose them for resembling
# recordings known to hold sounds of interest, and kept at most one with a voice per sensor and
# hour. Shares are of the recordings the volunteers heard.
#
# One download of 15 MB (annotations.csv), not kept. The gateway serves the files at
# http://feeds/datasets/nyc-sounds/; nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
CSV=https://zenodo.org/api/records/3966543/files/annotations.csv/content

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

echo "SONYC-UST v2 annotations ..."
curl -fsSL -o "$work/annotations.csv" "$CSV"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in recordings.parquet sounds.parquet; do
  mv "$work/$f" "$here/$f.tmp" && mv "$here/$f.tmp" "$here/$f"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
