INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;
SET s3_region='us-west-2';
-- The area of the build: WEST SOUTH EAST NORTH from build.sh (default: central Cuenca).
CREATE TABLE raw AS
SELECT id, geometry AS geom, height, num_floors, sources[1].dataset AS source
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-11-18.0/theme=buildings/type=building/part-00002-3ce489cc-25a3-52f9-9857-5abefb653af2-c000.zstd.parquet')
WHERE bbox.xmin > ${WEST} AND bbox.xmax < ${EAST} AND bbox.ymin > ${SOUTH} AND bbox.ymax < ${NORTH}
  AND ST_GeometryType(geometry) IN ('POLYGON','MULTIPOLYGON');
-- UTM 17S metres for areas, neighbours and pixels (always_xy: lon, lat in).
CREATE TABLE b AS
SELECT id, source, height, num_floors, geom,
  ST_Transform(geom, 'EPSG:4326', 'EPSG:32717', always_xy := true) AS g
FROM raw;
CREATE TABLE measured AS
SELECT id, ST_Centroid(g) c, coalesce(height, num_floors * 3.0) h FROM b WHERE coalesce(height, num_floors) IS NOT NULL;
-- Heights: OSM's height, else its floors x 3 m, else the median of measured buildings within 80 m (at least 3), else 6 m.
CREATE TABLE est AS
SELECT b.id, median(m.h) AS h, count(*) AS k
FROM b JOIN measured m ON ST_DWithin(ST_Centroid(b.g), m.c, 80)
WHERE coalesce(b.height, b.num_floors) IS NULL GROUP BY b.id HAVING count(*) >= 3;
COPY (
SELECT b.id, b.source,
  round(CASE WHEN b.height IS NOT NULL THEN b.height WHEN b.num_floors IS NOT NULL THEN b.num_floors * 3.0
             WHEN est.h IS NOT NULL THEN est.h ELSE 6.0 END, 1) AS height_m,
  CASE WHEN b.height IS NOT NULL THEN 'height (OSM)' WHEN b.num_floors IS NOT NULL THEN 'floors (OSM)'
       WHEN est.h IS NOT NULL THEN 'neighbours' ELSE 'default' END AS height_from,
  round(ST_Area(b.g), 1) AS area_m2,
  ST_X(ST_Centroid(b.g)) AS cx, ST_Y(ST_Centroid(b.g)) AS cy,
  ST_AsWKB(b.g) AS g_utm, ST_AsWKB(b.geom) AS g_wgs
FROM b LEFT JOIN est USING (id)
) TO '/work/buildings.parquet' (FORMAT parquet);
SELECT height_from, count(*) n, round(median(height_m),1) med, max(height_m) mx FROM '/work/buildings.parquet' GROUP BY 1 ORDER BY 2 DESC;
