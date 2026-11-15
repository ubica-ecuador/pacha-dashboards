-- In the working directory: the USGS catalog's CSV (fdsn.csv) to quakes.parquet, earthquakes with a
-- depth and a magnitude, in UTC, oldest first; Natural Earth's countries (countries.geojson) to
-- land.parquet, clipped to the same box.
INSTALL spatial;
LOAD spatial;
SET TimeZone = 'UTC';
COPY (
  SELECT
    id,
    time::TIMESTAMP AS time,
    place,
    round(latitude, 4) AS latitude,
    round(longitude, 4) AS longitude,
    round(depth, 1) AS depth_km,
    round(mag, 1) AS mag,
    magType AS mag_type,
    net,
    status
  FROM read_csv('fdsn.csv', header = true)
  WHERE type = 'earthquake' AND depth IS NOT NULL AND depth >= 0 AND mag > 0
  ORDER BY time
) TO 'quakes.parquet' (FORMAT parquet, COMPRESSION zstd);
SELECT count(*) AS earthquakes, min(time) AS first, max(time) AS last, max(depth_km) AS deepest_km,
  max(mag) AS strongest
FROM 'quakes.parquet';
COPY (
  SELECT name AS country, ST_AsGeoJSON(ST_Intersection(geom, ST_MakeEnvelope(-84, -12, -66, 8))) AS geometry
  FROM ST_Read('countries.geojson')
  WHERE ST_Intersects(geom, ST_MakeEnvelope(-84, -12, -66, 8))
  ORDER BY country
) TO 'land.parquet' (FORMAT parquet, COMPRESSION zstd);
SELECT country, length(geometry) AS geojson_chars FROM 'land.parquet';
