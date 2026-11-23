-- build.sh runs this in its work folder, with trips/*.csv (one row per trip) and the variable month (YYYYMM).
-- Writes stations.parquet, hourly.parquet and links.parquet.
INSTALL h3 FROM community;
LOAD h3;

-- Station ids mix numbers and Jersey City's letters: read them as text. Trips that start in the month before
-- (a few after midnight on its last day) are left out, and so are those without a station at either end
-- (dockless e-bike trips).
CREATE TABLE trips AS
SELECT started_at, ended_at, start_station_name AS s0, end_station_name AS s1,
       start_lat AS lat0, start_lng AS lng0, end_lat AS lat1, end_lng AS lng1,
       CASE WHEN dayofweek(started_at) IN (0, 6) OR started_at::DATE IN (
                 -- US federal holidays, 2025 to 2027: an average weekday is a working day
                 DATE '2025-01-01', DATE '2025-01-20', DATE '2025-02-17', DATE '2025-05-26', DATE '2025-06-19',
                 DATE '2025-07-04', DATE '2025-09-01', DATE '2025-10-13', DATE '2025-11-11', DATE '2025-11-27',
                 DATE '2025-12-25', DATE '2026-01-01', DATE '2026-01-19', DATE '2026-02-16', DATE '2026-05-25',
                 DATE '2026-06-19', DATE '2026-07-03', DATE '2026-09-07', DATE '2026-10-12', DATE '2026-11-11',
                 DATE '2026-11-26', DATE '2026-12-25', DATE '2027-01-01', DATE '2027-01-18', DATE '2027-02-15',
                 DATE '2027-05-31', DATE '2027-06-18', DATE '2027-07-05', DATE '2027-09-06', DATE '2027-10-11',
                 DATE '2027-11-11', DATE '2027-11-25', DATE '2027-12-24')
            THEN 'Weekend' ELSE 'Weekday' END AS day
FROM read_csv('trips/*.csv', header = true,
              types = {'start_station_id': 'VARCHAR', 'end_station_id': 'VARCHAR'})
WHERE strftime(started_at, '%Y%m') = getvariable('month')
  AND start_station_name IS NOT NULL AND end_station_name IS NOT NULL;

-- how many days of each kind the month has, to turn counts into an average day
CREATE TABLE days AS SELECT day, count(DISTINCT started_at::DATE) AS ndays FROM trips GROUP BY day;

COPY (
  WITH ends AS (
    SELECT s0 AS name, lat0 AS lat, lng0 AS lng, 1 AS o, 0 AS i FROM trips
    UNION ALL
    SELECT s1, lat1, lng1, 0, 1 FROM trips
  )
  SELECT name, round(median(lat), 6) AS latitude, round(median(lng), 6) AS longitude,
         sum(o)::INTEGER AS trips_out, sum(i)::INTEGER AS trips_in
  FROM ends
  GROUP BY name
  ORDER BY name
) TO 'stations.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  WITH o AS (SELECT s0 AS name, day, hour(started_at) AS hour, count(*) AS n FROM trips GROUP BY ALL),
       i AS (SELECT s1 AS name, day, hour(ended_at) AS hour, count(*) AS n FROM trips GROUP BY ALL)
  SELECT name, day, hour::TINYINT AS hour,
         round(coalesce(o.n, 0) / d.ndays, 2)::FLOAT AS bikes_out,
         round(coalesce(i.n, 0) / d.ndays, 2)::FLOAT AS bikes_in
  FROM o FULL JOIN i USING (name, day, hour)
  JOIN days d USING (day)
  ORDER BY day, hour, name
) TO 'hourly.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  WITH st AS (SELECT name, latitude, longitude, h3_latlng_to_cell(latitude, longitude, 8) AS cell
              FROM read_parquet('stations.parquet')),
  pairs AS (
    SELECT t.day, hour(t.started_at) AS hour, a.cell AS c0, b.cell AS c1, count(*) AS n
    FROM trips t JOIN st a ON a.name = t.s0 JOIN st b ON b.name = t.s1
    WHERE a.cell <> b.cell
    GROUP BY ALL
  ),
  top AS (
    SELECT * FROM pairs QUALIFY row_number() OVER (PARTITION BY day, hour ORDER BY n DESC) <= 400
  )
  SELECT day, hour::TINYINT AS hour, h3_h3_to_string(c0) AS cell0, h3_h3_to_string(c1) AS cell1,
         round(h3_cell_to_lat(c0), 5) AS lat0, round(h3_cell_to_lng(c0), 5) AS lng0,
         round(h3_cell_to_lat(c1), 5) AS lat1, round(h3_cell_to_lng(c1), 5) AS lng1,
         round(n / d.ndays, 2)::FLOAT AS trips
  FROM top JOIN days d USING (day)
  ORDER BY day, hour, trips DESC
) TO 'links.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT day, ndays, (SELECT count(*) FROM trips t WHERE t.day = days.day) AS trips FROM days;
