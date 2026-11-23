-- The hourly readings of Madrid's weather stations, as the City Council publishes them in real time:
-- the feed behind madrid-live's weather history (the buildings coloured by temperature).
--
-- The source (ciudadesabiertas.madrid.es, meteo_tiemporeal, through the gateway at
-- /madrid/meteo/realtime.json, about 90 KB) holds only today, in the air quality file's shape
-- (recorder/feeds/madrid-air.sql): a record per station and quantity with
-- 24 hourly values H01..H24 and a flag each (V valid, N not yet measured or not valid). H01 is the hour
-- from 00:00 to 01:00, Madrid's time; a reading here is stamped with its hour's end (`hour`).
--
-- The file has no memory of yesterday, so this keeps it. The city publishes an hour some seventy
-- minutes after its end, later than the recorder remembers what it has written (an hour), so a row's
-- `ts` is not the reading's hour but the clock hour it was kept in: each clock hour, the last three
-- valid hours of each station's quantity are written once (`hex` is the station, the quantity and the
-- hour, 102_83@2026-11-23T17:00:00Z: station 102, temperature; the file names no sampling point). A
-- reading is so kept up to three times: a reader takes DISTINCT hour, station, magnitude, value. About
-- 280 rows an hour.
--
-- Quantities by Madrid's magnitude code: 81 wind speed (m/s), 82 wind direction (degrees, where it
-- blows from), 83 temperature (°C), 86 relative humidity (%), 87 pressure (mb), 88 solar radiation
-- (W/m2), 89 precipitation (l/m2).
--
-- The data: Ayuntamiento de Madrid, "Datos meteorológicos. Datos en tiempo real" (datos.madrid.es,
-- dataset 300392), under the portal's terms (free use with attribution).
--
-- source: http://feeds/madrid/meteo/realtime.json
-- interval: 300
-- order: hex, ts

WITH rec AS (
  -- The records as JSON, so a file with none still reads (as no rows).
  SELECT unnest(records) AS r
  FROM read_json(getvariable('source'), columns = {records: 'JSON[]'}, maximum_object_size = 16777216)
),
hours AS (
  SELECT (r->>'ESTACION') || '_' || (r->>'MAGNITUD') AS point,
         TRY_CAST(r->>'ESTACION' AS INTEGER) AS station,
         TRY_CAST(r->>'MAGNITUD' AS INTEGER) AS magnitude,
         make_date(TRY_CAST(r->>'ANO' AS INTEGER), TRY_CAST(r->>'MES' AS INTEGER), TRY_CAST(r->>'DIA' AS INTEGER)) AS day,
         h,
         TRY_CAST(r->>printf('H%02d', h) AS DOUBLE) AS value,
         r->>printf('V%02d', h) AS flag
  FROM rec, range(1, 25) t(h)
),
valid AS (
  SELECT point, (day::TIMESTAMP + to_hours(h)) AT TIME ZONE 'Europe/Madrid' AS hour, station, magnitude, value
  FROM hours
  WHERE flag = 'V' AND value IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY point ORDER BY h DESC) <= 3
)
SELECT date_trunc('hour', now()) AS ts,
       point || '@' || strftime(hour AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS hex,
       hour, station, magnitude, value
FROM valid
