-- GeoLife, cleaned and analysed, as the Parquet files the geolife-mobility
-- dashboard reads through the gateway (http://feeds/datasets/geolife/...).
-- Run by build.sh, which sets `src` (the unzipped "Geolife Trajectories 1.3"
-- folder) and runs this in the folder the files are written to.
--
-- It follows Anita Graser's protocol for exploring movement data: read the GPS
-- files with DuckDB, as in "Wrangling hundreds of GPS files with DuckDB, QGIS &
-- Trajectools" (2025), then preprocess as in her Trajectools tutorial (2024):
-- split at observation gaps, remove speed outliers, drop what is too short,
-- smooth; then speeds, stops and the points the flows are generalized from.
--
-- Times in GeoLife are UTC; Beijing is UTC+8 all year.

SET VARIABLE gap_s = 300;       -- a trip ends where the GPS was silent 5 minutes ...
SET VARIABLE jump_kmh = 300;    -- ... or jumped faster than that
SET VARIABLE spike_kmh = 100;   -- a fix that jumps away and back that fast is noise
SET VARIABLE stop_m = 100;      -- staying within 100 m ...
SET VARIABLE stop_s = 300;      -- ... for 5 minutes is a stop

CREATE MACRO km(lat1, lon1, lat2, lon2) AS
  2 * 6371.0088 * asin(sqrt(
    pow(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));
CREATE MACRO in_beijing(lat, lon) AS lat BETWEEN 39.6 AND 40.3 AND lon BETWEEN 115.9 AND 116.9;

-- 0. Every fix of every .plt file: 182 users, 18,670 files, 24.9 million fixes.
--    No id in the files: the user is the folder, the trajectory the file name.
CREATE TABLE raw AS
SELECT regexp_extract(filename, '[/\\](\d{3})[/\\]Trajectory', 1)::SMALLINT AS uid,
       parse_filename(filename, true) AS file,
       strptime(date || ' ' || time, '%Y-%m-%d %H:%M:%S') AS t,
       lat, lon,
       CASE WHEN alt <> -777 THEN alt * 0.3048 END AS alt_m
FROM read_csv(getvariable('src') || '/Data/*/Trajectory/*.plt', skip = 6, header = false, filename = true,
              columns = {'lat': 'DOUBLE', 'lon': 'DOUBLE', 'zero': 'INT', 'alt': 'DOUBLE',
                         'days': 'DOUBLE', 'date': 'VARCHAR', 'time': 'VARCHAR'});

-- The labels 69 users gave their trips: how they travelled, from when to when.
-- Run is walking; taxi is a car; airplane, boat and motorcycle are too few.
CREATE TABLE labels AS
SELECT regexp_extract(filename, '[/\\](\d{3})[/\\]labels', 1)::SMALLINT AS uid,
       "Start Time" AS t0, "End Time" AS t1,
       CASE "Transportation Mode" WHEN 'run' THEN 'walk' WHEN 'taxi' THEN 'car'
            WHEN 'airplane' THEN 'other' WHEN 'boat' THEN 'other' WHEN 'motorcycle' THEN 'other'
            ELSE "Transportation Mode" END AS mode
FROM read_csv(getvariable('src') || '/Data/*/labels.txt', delim = '\t', header = true, filename = true,
              timestampformat = '%Y/%m/%d %H:%M:%S');

-- 1. One fix per user and second, with coordinates on Earth and a date within
--    the study (April 2007 to August 2012: a few fixes say 2000).
CREATE TABLE valid AS
SELECT uid, any_value(file ORDER BY file) AS file, t, any_value(lat ORDER BY file) AS lat,
       any_value(lon ORDER BY file) AS lon, any_value(alt_m ORDER BY file) AS alt_m
FROM raw
WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND t >= TIMESTAMP '2007-04-01'
GROUP BY uid, t;

-- 2. Trips: a user's fixes split wherever the GPS was silent five minutes, or
--    jumped somewhere it could not have got to: over 300 km/h for over 500 m,
--    as when it finds itself again out of a tunnel. Planes are split too.
CREATE TABLE split AS
WITH p AS (
  SELECT *, lag(t) OVER w AS pt, km(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS d
  FROM valid WINDOW w AS (PARTITION BY uid ORDER BY t)
),
g AS (
  SELECT * EXCLUDE (pt, d),
         pt IS NULL OR epoch(t - pt) > getvariable('gap_s')
         OR (d > 0.5 AND d / epoch(t - pt) * 3600 > getvariable('jump_kmh')) AS new
  FROM p
)
SELECT *, sum(new::INT) OVER (PARTITION BY uid ORDER BY t) AS n FROM g;

-- 3. Speed outliers: a fix that jumps away from its neighbours and back, over
--    100 km/h, while they lie close to each other. A plane flying straight is
--    not one; a GPS bounce off a tower block is.
CREATE TABLE flagged AS
WITH nb AS (
  SELECT *,
         lag(lat) OVER w AS plat, lag(lon) OVER w AS plon, lag(t) OVER w AS pt,
         lead(lat) OVER w AS nlat, lead(lon) OVER w AS nlon, lead(t) OVER w AS nt
  FROM split WINDOW w AS (PARTITION BY uid, n ORDER BY t)
),
s AS (
  SELECT *, km(plat, plon, lat, lon) AS a, km(lat, lon, nlat, nlon) AS b, km(plat, plon, nlat, nlon) AS c
  FROM nb
)
SELECT uid, file, n, t, lat, lon, alt_m,
       CASE WHEN a / greatest(epoch(t - pt), 1) * 3600 > getvariable('spike_kmh')
             AND b / greatest(epoch(nt - t), 1) * 3600 > getvariable('spike_kmh')
             AND a + b > 3 * c + 0.2 THEN 'spike' ELSE 'kept' END AS flag
FROM s;

-- 4. Trips too short to say anything: under 10 fixes, a minute or 100 m.
CREATE TABLE trip_ok AS
WITH k AS (
  SELECT uid, n, t, lat, lon,
         km(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS step
  FROM flagged WHERE flag = 'kept' WINDOW w AS (PARTITION BY uid, n ORDER BY t)
)
SELECT uid, n
FROM k GROUP BY uid, n
HAVING count(*) >= 10 AND epoch(max(t) - min(t)) >= 60 AND coalesce(sum(step), 0) >= 0.1;

-- 5. Kept fixes, numbered trips, smoothed speed: over five fixes, two either
--    side, so one jittery fix does not make a sprint. Heading the same way.
--    The mode is the label covering the fix, if its user labelled it.
CREATE TABLE fixes_kept AS
WITH k AS (
  SELECT f.*, dense_rank() OVER (ORDER BY f.uid, f.n) AS trip
  FROM flagged f SEMI JOIN trip_ok USING (uid, n)
  WHERE f.flag = 'kept'
),
w AS (
  SELECT *,
         km(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS step,
         lag(lat, 2) OVER w AS latb, lag(lon, 2) OVER w AS lonb, lag(t, 2) OVER w AS tb,
         lead(lat, 2) OVER w AS lat2, lead(lon, 2) OVER w AS lon2, lead(t, 2) OVER w AS t2,
         row_number() OVER w AS i
  FROM k WINDOW w AS (PARTITION BY trip ORDER BY t)
),
v AS (
  SELECT *,
         -- Either end of a trip has no fixes on one side: that sum is NULL, not 0.
         coalesce(sum(coalesce(step, 0)) OVER (PARTITION BY trip ORDER BY t ROWS BETWEEN 1 FOLLOWING AND 2 FOLLOWING), 0)
         + coalesce(sum(coalesce(step, 0)) OVER (PARTITION BY trip ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), 0) AS path5
  FROM w
)
SELECT v.uid, v.n, v.file, v.trip, v.i, v.t, v.lat, v.lon, v.alt_m, coalesce(v.step, 0) AS step_km,
       round(path5 / greatest(epoch(coalesce(v.t2, v.t) - coalesce(v.tb, v.t)), 1) * 3600, 1)::FLOAT AS kmh,
       round((degrees(atan2(
         sin(radians(coalesce(lon2, lon) - coalesce(lonb, lon))) * cos(radians(coalesce(lat2, lat))),
         cos(radians(coalesce(latb, lat))) * sin(radians(coalesce(lat2, lat)))
         - sin(radians(coalesce(latb, lat))) * cos(radians(coalesce(lat2, lat))) * cos(radians(coalesce(lon2, lon) - coalesce(lonb, lon)))
       )) + 360) % 360)::SMALLINT AS heading,
       l.mode
FROM v
LEFT JOIN labels l ON l.uid = v.uid AND v.t BETWEEN l.t0 AND l.t1
QUALIFY row_number() OVER (PARTITION BY v.trip, v.t ORDER BY l.t0) = 1;

-- 6. Stops inside a trip: a fix is still when, five minutes on, it is within
--    100 m; a run of still fixes is a stop, from its first fix to where the
--    last one's five minutes end. Between trips: the GPS was silent (often
--    indoors) and the next trip starts within 200 m of where the last ended.
CREATE TABLE stops AS
WITH ahead AS (
  SELECT a.trip, a.i, a.t, a.lat, a.lon, b.t AS t5, km(a.lat, a.lon, b.lat, b.lon) * 1000 AS m5
  FROM fixes_kept a
  ASOF JOIN fixes_kept b ON a.trip = b.trip AND b.t >= a.t + to_seconds(getvariable('stop_s'))
),
still AS (
  SELECT *, i - row_number() OVER (PARTITION BY trip ORDER BY i) AS run
  FROM ahead WHERE m5 <= getvariable('stop_m')
),
dwell AS (
  SELECT trip, 'dwell' AS kind, min(t) AS t0, max(t5) AS t1, median(lat) AS lat, median(lon) AS lon
  FROM still GROUP BY trip, run
),
ends AS (
  SELECT trip, uid, min(t) AS t0, max(t) AS t1,
         arg_min(lat, t) AS lat0, arg_min(lon, t) AS lon0, arg_max(lat, t) AS lat1, arg_max(lon, t) AS lon1
  FROM fixes_kept GROUP BY trip, uid
),
pause AS (
  SELECT trip, 'pause' AS kind, t1 AS t0, nt0 AS t1, lat1 AS lat, lon1 AS lon
  FROM (SELECT *, lead(t0) OVER w AS nt0, lead(lat0) OVER w AS nlat, lead(lon0) OVER w AS nlon
        FROM ends WINDOW w AS (PARTITION BY uid ORDER BY t0))
  WHERE nt0 - t1 <= INTERVAL 12 HOUR AND km(lat1, lon1, nlat, nlon) <= 0.2
)
SELECT trip, kind, t0, t1, round(epoch(t1 - t0) / 60, 1)::FLOAT AS minutes, lat, lon
FROM (SELECT * FROM dwell UNION ALL SELECT * FROM pause);

-- 7. One row per trip: where and when, how long, how fast, how it travelled
--    (the mode most of its labelled fixes have, if half of them are labelled).
CREATE TABLE trips AS
SELECT trip, any_value(uid) AS uid, any_value(file) AS file,
       min(t) AS t0, max(t) AS t1, count(*)::INTEGER AS fixes,
       round(sum(step_km), 2)::FLOAT AS km,
       round(epoch(max(t) - min(t)) / 60, 1)::FLOAT AS minutes,
       round(sum(step_km) / greatest(epoch(max(t) - min(t)), 1) * 3600, 1)::FLOAT AS avg_kmh,
       round(quantile_cont(kmh, 0.95), 1)::FLOAT AS p95_kmh,
       CASE WHEN count(mode) * 2 >= count(*) THEN mode(mode) END AS mode,
       arg_min(lat, t) AS lat0, arg_min(lon, t) AS lon0, arg_max(lat, t) AS lat1, arg_max(lon, t) AS lon1,
       in_beijing(arg_min(lat, t), arg_min(lon, t)) AND in_beijing(arg_max(lat, t), arg_max(lon, t)) AS beijing
FROM fixes_kept GROUP BY trip;

-- The files. fixes.parquet keeps the removed fixes too, flagged, so a trip can
-- be drawn before and after cleaning; sorted by trip, so reading one trip reads
-- one row group.
COPY (
  SELECT k.trip, k.uid, k.t, k.lat, k.lon, k.alt_m::FLOAT AS alt_m, k.kmh, k.heading,
         coalesce(k.mode, tr.mode) AS mode, 'kept' AS flag
  FROM fixes_kept k JOIN trips tr USING (trip)
  UNION ALL
  SELECT tr.trip, f.uid, f.t, f.lat, f.lon, f.alt_m::FLOAT, NULL, NULL, tr.mode, 'spike'
  FROM flagged f JOIN (SELECT DISTINCT uid, n, trip FROM fixes_kept) m USING (uid, n)
  JOIN trips tr ON tr.trip = m.trip
  WHERE f.flag = 'spike'
  ORDER BY trip, t
) TO 'fixes.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000);

COPY (SELECT * FROM trips ORDER BY trip) TO 'trips.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (SELECT s.*, tr.uid, coalesce(tr.mode, '') AS mode, tr.beijing
      FROM stops s JOIN trips tr USING (trip) ORDER BY trip, t0)
TO 'stops.parquet' (FORMAT parquet, COMPRESSION zstd);

-- Beijing, one fix every 15 seconds of each trip, with metres east and north of
-- Tiananmen for gridding: what speeds and flows are aggregated from, live.
-- A fix starts a trip, ends it, stops, or turns more than 45 degrees:
-- the characteristic points Andrienko & Andrienko generalize trajectories by.
COPY (
  WITH b AS (
    SELECT k.trip, k.t, k.lat, k.lon, k.kmh, k.heading, coalesce(k.mode, tr.mode, '') AS mode
    FROM fixes_kept k JOIN trips tr USING (trip)
    WHERE tr.beijing AND in_beijing(k.lat, k.lon)
    QUALIFY row_number() OVER (PARTITION BY k.trip, time_bucket(INTERVAL 15 SECOND, k.t) ORDER BY k.t) = 1
  ),
  c AS (
    SELECT *,
           row_number() OVER w = 1 OR lead(t) OVER w IS NULL AS ends,
           abs(((heading - lag(heading) OVER w) + 540) % 360 - 180) > 45 AND kmh > 3 AS turn
    FROM b WINDOW w AS (PARTITION BY trip ORDER BY t)
  )
  SELECT c.trip, c.t, c.lat, c.lon,
         round((c.lon - 116.3975) * 111320 * cos(radians(39.9087)))::INTEGER AS x,
         round((c.lat - 39.9087) * 110574)::INTEGER AS y,
         c.kmh, c.mode,
         c.ends OR c.turn OR EXISTS (SELECT 1 FROM stops s WHERE s.trip = c.trip AND c.t BETWEEN s.t0 AND s.t1) AS keypoint
  FROM c ORDER BY trip, t
) TO 'track.parquet' (FORMAT parquet, COMPRESSION zstd);

-- The cleaning, step by step: fixes and trips in, fixes and trips left.
COPY (
  SELECT * FROM (VALUES
    (1, 'Read every GPS file', (SELECT count(*) FROM raw), (SELECT count(DISTINCT (uid, file)) FROM raw)),
    (2, 'One fix per user and second, valid place and date', (SELECT count(*) FROM valid), NULL),
    (3, 'Split at 5-minute gaps and impossible jumps', (SELECT count(*) FROM split), (SELECT count(DISTINCT (uid, n)) FROM split)),
    (4, 'Remove speed outliers', (SELECT count(*) FROM flagged WHERE flag = 'kept'), NULL),
    (5, 'Drop trips under 10 fixes, a minute or 100 m', (SELECT count(*) FROM fixes_kept), (SELECT count(*) FROM trips)),
    (6, 'In Beijing, start and end', (SELECT count(*) FROM fixes_kept k JOIN trips USING (trip) WHERE beijing),
        (SELECT count(*) FROM trips WHERE beijing))
  ) AS s(step, what, fixes, trips)
) TO 'cleaning.parquet' (FORMAT parquet);

-- How often the GPS spoke, before cleaning: seconds between a user's fixes.
COPY (
  WITH g AS (SELECT epoch(t - lag(t) OVER (PARTITION BY uid ORDER BY t)) AS s FROM valid)
  SELECT CASE WHEN s <= 1 THEN 1 WHEN s <= 2 THEN 2 WHEN s <= 5 THEN 3 WHEN s <= 10 THEN 4
              WHEN s <= 60 THEN 5 WHEN s <= 300 THEN 6 WHEN s <= 3600 THEN 7 ELSE 8 END AS bin,
         count(*) AS fixes
  FROM g WHERE s IS NOT NULL GROUP BY bin ORDER BY bin
) TO 'sampling.parquet' (FORMAT parquet);
