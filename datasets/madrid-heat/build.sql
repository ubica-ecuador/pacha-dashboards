-- The CSVs build.py wrote (in work/) to the Parquet the dashboard reads. Runs in
-- the output directory, from build.sh.
INSTALL spatial;
LOAD spatial;

CREATE TABLE summary AS FROM read_csv('work/summary.csv', types = {'local_time': 'VARCHAR'});

-- One row per 1 km cell of the frame (UTM 30N): its centre, its distance to
-- Puerta del Sol, the share of each WorldCover class, the July medians in °C
-- (Landsat averaged to the cell, MODIS day and night) and each against its
-- countryside (the median over the cells under 5 % built), and the square as
-- GeoJSON for the map.
COPY (
  WITH ref AS (
    SELECT max(countryside) FILTER (WHERE product = 'landsat') AS landsat,
           max(countryside) FILTER (WHERE product = 'modis_day') AS day,
           max(countryside) FILTER (WHERE product = 'modis_night') AS night
    FROM summary
  )
  SELECT c.px, c.py, c.longitude, c.latitude, c.dist_km, c.rural,
         c.built_up AS built, c.trees, c.cropland, c.scrub_and_grass AS scrub_grass, c.bare_ground AS bare, c.water,
         c.landsat, c.day, c.night,
         round(c.landsat - ref.landsat, 2) AS landsat_vs,
         round(c.day - ref.day, 2) AS day_vs,
         round(c.night - ref.night, 2) AS night_vs,
         c.day_obs, c.night_obs,
         ST_AsGeoJSON(ST_ReducePrecision(ST_Transform(
           ST_MakeEnvelope(c.x - 500, c.y - 500, c.x + 500, c.y + 500),
           'EPSG:32630', 'EPSG:4326', always_xy := true), 0.00001)) AS geometry
  FROM read_csv('work/cells.csv') AS c, ref
  ORDER BY c.py, c.px
) TO 'cells.parquet' (FORMAT parquet, COMPRESSION zstd);

-- Landsat's 30 m pixels by land cover, against the countryside.
COPY (SELECT * FROM read_csv('work/landcover.csv') ORDER BY p50)
TO 'landcover.parquet' (FORMAT parquet, COMPRESSION zstd);

-- The three products: what, when (Madrid's clock), how many passes, and the
-- countryside's median in °C.
COPY (FROM summary) TO 'summary.parquet' (FORMAT parquet, COMPRESSION zstd);
