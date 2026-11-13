-- What each antenna of NASA's Deep Space Network is doing, as DSN Now (eyes.nasa.gov) says it every few
-- seconds: where it points, the spacecraft it talks to and the signals going up and coming down. The feed
-- behind deep-space-network's Time Brush, which replays the antennas turning.
--
-- DSN Now keeps no history: this recording is the history, from the hour the recorder first ran it. The
-- source is one XML file of about 7 KB through the gateway (/dsn/dsn.xml, kept 5 s), read every 30 s: a
-- <dish> for each antenna at work (an antenna it leaves out is idle), its <target>s and signals inside, and
-- the file's <timestamp>. A row per antenna per poll, stamped with DSN Now's time; `hex` is the antenna
-- (DSS26), as the recorder names a row's object, so a poll that finds the feed unchanged writes nothing.
-- About 15 rows a poll, 40,000 a day.
--
-- source: http://feeds/dsn/dsn.xml
-- interval: 30
-- order: hex, ts

WITH feed AS (
  SELECT content AS xml FROM read_text(getvariable('source'))
),
dish AS (
  SELECT x, regexp_extract(x, '<dish [^>]*>') AS tag,
         to_timestamp(TRY_CAST(regexp_extract(xml, '<timestamp>([0-9]+)</timestamp>', 1) AS BIGINT) / 1000) AS ts
  FROM (SELECT xml, unnest(regexp_extract_all(xml, '(?s)<dish [^>]*>.*?</dish>')) AS x FROM feed)
)
SELECT ts,
       regexp_extract(tag, ' name="([^"]*)"', 1) AS hex,
       TRY_CAST(regexp_extract(tag, 'azimuthAngle="([^"]*)"', 1) AS DOUBLE) AS azimuth,
       TRY_CAST(regexp_extract(tag, 'elevationAngle="([^"]*)"', 1) AS DOUBLE) AS elevation,
       TRY_CAST(regexp_extract(tag, 'windSpeed="([^"]*)"', 1) AS DOUBLE) AS wind,
       regexp_extract(tag, 'activity="([^"]*)"', 1) AS activity,
       -- The spacecraft, comma-separated (several around Mars); DSN and DSS are the network itself.
       array_to_string(list_filter(regexp_extract_all(x, '<target name="([^"]*)"', 1),
                                   t -> t NOT IN ('DSN', 'DSS', '')), ',') AS targets,
       -- Each antenna's fastest signal coming down (bits/s) and its strongest going up (kW); null with none active.
       list_max(list_transform(regexp_extract_all(x, '<downSignal [^>]*active="true"[^>]*dataRate="([^"]*)"', 1),
                               v -> TRY_CAST(v AS DOUBLE))) AS down_bps,
       list_max(list_transform(regexp_extract_all(x, '<upSignal [^>]*active="true"[^>]*power="([^"]*)"', 1),
                               v -> TRY_CAST(v AS DOUBLE))) AS up_kw,
       nullif(regexp_extract(x, '<downSignal [^>]*active="true"[^>]*band="([^"]*)"', 1), '') AS band,
       -- Km and seconds; DSN Now writes -1 for none.
       nullif(list_max(list_transform(regexp_extract_all(x, '<target [^>]*downlegRange="([^"]*)"', 1),
                                      v -> TRY_CAST(v AS DOUBLE))), -1) AS range_km,
       nullif(list_max(list_transform(regexp_extract_all(x, '<target [^>]*rtlt="([^"]*)"', 1),
                                      v -> TRY_CAST(v AS DOUBLE))), -1) AS rtlt_s
FROM dish
WHERE ts IS NOT NULL
