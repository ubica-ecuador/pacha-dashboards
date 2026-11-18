-- One week of New York taxi trips (Monday 14 to Sunday 20 September 2015), as
-- the Parquet file the nyc-taxi-live dashboard reads through the gateway
-- (http://feeds/datasets/nyc-taxi/trips-2015-w38.parquet). Run by build.sh,
-- which sets `src` (the folder of the day CSVs exported from QuestDB's demo)
-- and runs this in the folder the file is written to.
--
-- The dashboard pretends to be live: it maps the current time in New York onto
-- this week, keeping the weekday and the time of day. 2015 and 2026 share a
-- calendar, so "today, eleven years ago" lines up to the weekday.
--
-- Three things in QuestDB's table are not what their names say:
--   * the pickup coordinates are swapped: pickup_latitude holds the longitude
--     and pickup_longitude the latitude (the dropoff pair is right);
--   * the timestamps carry a Z but are New York wall-clock time, so they are
--     parsed from text into naive timestamps, never through a time zone;
--   * about 1 % of rows are GPS noise (0,0, trips that end before they start
--     or run for days); those are dropped.
-- The H3 cells the map aggregates on are computed here, so the dashboard needs
-- no community extension: the data source only reads Parquet.

INSTALL h3 FROM community;
LOAD h3;

-- A box around the five boroughs, generous enough to keep Newark airport runs.
SET VARIABLE south = 40.49;
SET VARIABLE north = 40.93;
SET VARIABLE west = -74.27;
SET VARIABLE east = -73.68;

-- Every column as text first: the timestamps must not be read as UTC, and an
-- empty field in a numeric column should not abort the whole read.
CREATE TABLE raw AS
SELECT * FROM read_csv(getvariable('src') || '/*.csv', header = true, all_varchar = true);

CREATE TABLE trips AS
WITH typed AS (
  SELECT
    cab_type,
    strptime(left(pickup_datetime, 19), '%Y-%m-%dT%H:%M:%S') AS pickup_time,
    strptime(left(dropoff_datetime, 19), '%Y-%m-%dT%H:%M:%S') AS dropoff_time,
    TRY_CAST(pickup_longitude AS DOUBLE) AS pickup_lat,   -- swapped at the source
    TRY_CAST(pickup_latitude AS DOUBLE) AS pickup_lon,
    TRY_CAST(dropoff_latitude AS DOUBLE) AS dropoff_lat,
    TRY_CAST(dropoff_longitude AS DOUBLE) AS dropoff_lon,
    TRY_CAST(passenger_count AS INTEGER) AS passengers,
    TRY_CAST(trip_distance AS DOUBLE) AS distance_mi,
    TRY_CAST(fare_amount AS DOUBLE) AS fare,
    TRY_CAST(tip_amount AS DOUBLE) AS tip,
    TRY_CAST(total_amount AS DOUBLE) AS total
  FROM raw
)
SELECT
  *,
  h3_latlng_to_cell_string(pickup_lat, pickup_lon, 7) AS pickup_h3_7,
  h3_latlng_to_cell_string(dropoff_lat, dropoff_lon, 7) AS dropoff_h3_7,
  h3_latlng_to_cell_string(pickup_lat, pickup_lon, 8) AS pickup_h3_8,
  h3_latlng_to_cell_string(dropoff_lat, dropoff_lon, 8) AS dropoff_h3_8,
  h3_latlng_to_cell_string(pickup_lat, pickup_lon, 9) AS pickup_h3_9,
  h3_latlng_to_cell_string(dropoff_lat, dropoff_lon, 9) AS dropoff_h3_9
FROM typed
WHERE pickup_lat BETWEEN getvariable('south') AND getvariable('north')
  AND pickup_lon BETWEEN getvariable('west') AND getvariable('east')
  AND dropoff_lat BETWEEN getvariable('south') AND getvariable('north')
  AND dropoff_lon BETWEEN getvariable('west') AND getvariable('east')
  AND dropoff_time > pickup_time
  AND dropoff_time <= pickup_time + INTERVAL 3 HOUR
  AND fare >= 0;

-- Raw and kept trips per day, for the log.
SELECT r.day, r.n AS raw, coalesce(t.n, 0) AS kept,
       round(100.0 * coalesce(t.n, 0) / r.n, 1) AS kept_pct
FROM (SELECT left(pickup_datetime, 10) AS day, count(*) AS n FROM raw GROUP BY 1) r
LEFT JOIN (SELECT pickup_time::DATE::VARCHAR AS day, count(*) AS n FROM trips GROUP BY 1) t USING (day)
ORDER BY 1;

-- Sorted by pickup time, in row groups small enough that a ten-minute window
-- touches one or two of them.
COPY (SELECT * FROM trips ORDER BY pickup_time)
TO 'trips-2015-w38.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000);
