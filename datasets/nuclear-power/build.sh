#!/bin/sh
# Builds what nuclear-power draws: every nuclear power reactor in the world and the electricity
# they made, 1954 to 2023.
#
#   reactors.parquet    one row per reactor with a place (759 of the 804 listed, 639 of them with a
#                       date of commercial operation): place, country, type, net capacity in MWe,
#                       construction start, commercial operation, permanent shutdown and status in
#                       March 2024. From GeoNuclearData (Cristian Stoica, ODbL 1.0:
#                       github.com/cristianst85/GeoNuclearData), which follows the IAEA's Power
#                       Reactor Information System (PRIS) and the World Nuclear Association, at its
#                       update of 2 March 2024. Its coordinates are approximate, a plant's units
#                       share one place, and nine reactors that ran have no date of commercial
#                       operation (Palisades among them): they stay off the timeline.
#   generation.parquet  nuclear electricity by country and year, 1965 to 2025, in TWh and as a share
#                       of the country's electricity. From Our World in Data's energy dataset
#                       (CC BY 4.0: github.com/owid/energy-data), based on the Energy Institute's
#                       Statistical Review of World Energy and Ember.
#
# A reactor is in service from its commercial operation until its permanent shutdown. One that
# stands idle without being shut down for good, as most of Japan's did after Fukushima, stays in
# service in the list: the electricity it made shows the difference.
#
# Two downloads, 108 KB and 16 MB, not kept. The gateway serves the files at
# http://feeds/datasets/nuclear-power/; nothing to restart.
#
# Needs curl and unzip.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
DUCKDB_VERSION=1.5.4
# GeoNuclearData at its last update (PRIS of 2 March 2024).
REACTORS=https://raw.githubusercontent.com/cristianst85/GeoNuclearData/1bc8b4ac106af236902385b87e46c540b4864815/data/csv/denormalized/nuclear_power_plants.csv
ENERGY=https://owid-public.owid.io/data/energy/owid-energy-data.csv

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

echo "GeoNuclearData reactors ..."
curl -fsSL -o "$work/nuclear_power_plants.csv" "$REACTORS"
echo "Our World in Data energy ..."
curl -fsSL -o "$work/owid-energy-data.csv" "$ENERGY"
(cd "$work" && "$work/duckdb" -bail -c ".read '$here/build.sql'")

for f in reactors.parquet generation.parquet; do
  mv "$work/$f" "$here/$f.tmp" && mv "$here/$f.tmp" "$here/$f"
done
echo "Done: $(ls "$here"/*.parquet | wc -l) files in $here"
