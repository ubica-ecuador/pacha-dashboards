-- Reads what build.sh leaves in the working directory (readings.csv, names.csv, hvi.csv and zcta.geojson, as NYC
-- Open Data exports them) and writes:
--
--   readings.parquet  one row per sensor and hour, in time order:
--     time           the start of the hour (UTC); NYC Open Data gives the day and hour in New York's time
--     sensor         the sensor's id, such as 'Mn-EH_12' (borough and study area, then a number)
--     mount          'Street tree' or 'Light pole'
--     borough        Manhattan, Bronx, Brooklyn or Queens
--     nta            the neighbourhood's code (a 2010 Neighborhood Tabulation Area), such as MN33
--     neighbourhood  its name, such as East Harlem South
--     latitude, longitude
--     temp_c         the hour's mean air temperature, °C, one decimal
--     temp_f         the same in °F, as published
--
--   zcta.parquet  one row per ZIP Code Tabulation Area of New York City:
--     zcta           the ZCTA, such as 10029
--     hvi            its Heat Vulnerability Index, 1 (lowest risk) to 5 (highest); null where DOHMH gives none
--     geometry       its outline, WKT, simplified to about 5 m
--     west, south, east, north   its box, degrees, for a query to pick the ones near a place without spatial
INSTALL spatial;
LOAD spatial;
SET TimeZone = 'UTC';

COPY (
  SELECT
    (r.day::TIMESTAMP + r.hour * INTERVAL 1 HOUR + INTERVAL 4 HOUR) AS time,
    r.sensor_id AS sensor,
    CASE r.install_type WHEN 'Street Tree' THEN 'Street tree' WHEN 'Light Pole' THEN 'Light pole' ELSE r.install_type END AS mount,
    r.borough,
    r.ntacode AS nta,
    n.nta_name AS neighbourhood,
    r.latitude::DOUBLE AS latitude,
    r.longitude::DOUBLE AS longitude,
    round((r.airtemp - 32) * 5 / 9, 1) AS temp_c,
    round(r.airtemp, 1) AS temp_f
  FROM read_csv('readings.csv', header = true, types = {'hour': 'INTEGER', 'airtemp': 'DOUBLE', 'day': 'TIMESTAMP'}) r
  LEFT JOIN (SELECT DISTINCT nta_code, nta_name FROM read_csv('names.csv', header = true)) n ON n.nta_code = r.ntacode
  WHERE r.airtemp IS NOT NULL AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
  ORDER BY time, sensor
) TO 'readings.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT
    z.zcta5::VARCHAR AS zcta,
    h.hvi::INTEGER AS hvi,
    ST_AsText(ST_SimplifyPreserveTopology(z.geom, 0.00005)) AS geometry,
    ST_XMin(z.geom) AS west, ST_YMin(z.geom) AS south, ST_XMax(z.geom) AS east, ST_YMax(z.geom) AS north
  FROM ST_Read('zcta.geojson') z
  LEFT JOIN read_csv('hvi.csv', header = true, types = {'zcta20': 'VARCHAR', 'hvi': 'INTEGER'}) h
    ON h.zcta20 = z.zcta5::VARCHAR
  ORDER BY zcta
) TO 'zcta.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT count(*) AS readings, count(DISTINCT sensor) AS sensors, min(time) AS first, max(time) AS last,
       min(temp_c) AS coolest, max(temp_c) AS hottest, count(*) FILTER (WHERE neighbourhood IS NULL) AS unnamed
FROM 'readings.parquet';

SELECT count(*) AS zctas, count(hvi) AS with_hvi, min(hvi) AS lowest, max(hvi) AS highest,
       round(sum(length(geometry)) / 1e6, 2) AS wkt_mb
FROM 'zcta.parquet';
