-- The world's high-voltage grid as one Parquet file, for the
-- wildfires-power-grid dashboard (http://feeds/datasets/power-grid/lines.parquet).
-- Run by build.sh, which sets `release` (an Overture Maps release) and runs
-- this in the folder the file is written to.
--
-- Overture's infrastructure features of subtype power keep the OpenStreetMap
-- tags of the way they came from in source_tags. A line's voltage is the first
-- of the semicolon list OSM uses for ways that carry several circuits; ways of
-- 200 kV and more stay, overhead (power_line) or underground (cable).
--
-- Rows are in Hilbert order of their middle and carry their extent in four
-- plain columns, so a region's read prunes most row groups.

INSTALL spatial;
LOAD spatial;
INSTALL httpfs;
LOAD httpfs;
SET s3_region = 'us-west-2';
SET geometry_always_xy = true;

-- The power ways first, into a table: a few hundred thousand rows out of the
-- theme's tens of millions, so the sort below works on little.
CREATE TABLE power AS
SELECT id, names.primary AS name, source_tags AS tags, class, geometry, bbox,
       try_cast(split_part(source_tags['voltage'], ';', 1) AS INTEGER) AS volts,
       sources[1].record_id AS record
FROM read_parquet('s3://overturemaps-us-west-2/release/' || getvariable('release')
                  || '/theme=base/type=infrastructure/*', hive_partitioning = true)
WHERE subtype = 'power' AND class IN ('power_line', 'cable');

COPY (
  SELECT id,
         -- The way's OSM id: a record id reads w<id>@<version>.
         CASE WHEN record LIKE 'w%' THEN try_cast(regexp_extract(record, '^w([0-9]+)', 1) AS BIGINT) END AS osm_way,
         coalesce(name, tags['ref'], 'OSM way ' || regexp_extract(record, '^w([0-9]+)', 1)) AS name,
         tags['ref'] AS ref,
         tags['operator'] AS operator,
         volts // 1000 AS kv,
         try_cast(tags['circuits'] AS INTEGER) AS circuits,
         CASE class WHEN 'cable' THEN 'cable' ELSE 'overhead' END AS kind,
         round(ST_Length_Spheroid(geometry) / 1000, 3) AS km,
         bbox.xmin AS xmin, bbox.ymin AS ymin, bbox.xmax AS xmax, bbox.ymax AS ymax,
         geometry
  FROM power
  WHERE volts >= 200000 AND ST_GeometryType(geometry) = 'LINESTRING'
  ORDER BY ST_Hilbert(ST_Centroid(geometry), ST_MakeBox2D(ST_Point(-180, -90), ST_Point(180, 90))), id
) TO 'lines.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 8192);

SELECT count(*) AS lines, round(sum(km)) AS km, count(*) FILTER (WHERE kind = 'cable') AS cables,
       min(kv) AS min_kv, max(kv) AS max_kv
FROM 'lines.parquet';
