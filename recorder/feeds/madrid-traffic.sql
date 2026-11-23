-- What every traffic measuring point of Madrid's City Council reads, every five minutes, as Informo
-- (informo.madrid.es) publishes it: the feed behind madrid-live's Time Brush, which replays the day.
--
-- Informo keeps no history: this recording is the history, from the hour the recorder first ran it.
-- The source is one XML file of about 2.2 MB through the gateway (/madrid/informo/pm.xml), which
-- Informo rewrites every five minutes: a <pm> per measuring point (about 4,900: loops under the
-- street, and on the M-30 ring road radar with a speed), and the file's <fecha_hora>, Madrid's
-- local time. Read every minute, so each new file is kept within a minute of its writing; `hex` is
-- the point's number (idelem), as the recorder names a row's object, so a poll that finds the file
-- unchanged writes nothing. About 4,900 rows a poll, 1.4 million a day.
--
-- Where each point stands is left out: it does not change from one file to the next, and
-- madrid-live reads it from the live file.
--
-- The data: Ayuntamiento de Madrid, "Tráfico. Datos en tiempo real" (datos.madrid.es, dataset
-- 202087), under the portal's terms (free use with attribution).
--
-- source: http://feeds/madrid/informo/pm.xml
-- interval: 60
-- order: hex, ts

WITH feed AS (
  SELECT content AS xml FROM read_text(getvariable('source'))
),
pm AS (
  SELECT unnest(regexp_extract_all(xml, '(?s)<pm>.*?</pm>')) AS x,
         -- 23/11/2026 19:05:02, Madrid's time; kept in UTC.
         strptime(regexp_extract(xml, '<fecha_hora>([^<]*)</fecha_hora>', 1), '%d/%m/%Y %H:%M:%S')::TIMESTAMP
           AT TIME ZONE 'Europe/Madrid' AS ts
  FROM feed
)
SELECT ts,
       regexp_extract(x, '<idelem>([^<]*)</idelem>', 1) AS hex,
       -- Vehicles an hour. Informo writes -1 for a reading it has not got: kept null, here and below.
       nullif(TRY_CAST(regexp_extract(x, '<intensidad>([^<]*)</intensidad>', 1) AS INTEGER), -1) AS intensity,
       -- Share of the time a vehicle is over the loop, and the load Informo works out from it and
       -- the intensity against the point's capacity: both 0-100.
       nullif(TRY_CAST(regexp_extract(x, '<ocupacion>([^<]*)</ocupacion>', 1) AS SMALLINT), -1) AS occupancy,
       nullif(TRY_CAST(regexp_extract(x, '<carga>([^<]*)</carga>', 1) AS SMALLINT), -1) AS load,
       -- Informo's level of service: 0 flowing, 1 slow, 2 queues, 3 jammed; -1 (unknown) kept null.
       nullif(TRY_CAST(regexp_extract(x, '<nivelServicio>([^<]*)</nivelServicio>', 1) AS SMALLINT), -1) AS level,
       -- km/h, on the M-30's radar points only.
       nullif(TRY_CAST(nullif(regexp_extract(x, '<velocidad>([^<]*)</velocidad>', 1), '') AS SMALLINT), -1) AS speed,
       -- Informo flags a point whose reading it does not trust (error S).
       regexp_extract(x, '<error>([^<]*)</error>', 1) = 'S' AS faulty
FROM pm
WHERE ts IS NOT NULL
