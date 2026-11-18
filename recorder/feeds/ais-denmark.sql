-- Every ship the Danish Maritime Authority's AIS network heard in a day, read
-- as trajectories: where each ship stopped, the trips between its stops, the
-- ships that lay together at sea, and how busy each stretch of water was. The
-- feed behind denmark-ais-trajectories.
--
-- The DMA publishes a day as one zipped CSV, about 650 MB, two or three days
-- later. The recorder (schedule: daily) fetches each day it does not have yet,
-- sets `source` (the CSV) and `day`, runs this script, and keeps every table
-- named under `tables` as <day>/<table>.parquet. gateway/recordings/ais-denmark/
-- holds the same tables with no rows (recorder/make-empty.sh).
--
-- The analysis is the one MovingPandas, Trackintel and scikit-mobility do,
-- in SQL: positions thinned to one every 30 s, stops where a ship lay still
-- for half an hour (MovingPandas' stop detector, with speed for diameter),
-- trips between them (Trackintel's staypoints and triplegs), places where
-- many ships stop (its locations, on an H3 grid), and encounters as Global
-- Fishing Watch defines them, with its thresholds scaled to one day.
--
-- A day is read on its own: a stop or trip across midnight is cut there, and
-- says so in cut_start and cut_end.
--
-- source: http://feeds/dma-ais/aisdk-{day}.zip
-- schedule: daily
-- tables: vessels tracks stops trips encounters cells

CREATE OR REPLACE TEMP MACRO dist_m(lat1, lon1, lat2, lon2) AS
  2 * 6371008.8 * asin(sqrt(
    pow(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));

-- Ships only (Class A and B, not base stations), inside the network's waters,
-- one position per ship every 30 s.
CREATE OR REPLACE TEMP TABLE heard AS
SELECT
  mmsi,
  time_bucket(INTERVAL 30 SECOND, "timestamp") AS ts,
  arg_min(latitude, "timestamp") AS lat,
  arg_min(longitude, "timestamp") AS lon,
  arg_min(sog, "timestamp") AS sog,
  arg_min(cog, "timestamp") AS cog,
  arg_min(navigational_status, "timestamp") AS nav
FROM read_csv(getvariable('source'), header = true, normalize_names = true,
              timestampformat = '%d/%m/%Y %H:%M:%S',
              types = {'timestamp': 'TIMESTAMP', 'mmsi': 'BIGINT', 'latitude': 'DOUBLE', 'longitude': 'DOUBLE',
                       'sog': 'DOUBLE', 'cog': 'DOUBLE', 'width': 'DOUBLE', 'length': 'DOUBLE',
                       'draught': 'DOUBLE'})
WHERE type_of_mobile IN ('Class A', 'Class B')
  AND latitude BETWEEN 53 AND 59.5 AND longitude BETWEEN 2 AND 17
  AND "timestamp"::DATE = getvariable('day')
  -- A ship's MMSI starts with its flag's digits, 2 to 7: not search and rescue
  -- aircraft (111...), fishing net buoys, beacons or aids to navigation.
  AND mmsi BETWEEN 200000000 AND 799999999
GROUP BY ALL;

-- What each ship says about itself, the most common value of the day.
CREATE OR REPLACE TEMP TABLE vessels AS
WITH said AS (
  SELECT
    mmsi,
    any_value(type_of_mobile) AS class,
    mode(nullif(_name, '')) AS name,
    mode(nullif(imo, 'Unknown')) AS imo,
    mode(nullif(callsign, 'Unknown')) AS callsign,
    mode(nullif(nullif(ship_type, 'Undefined'), '')) AS ship_type,
    mode(nullif(cargo_type, '')) AS cargo_type,
    max(length) AS length_m,
    max(width) AS width_m,
    max(draught) AS draught_m,
    mode(nullif(nullif(destination, 'Unknown'), '')) AS destination
  FROM read_csv(getvariable('source'), header = true, normalize_names = true,
                timestampformat = '%d/%m/%Y %H:%M:%S',
                types = {'timestamp': 'TIMESTAMP', 'mmsi': 'BIGINT', 'latitude': 'DOUBLE', 'longitude': 'DOUBLE',
                         'sog': 'DOUBLE', 'cog': 'DOUBLE', 'width': 'DOUBLE', 'length': 'DOUBLE',
                         'draught': 'DOUBLE'})
  WHERE type_of_mobile IN ('Class A', 'Class B') AND mmsi IN (SELECT DISTINCT mmsi FROM heard)
  GROUP BY mmsi
)
SELECT
  said.*,
  CASE
    WHEN ship_type = 'Cargo' THEN 'Cargo'
    WHEN ship_type = 'Tanker' THEN 'Tanker'
    WHEN ship_type IN ('Passenger', 'HSC') THEN 'Passenger'
    WHEN ship_type = 'Fishing' THEN 'Fishing'
    WHEN ship_type IN ('Pleasure', 'Sailing') THEN 'Leisure'
    WHEN ship_type IN ('Tug', 'Towing', 'Towing long/wide', 'Pilot', 'SAR', 'Port tender', 'Dredging',
                       'Law enforcement', 'Anti-pollution', 'Diving', 'Military', 'Medical') THEN 'Service'
    ELSE 'Other'
  END AS kind,
  getvariable('day') AS day
FROM said;

-- The positions, without the GPS fixes no ship could reach: one that a ship
-- would have had to sail to and back from at over 50 knots. Each ship's speed
-- is smoothed over two minutes: a ship lies still when that is under half a
-- knot.
CREATE OR REPLACE TEMP TABLE pts AS
WITH stepped AS (
  SELECT *,
    dist_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon)
      / nullif(epoch(ts - lag(ts) OVER w), 0) * 1.943844 AS in_kn,
    dist_m(lat, lon, lead(lat) OVER w, lead(lon) OVER w)
      / nullif(epoch(lead(ts) OVER w - ts), 0) * 1.943844 AS out_kn
  FROM heard
  WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
),
kept AS (
  SELECT * EXCLUDE (in_kn, out_kn) FROM stepped
  WHERE NOT (coalesce(in_kn, 0) > 50 AND coalesce(out_kn, 0) > 50)
    AND NOT (in_kn IS NULL AND out_kn > 50) AND NOT (out_kn IS NULL AND in_kn > 50)
),
restepped AS (
  SELECT *,
    coalesce(sog, dist_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon)
                  / nullif(epoch(ts - lag(ts) OVER w), 0) * 1.943844) AS kn
  FROM kept
  WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
)
SELECT * EXCLUDE (kn),
  median(kn) OVER (PARTITION BY mmsi ORDER BY ts ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) < 0.5 AS still
FROM restepped;

-- Stops: half an hour or more still. Runs a short move apart (under 15 min and
-- 500 m) are one stop: a ship shifting along a quay has not left it.
CREATE OR REPLACE TEMP TABLE runs AS
WITH flagged AS (
  SELECT *,
    CASE WHEN still IS DISTINCT FROM lag(still) OVER w OR ts - lag(ts) OVER w > INTERVAL 2 HOUR THEN 1 ELSE 0 END AS new_run
  FROM pts
  WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
),
marked AS (
  SELECT *, sum(new_run) OVER (PARTITION BY mmsi ORDER BY ts ROWS UNBOUNDED PRECEDING) AS run FROM flagged
)
SELECT mmsi, run, min(ts) AS start_ts, max(ts) AS end_ts, median(lat) AS lat, median(lon) AS lon,
       count(*) AS n, mode(nav) AS nav
FROM marked WHERE still
GROUP BY mmsi, run
HAVING max(ts) - min(ts) >= INTERVAL 5 MINUTE;

CREATE OR REPLACE TEMP TABLE stops AS
WITH flagged AS (
  SELECT *,
    CASE WHEN start_ts - lag(end_ts) OVER w <= INTERVAL 15 MINUTE
          AND dist_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon) <= 500 THEN 0 ELSE 1 END AS new_stop
  FROM runs
  WINDOW w AS (PARTITION BY mmsi ORDER BY start_ts)
),
joined AS (
  SELECT *, sum(new_stop) OVER (PARTITION BY mmsi ORDER BY start_ts ROWS UNBOUNDED PRECEDING) AS stop_no FROM flagged
),
merged AS (
  SELECT mmsi, stop_no, min(start_ts) AS start_ts, max(end_ts) AS end_ts,
         sum(lat * n) / sum(n) AS lat, sum(lon * n) / sum(n) AS lon, mode(nav) AS nav
  FROM joined GROUP BY mmsi, stop_no
  HAVING max(end_ts) - min(start_ts) >= INTERVAL 30 MINUTE
),
bounds AS (
  SELECT mmsi, min(ts) AS first_ts, max(ts) AS last_ts FROM pts GROUP BY mmsi
)
SELECT
  m.mmsi || '-' || strftime(m.start_ts, '%Y%m%dT%H%M') AS stop_id,
  m.mmsi, m.start_ts, m.end_ts,
  round(epoch(m.end_ts - m.start_ts) / 60)::INTEGER AS minutes,
  m.lat, m.lon,
  (SELECT max(dist_m(m.lat, m.lon, p.lat, p.lon)) FROM pts p
   WHERE p.mmsi = m.mmsi AND p.ts BETWEEN m.start_ts AND m.end_ts)::INTEGER AS radius_m,
  CASE m.nav WHEN 'Moored' THEN 'Moored' WHEN 'At anchor' THEN 'At anchor' ELSE 'Stopped' END AS how,
  h3_latlng_to_cell(m.lat, m.lon, 7) AS place,
  m.start_ts <= b.first_ts + INTERVAL 10 MINUTE AND m.start_ts < getvariable('day')::TIMESTAMP + INTERVAL 10 MINUTE AS cut_start,
  m.end_ts >= b.last_ts - INTERVAL 10 MINUTE AND m.end_ts >= getvariable('day')::TIMESTAMP + INTERVAL '23 hours 50 minutes' AS cut_end
FROM merged m JOIN bounds b USING (mmsi);

-- Trips: what lies between two stops, or between a stop and the edge of the
-- day, broken where a ship went unheard for two hours. Under a kilometre is
-- no trip.
CREATE OR REPLACE TEMP TABLE legs AS
WITH tagged AS (
  SELECT p.*, s.stop_id
  FROM pts p LEFT JOIN stops s ON p.mmsi = s.mmsi AND p.ts BETWEEN s.start_ts AND s.end_ts
),
flagged AS (
  SELECT *,
    CASE WHEN stop_id IS DISTINCT FROM lag(stop_id) OVER w
          OR ts - lag(ts) OVER w > INTERVAL 2 HOUR THEN 1 ELSE 0 END AS new_seg,
    dist_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon) AS step_m
  FROM tagged
  WINDOW w AS (PARTITION BY mmsi ORDER BY ts)
)
SELECT * EXCLUDE (new_seg),
  sum(new_seg) OVER (PARTITION BY mmsi ORDER BY ts ROWS UNBOUNDED PRECEDING) AS seg
FROM flagged;

CREATE OR REPLACE TEMP TABLE trips AS
WITH t AS (
  SELECT mmsi, seg, min(ts) AS start_ts, max(ts) AS end_ts,
         -- The first step comes from outside the trip: from the stop, or across the gap.
         sum(step_m) - coalesce(arg_min(step_m, ts), 0) AS dist,
         max(sog) AS max_sog, count(*) AS n,
         arg_min(lat, ts) AS start_lat, arg_min(lon, ts) AS start_lon,
         arg_max(lat, ts) AS end_lat, arg_max(lon, ts) AS end_lon
  FROM legs WHERE stop_id IS NULL
  GROUP BY mmsi, seg
  HAVING count(*) >= 3
),
bounds AS (SELECT mmsi, min(ts) AS first_ts, max(ts) AS last_ts FROM pts GROUP BY mmsi)
SELECT
  t.mmsi || '-' || strftime(t.start_ts, '%Y%m%dT%H%M') AS trip_id,
  t.mmsi, t.seg, t.start_ts, t.end_ts,
  round(epoch(t.end_ts - t.start_ts) / 60)::INTEGER AS minutes,
  round(t.dist / 1000, 2) AS km,
  round(t.dist / 1852 / nullif(epoch(t.end_ts - t.start_ts) / 3600, 0), 1) AS avg_kn,
  t.max_sog AS max_kn,
  t.start_lat, t.start_lon, t.end_lat, t.end_lon,
  (SELECT s.place FROM stops s WHERE s.mmsi = t.mmsi AND s.end_ts <= t.start_ts ORDER BY s.end_ts DESC LIMIT 1) AS from_place,
  (SELECT s.place FROM stops s WHERE s.mmsi = t.mmsi AND s.start_ts >= t.end_ts ORDER BY s.start_ts LIMIT 1) AS to_place,
  t.start_ts <= b.first_ts AND t.start_ts < getvariable('day')::TIMESTAMP + INTERVAL 10 MINUTE AS cut_start,
  t.end_ts >= b.last_ts AND t.end_ts >= getvariable('day')::TIMESTAMP + INTERVAL '23 hours 50 minutes' AS cut_end
FROM t JOIN bounds b USING (mmsi)
WHERE t.dist >= 1000
  -- Faster on average than the ship ever said it went: positions still astray.
  AND (t.max_sog IS NULL OR t.dist / 1852 / nullif(epoch(t.end_ts - t.start_ts) / 3600, 0) <= t.max_sog + 5);

-- The positions as the map draws them, each with its trip or its stop.
CREATE OR REPLACE TEMP TABLE tracks AS
SELECT l.mmsi, l.ts, round(l.lat, 6) AS lat, round(l.lon, 6) AS lon, l.sog, l.cog, l.nav,
       v.kind, t.trip_id, l.stop_id
FROM legs l
JOIN vessels v USING (mmsi)
LEFT JOIN trips t ON t.mmsi = l.mmsi AND t.seg = l.seg AND l.stop_id IS NULL
ORDER BY v.kind, l.mmsi, l.ts;

-- Encounters, after Global Fishing Watch: two ships within 500 m of each other,
-- both under 2 knots, for an hour or more, away from ports and anchorages. A
-- port or anchorage here is where five ships stopped that day within a cell
-- and the ring around it, and two rings more; and a ship moored, or still
-- within 30 m (made fast to a quay, whatever it says), is in port anywhere.
-- GFW's minimum is two hours, over months; one day gives fewer chances.
CREATE OR REPLACE TEMP TABLE encounters AS
WITH stopped AS (
  SELECT DISTINCT unnest(h3_grid_disk(place, 1)) AS cell, mmsi FROM stops
),
harbours AS (
  SELECT DISTINCT unnest(h3_grid_disk(cell, 2)) AS cell
  FROM stopped GROUP BY cell HAVING count(DISTINCT mmsi) >= 5
),
docked AS (
  SELECT mmsi, start_ts, end_ts FROM stops WHERE how = 'Moored' OR radius_m < 30
),
slow AS (
  SELECT p.mmsi, time_bucket(INTERVAL 1 MINUTE, p.ts) AS minute,
         avg(p.lat) AS lat, avg(p.lon) AS lon
  FROM pts p
  ANTI JOIN docked d ON p.mmsi = d.mmsi AND p.ts BETWEEN d.start_ts AND d.end_ts
  WHERE p.sog < 2 AND p.nav IS DISTINCT FROM 'Moored'
  GROUP BY ALL
),
slow_cells AS (
  SELECT *, h3_latlng_to_cell(lat, lon, 8) AS cell8
  FROM slow
  WHERE h3_cell_to_parent(h3_latlng_to_cell(lat, lon, 8), 7) NOT IN (SELECT cell FROM harbours)
),
near AS (
  SELECT a.mmsi AS mmsi_a, b.mmsi AS mmsi_b, a.minute,
         (a.lat + b.lat) / 2 AS lat, (a.lon + b.lon) / 2 AS lon,
         dist_m(a.lat, a.lon, b.lat, b.lon) AS gap_m
  FROM slow_cells a
  JOIN (SELECT *, unnest(h3_grid_disk(cell8, 1)) AS nb FROM slow_cells) b
    ON a.minute = b.minute AND a.cell8 = b.nb AND a.mmsi < b.mmsi
  WHERE dist_m(a.lat, a.lon, b.lat, b.lon) <= 500
),
flagged AS (
  SELECT *,
    CASE WHEN minute - lag(minute) OVER (PARTITION BY mmsi_a, mmsi_b ORDER BY minute) <= INTERVAL 10 MINUTE
         THEN 0 ELSE 1 END AS new_ep
  FROM near
),
episodes AS (
  SELECT *, sum(new_ep) OVER (PARTITION BY mmsi_a, mmsi_b ORDER BY minute ROWS UNBOUNDED PRECEDING) AS ep
  FROM flagged
)
SELECT
  e.mmsi_a || '-' || e.mmsi_b || '-' || strftime(min(e.minute), '%Y%m%dT%H%M') AS encounter_id,
  e.mmsi_a, e.mmsi_b, min(e.minute) AS start_ts, max(e.minute) AS end_ts,
  round(epoch(max(e.minute) - min(e.minute)) / 60)::INTEGER AS minutes,
  avg(e.lat) AS lat, avg(e.lon) AS lon,
  min(e.gap_m)::INTEGER AS closest_m, median(e.gap_m)::INTEGER AS median_m,
  va.kind AS kind_a, vb.kind AS kind_b,
  va.kind = 'Service' OR vb.kind = 'Service' AS with_service
FROM episodes e
JOIN vessels va ON va.mmsi = e.mmsi_a
JOIN vessels vb ON vb.mmsi = e.mmsi_b
GROUP BY e.mmsi_a, e.mmsi_b, e.ep, va.kind, vb.kind
HAVING max(e.minute) - min(e.minute) >= INTERVAL 1 HOUR AND count(*) >= 30;

-- How busy the water was: hours of ship presence per H3 cell (resolution 7,
-- about 5 km2), hour and kind of ship. A position counts until the next one,
-- five minutes at most. Hours add up across cells, hours, kinds and days.
CREATE OR REPLACE TEMP TABLE cells AS
WITH held AS (
  SELECT p.mmsi, p.ts, h3_latlng_to_cell(p.lat, p.lon, 7) AS cell, v.kind,
         least(coalesce(epoch(lead(p.ts) OVER (PARTITION BY p.mmsi ORDER BY p.ts) - p.ts), 30), 300) AS secs
  FROM pts p JOIN vessels v USING (mmsi)
)
SELECT time_bucket(INTERVAL 1 HOUR, ts) AS hour, cell, kind,
       round(sum(secs) / 3600, 3) AS ship_hours, count(DISTINCT mmsi) AS ships
FROM held
GROUP BY ALL
ORDER BY hour, kind, cell;
