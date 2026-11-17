"""Flateau's tables of Edogawa to the Parquet files of edogawa-flood, and attrs.json for plateau.py inject.

Usage: build.py <out dir> <work dir>   (the work dir holds tiles.txt and the related data's GeoJSON)

Flateau (Pacific Spatial Solutions, CC BY 4.0, on Source Cooperative) is PLATEAU's CityGML of FY2023 read into
tables, with PLATEAU's codes turned into words: one row per building, and one per building, river and scenario for
the river floods (and Tokyo's storm surge study, as the scenario Surge). Its gml_id is the CityGML's own, so its rows fall on the 3D buildings.
"""
import json
import sys
from datetime import datetime, timezone

import duckdb

out, work = sys.argv[1:3]
FLATEAU = 'https://data.source.coop/pacificspatial/flateau/parquet/13123_edogawa-ku_2023_'
con = duckdb.connect()
con.execute('INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;')

# PLATEAU's building uses (its code list), in English.
USAGES = {
    '401': 'Offices', '402': 'Shops', '403': 'Hotel', '404': 'Shops and offices',
    '411': 'House', '412': 'Apartment building', '413': 'House with a shop', '414': 'Apartments with shops',
    '415': 'House with a workshop', '421': 'Government', '422': 'School, hospital or care',
    '431': 'Transport or warehouse', '441': 'Factory', '451': 'Farming or fishing', '452': 'Utility plant',
    '453': 'Defence', '454': 'Other',
}
# The flood zones PLATEAU maps buildings in: the rivers whose banks would break, each a study of its own.
RIVERS = {
    '利根川水系利根川': 'Tone',
    '利根川水系江戸川': 'Edogawa',
    '利根川水系中川': 'Naka',
    '中川・綾瀬川圏域': 'Naka and Ayase (Tokyo)',
    '江東内部河川流域': 'Koto inner rivers',
}
con.execute('CREATE TABLE usages (code VARCHAR, usage VARCHAR)')
con.executemany('INSERT INTO usages VALUES (?, ?)', list(USAGES.items()))
con.execute('CREATE TABLE rivers (description VARCHAR, river VARCHAR)')
con.executemany('INSERT INTO rivers VALUES (?, ?)', list(RIVERS.items()))

con.execute(f"""
CREATE TABLE b AS
WITH c AS (
  SELECT gml_id, GEOM, storeys_above_ground, storeys_below_ground, measured_height, usage_code, cal_area_m2
  FROM read_parquet('{FLATEAU}building_centroid_lod0.parquet')
)
SELECT row_number() OVER (ORDER BY gml_id)::INTEGER AS key, gml_id,
       -- The 1 km tile (JIS third-level mesh) of the building's centre, as PLATEAU names its files.
       format('{{:02d}}{{:02d}}{{:d}}{{:d}}{{:d}}{{:d}}',
         floor(lat * 1.5)::INT, floor(lon - 100)::INT,
         floor((lat * 1.5 - floor(lat * 1.5)) * 8)::INT, floor((lon - floor(lon)) * 8)::INT,
         floor(((lat * 1.5 - floor(lat * 1.5)) * 8 - floor((lat * 1.5 - floor(lat * 1.5)) * 8)) * 10)::INT,
         floor(((lon - floor(lon)) * 8 - floor((lon - floor(lon)) * 8)) * 10)::INT) AS mesh,
       round(lon, 6) AS lon, round(lat, 6) AS lat,
       storeys_above_ground::INTEGER AS storeys, storeys_below_ground::INTEGER AS basements,
       round(measured_height, 1) AS height_m, coalesce(u.usage, 'Unknown') AS usage,
       round(cal_area_m2)::INTEGER AS footprint_m2
FROM (SELECT *, ST_X(GEOM) AS lon, ST_Y(GEOM) AS lat FROM c) c
LEFT JOIN usages u ON u.code = c.usage_code
""")

con.execute(f"""
CREATE TABLE f AS
SELECT b.key, r.river, CASE f.scale_code WHEN '1' THEN 'L1' ELSE 'L2' END AS scenario,
       f.rank_code::INTEGER AS band, round(f.depth, 2) AS depth_m, round(f.duration, 1) AS hours
FROM read_parquet('{FLATEAU}building_risk_flooding.parquet') f
JOIN b USING (gml_id)
JOIN rivers r USING (description)
UNION ALL
-- Tokyo's storm surge study (March 2018): the largest typhoon assumed, Tokyo Bay over the sea walls. Depth and band,
-- no duration.
SELECT b.key, 'Tokyo Bay' AS river, 'Surge' AS scenario, f.rank_code::INTEGER AS band, round(f.depth, 2) AS depth_m,
       NULL::DOUBLE AS hours
FROM read_parquet('{FLATEAU}building_risk_high_tide.parquet') f
JOIN b USING (gml_id)
""")
unknown = con.execute(f"""
SELECT DISTINCT description FROM read_parquet('{FLATEAU}building_risk_flooding.parquet')
WHERE description NOT IN (SELECT description FROM rivers)""").fetchall()
if unknown:
    sys.exit(f'rivers without a name here: {unknown}')

con.execute(f"COPY (SELECT * FROM b ORDER BY key) TO '{out}/buildings.parquet' (FORMAT parquet, COMPRESSION zstd)")
con.execute(f"COPY (SELECT * FROM f ORDER BY key, river, scenario) TO '{out}/flood.parquet' (FORMAT parquet, COMPRESSION zstd)")

# What each building of the 3D files says on hover: the worst of any river, in each scenario.
rows = con.execute("""
SELECT b.gml_id, b.key, b.storeys, b.height_m, b.usage,
       max(f.depth_m) FILTER (scenario = 'L1') AS depth_l1_m,
       max(f.depth_m) FILTER (scenario = 'L2') AS depth_l2_m,
       round(max(f.hours) FILTER (scenario = 'L2') / 24, 1) AS days_l2,
       max(f.depth_m) FILTER (scenario = 'Surge') AS depth_surge_m
FROM b LEFT JOIN f USING (key)
GROUP BY ALL
""").fetchall()
columns = ['key', 'storeys', 'height_m', 'usage', 'depth_l1_m', 'depth_l2_m', 'days_l2', 'depth_surge_m']
with open(f'{work}/attrs.json', 'w') as fh:
    json.dump({'columns': columns, 'rows': {r[0]: list(r[1:]) for r in rows}}, fh, ensure_ascii=False)

# The 1 km tiles PLATEAU publishes, each with its box (a JIS third-level mesh is 30" of latitude by 45" of
# longitude) and its CityJSON on this instance's gateway.
meshes = [line.split()[0] for line in open(f'{work}/tiles.txt') if line.strip()]
con.execute('CREATE TABLE t (mesh VARCHAR)')
con.executemany('INSERT INTO t VALUES (?)', [(m,) for m in meshes])
con.execute(f"""
COPY (
  SELECT mesh,
         round(100 + substr(mesh, 3, 2)::INT + substr(mesh, 6, 1)::INT / 8 + substr(mesh, 8, 1)::INT / 80, 6) AS west,
         round(substr(mesh, 1, 2)::INT / 1.5 + substr(mesh, 5, 1)::INT / 12 + substr(mesh, 7, 1)::INT / 120, 6) AS south,
         round(west + 1 / 80, 6) AS east, round(south + 1 / 120, 6) AS north,
         (SELECT count(*) FROM b WHERE b.mesh = t.mesh) AS buildings
  FROM t ORDER BY mesh
) TO '{out}/tiles.parquet' (FORMAT parquet)
""")

# Shelters and the ward's border, from PLATEAU's related data. A shelter's water is the deepest PLATEAU expects
# (L2, any river) at the buildings within 30 m of it.
con.execute(f"""
CREATE TABLE s AS
SELECT "名称" AS name,
       CASE "施設の種類" WHEN '避難所' THEN 'Shelter' WHEN '避難場所' THEN 'Evacuation area'
            ELSE "施設の種類" END AS kind,
       "高さ"::DOUBLE AS height_m, "収容人数"::INTEGER AS capacity,
       round(ST_X(geom), 6) AS lon, round(ST_Y(geom), 6) AS lat
FROM ST_Read('{work}/13123_edogawa-ku_pref_2023_shelter.geojson')
""")
con.execute(f"""
COPY (
  SELECT s.*, (SELECT max(f.depth_m) FROM b JOIN f USING (key)
               WHERE f.scenario = 'L2'
                 AND ST_Distance_Sphere(ST_Point(b.lat, b.lon), ST_Point(s.lat, s.lon)) <= 30) AS water_l2_m
  FROM s ORDER BY name
) TO '{out}/shelters.parquet' (FORMAT parquet)
""")
con.execute(f"""
COPY (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ST_Read('{work}/13123_edogawa-ku_pref_2023_border.geojson'))
TO '{out}/border.parquet' (FORMAT parquet)
""")

built = datetime.now(timezone.utc).isoformat(timespec='seconds')
con.execute(f"""
COPY (SELECT '{built}'::TIMESTAMPTZ AS built_at, 'PLATEAU Edogawa FY2023 (CityGML v4), Flateau 2023' AS source,
             (SELECT count(*) FROM b) AS buildings, (SELECT count(*) FROM t) AS tiles)
TO '{out}/meta.parquet' (FORMAT parquet)
""")
for name in ('buildings', 'flood', 'tiles', 'shelters'):
    n = con.execute(f"SELECT count(*) FROM '{out}/{name}.parquet'").fetchone()[0]
    print(f'{name}.parquet: {n} rows')
