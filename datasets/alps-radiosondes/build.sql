-- What alps-weather-balloons draws: a week of radiosondes from six launch sites round the Alps, as
-- amateur receivers heard them and SondeHub keeps them (history.sondehub.org, CC BY-SA 2.0).
-- Run by build.sh in a scratch folder; writes sites.parquet, flights.parquet and frames.parquet there.

-- The six sites, where SondeHub places them (api.v2.sondehub.org/sites): two launches a day, about
-- 23:15 and 11:15 UTC for the soundings of 00 and 12 UTC, and one at about 03:15 UTC in Innsbruck.
-- All six fly Vaisala RS41 sondes. Ljubljana is left out: its Meteomodem M20s are numbered one way by
-- one decoder and another way by the next, so their frames cannot be matched.
CREATE TABLE sites AS
SELECT * FROM (VALUES
  ('06610', 'Payerne', 'Switzerland', 46.8117, 6.9425, 490),
  ('10868', 'München', 'Germany', 48.2442, 11.5525, 484),
  ('11120', 'Innsbruck', 'Austria', 47.2603, 11.3439, 581),
  ('16045', 'Udine', 'Italy', 45.9806, 13.0592, 51),
  ('16064', 'Novara', 'Italy', 45.52, 8.67, 178),
  ('16113', 'Cuneo', 'Italy', 44.5386, 7.6125, 386)
) t(site, site_name, country, site_latitude, site_longitude, site_altitude);

-- The archive lists each site's flights by the day it heard them, launchsites/<site>/<y>/<m>/<d>/<serial>.json
-- (a flight over midnight under both days).
SET VARIABLE listings = (
  SELECT list('https://history.sondehub.org/?list-type=2&prefix=launchsites/' || site || '/2026/11/') FROM sites
);
CREATE TABLE listed AS
SELECT site, serial, min(day) AS day
FROM (
  SELECT regexp_extract(k, '^launchsites/([^/]+)/', 1) AS site,
         regexp_extract(k, '/([^/]+)\.json$', 1) AS serial,
         strptime(regexp_extract(k, '/(\d{4}/\d{2}/\d{2})/', 1), '%Y/%m/%d')::DATE AS day
  FROM (SELECT unnest(regexp_extract_all(content, '<Key>([^<]+)</Key>', 1)) AS k
        FROM read_text(getvariable('listings')))
)
WHERE day BETWEEN DATE '2026-11-08' AND DATE '2026-11-14'
GROUP BY site, serial;

-- Every frame each receiver uploaded: a sonde sends one a second, and a frame heard by twenty stations
-- is there twenty times. Only what the dashboard uses: no receiver's name or place.
SET VARIABLE flights = (SELECT list('https://history.sondehub.org/serial/' || serial || '.json.gz') FROM listed);
CREATE TABLE raw AS
SELECT serial, frame, datetime, lat, lon, alt, vel_v, vel_h, heading, temp
FROM read_json(getvariable('flights'),
  columns = {serial: 'VARCHAR', frame: 'BIGINT', datetime: 'TIMESTAMPTZ', lat: 'DOUBLE', lon: 'DOUBLE',
             alt: 'DOUBLE', vel_v: 'DOUBLE', vel_h: 'DOUBLE', heading: 'DOUBLE', temp: 'DOUBLE', type: 'VARCHAR'})
WHERE type = 'RS41' AND lat IS NOT NULL AND lon IS NOT NULL AND alt BETWEEN -500 AND 50000;

-- One row a frame. The copies agree on the place (to 0.001° and 50 m in every flight checked), and an
-- RS41 counts its frames once a second; the decoders' clocks do not agree to the second, so a frame's
-- time is the flight's own: the median of time minus frame number over the flight, plus the frame.
-- The temperature is the median of the copies (decoders differ by a tenth or two). A few frames carry
-- a GPS velocity of 250 m/s at 4 km between good ones: velocities over 150 m/s are dropped, the place kept.
-- A sonde also sends from its pad before it goes (up to half an hour) and from the ground once it has
-- landed (up to ten hours, where a receiver is near): each flight runs from the last frame within 30 m of
-- its lowest point before the top to the first within 30 m of its lowest point after it, or to the last
-- frame before ten minutes of silence on the way down (one was lost at 2 km and heard on the ground hours on).
CREATE TABLE frames AS
WITH clock AS (
  SELECT serial, round(median(epoch(datetime) - frame)) AS offset_s FROM raw GROUP BY serial
), f AS (
  SELECT serial, frame,
         round(median(lat), 6) AS latitude, round(median(lon), 6) AS longitude, round(median(alt), 1) AS altitude,
         round(median(vel_v), 2) AS rise, round(median(vel_h), 2) AS wind, round(any_value(heading), 1) AS heading,
         round(median(temp), 1) AS temperature
  FROM raw GROUP BY serial, frame
), t AS (
  SELECT l.site, f.serial, f.frame, to_timestamp(c.offset_s + f.frame) AS time,
         f.latitude, f.longitude, f.altitude,
         CASE WHEN f.wind <= 150 THEN f.rise END AS rise,
         CASE WHEN f.wind <= 150 THEN f.wind END AS wind,
         CASE WHEN f.wind <= 150 THEN f.heading END AS heading,
         f.temperature
  FROM f JOIN clock c USING (serial) JOIN listed l USING (serial)
), top AS (
  SELECT *, time <= arg_max(time, altitude) OVER (PARTITION BY serial) AS up FROM t
), lows AS (
  SELECT *, min(CASE WHEN up THEN altitude END) OVER (PARTITION BY serial) AS low_before,
            min(CASE WHEN NOT up THEN altitude END) OVER (PARTITION BY serial) AS low_after,
            epoch(lead(time) OVER (PARTITION BY serial ORDER BY frame) - time) AS silence
  FROM top
), ends AS (
  SELECT serial, max(time) FILTER (WHERE up AND altitude <= low_before + 30) AS launch,
         least(min(time) FILTER (WHERE NOT up AND altitude <= low_after + 30),
               min(time) FILTER (WHERE NOT up AND silence > 600), max(time)) AS landing
  FROM lows GROUP BY serial
)
SELECT t.* FROM t JOIN ends USING (serial)
WHERE t.time BETWEEN ends.launch AND ends.landing
ORDER BY t.serial, t.frame;

-- One row a flight: when it was heard, how high it went, where it went (its box), how far it drifted, and on the way up its
-- coldest air and its strongest wind (after the burst the sonde tumbles down under its parachute, and
-- its speed is no longer the wind's). path_km follows the frames on the ground; drift_km is from the
-- site to the last frame heard.
CREATE TABLE flights AS
WITH steps AS (
  SELECT *, 2 * 6371 * asin(sqrt(
           power(sin(radians(latitude - lag(latitude) OVER w) / 2), 2) +
           cos(radians(latitude)) * cos(radians(lag(latitude) OVER w)) *
           power(sin(radians(longitude - lag(longitude) OVER w) / 2), 2))) AS step_km,
         time <= arg_max(time, altitude) OVER (PARTITION BY serial) AS rising
  FROM frames WINDOW w AS (PARTITION BY serial ORDER BY frame)
)
SELECT f.serial, f.site, s.site_name, s.country, l.day,
       min(f.time) AS first_heard, max(f.time) AS last_heard, count(*) AS frames,
       round(arg_min(f.altitude, f.frame)) AS first_altitude,
       round(max(f.altitude)) AS top_altitude, arg_max(f.time, f.altitude) AS top_time,
       round(arg_max(f.altitude, f.frame)) AS last_altitude,
       arg_max(f.latitude, f.frame) AS last_latitude, arg_max(f.longitude, f.frame) AS last_longitude,
       min(f.latitude) AS south, max(f.latitude) AS north, min(f.longitude) AS west, max(f.longitude) AS east,
       round(coalesce(sum(f.step_km), 0), 1) AS path_km,
       round(2 * 6371 * asin(sqrt(
         power(sin(radians(arg_max(f.latitude, f.frame) - s.site_latitude) / 2), 2) +
         cos(radians(s.site_latitude)) * cos(radians(arg_max(f.latitude, f.frame))) *
         power(sin(radians(arg_max(f.longitude, f.frame) - s.site_longitude) / 2), 2))), 1) AS drift_km,
       min(f.temperature) FILTER (WHERE rising) AS coldest,
       round(arg_min(f.altitude, f.temperature) FILTER (WHERE rising)) AS coldest_altitude,
       max(f.wind) FILTER (WHERE rising) AS strongest_wind,
       round(arg_max(f.altitude, f.wind) FILTER (WHERE rising)) AS strongest_wind_altitude
FROM steps f JOIN sites s USING (site) JOIN listed l USING (serial)
GROUP BY f.serial, f.site, s.site_name, s.country, l.day, s.site_latitude, s.site_longitude
ORDER BY first_heard;

COPY sites TO 'sites.parquet' (FORMAT parquet);
COPY flights TO 'flights.parquet' (FORMAT parquet);
-- Row groups of about three flights, so a query for one flight reads a few of them.
COPY frames TO 'frames.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000);

SELECT count(*) AS flights, sum(frames) AS frames, min(first_heard) AS first, max(last_heard) AS last,
       round(max(top_altitude)) AS highest FROM flights;
