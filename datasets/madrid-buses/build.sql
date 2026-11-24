-- build.sh runs this in its work folder, with gtfs/*.txt (EMT Madrid's GTFS) and the variable day (a DATE).
-- Writes buses.parquet, active.parquet and day.parquet.
CREATE MACRO g(f) AS TABLE SELECT * FROM read_csv('gtfs/' || f, header = true, all_varchar = true);

-- The services that run on the day: its weekday in calendar.txt, with calendar_dates.txt's exceptions.
CREATE TABLE services AS
  SELECT service_id FROM g('calendar.txt')
  WHERE getvariable('day') BETWEEN strptime(start_date, '%Y%m%d')::DATE AND strptime(end_date, '%Y%m%d')::DATE
    AND [monday, tuesday, wednesday, thursday, friday, saturday, sunday][isodow(getvariable('day'))] = '1'
  UNION SELECT service_id FROM g('calendar_dates.txt')
  WHERE date = strftime(getvariable('day'), '%Y%m%d') AND exception_type = '1'
  EXCEPT SELECT service_id FROM g('calendar_dates.txt')
  WHERE date = strftime(getvariable('day'), '%Y%m%d') AND exception_type = '2';

-- Every stop of every trip on the day. EMT's stop_times hold each run's own times (frequencies.txt only
-- describes them: line 1 leaves every 12 minutes at 09:00-14:00, and so do its runs); times past 24:00 are
-- after midnight. A bus is a GTFS block: the runs one vehicle makes one after another.
CREATE TABLE stops AS
SELECT t.block_id, t.trip_id, r.route_short_name AS line,
       CASE WHEN r.route_short_name LIKE 'N%' THEN 'Night' ELSE 'Day' END AS kind,
       getvariable('day')::TIMESTAMP + to_seconds(
         split_part(st.departure_time, ':', 1)::INT * 3600 + split_part(st.departure_time, ':', 2)::INT * 60
         + split_part(st.departure_time, ':', 3)::INT) AS time,
       st.stop_id, round(s.stop_lat::DOUBLE, 5) AS latitude, round(s.stop_lon::DOUBLE, 5) AS longitude
FROM g('stop_times.txt') st
JOIN g('trips.txt') t USING (trip_id)
JOIN services USING (service_id)
JOIN g('stops.txt') s USING (stop_id)
JOIN g('routes.txt') r USING (route_id);

CREATE TABLE buses AS SELECT block_id, dense_rank() OVER (ORDER BY block_id)::SMALLINT AS bus FROM (SELECT DISTINCT block_id FROM stops);

COPY (
  SELECT b.bus, s.line, s.kind, s.time, s.latitude, s.longitude
  FROM stops s JOIN buses b USING (block_id)
  ORDER BY b.bus, s.time
) TO 'buses.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  WITH runs AS (SELECT trip_id, block_id, any_value(kind) AS kind, min(time) AS t0, max(time) AS t1 FROM stops GROUP BY ALL),
  minutes AS (SELECT unnest(range(date_trunc('minute', (SELECT min(t0) FROM runs)), (SELECT max(t1) FROM runs), INTERVAL 1 MINUTE)) AS minute)
  SELECT m.minute, r.kind, count(DISTINCT r.block_id)::SMALLINT AS buses, count(*)::SMALLINT AS trips
  FROM minutes m JOIN runs r ON m.minute BETWEEN r.t0 AND r.t1
  GROUP BY ALL ORDER BY ALL
) TO 'active.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT getvariable('day') AS day, (SELECT string_agg(service_id, ', ' ORDER BY service_id) FROM services) AS services,
         count(DISTINCT block_id)::INTEGER AS buses, count(DISTINCT line)::INTEGER AS lines,
         count(DISTINCT trip_id)::INTEGER AS trips, count(DISTINCT stop_id)::INTEGER AS stops,
         min(time) AS first_departure, max(time) AS last_arrival
  FROM stops
) TO 'day.parquet' (FORMAT parquet);

SELECT * FROM read_parquet('day.parquet');
