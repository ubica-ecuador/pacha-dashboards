-- The hourly readings of Madrid's 24 air quality stations, as the City Council publishes them in
-- real time: the feed behind madrid-live's air history.
--
-- The source (ciudadesabiertas.madrid.es, calair_tiemporeal, through the gateway at
-- /madrid/air/realtime.json, about 130 KB) holds only today: a record per station and pollutant with
-- 24 hourly values H01..H24 and a flag each (V valid, N not yet measured or not valid). H01 is the hour
-- from 00:00 to 01:00, Madrid's time; a reading here is stamped with its hour's end (`hour`).
--
-- The file has no memory of yesterday, so this keeps it. The city publishes an hour some seventy
-- minutes after its end, later than the recorder remembers what it has written (an hour), so a row's
-- `ts` is not the reading's hour but the clock hour it was kept in: each clock hour, the last three
-- valid hours of each station's pollutant are written once (`hex` is the sampling point and the hour,
-- 28079008_8_8@2026-11-23T17:00:00Z: station 8, NO2). A reading is so kept up to three times: a
-- reader takes DISTINCT hour, station, magnitude, value. About 380 rows an hour.
--
-- Pollutants by Madrid's magnitude code: 1 SO2, 6 CO (mg/m3), 7 NO, 8 NO2, 9 PM2.5, 10 PM10, 12 NOx,
-- 14 O3, 20 toluene, 30 benzene, 35 ethylbenzene; µg/m3 but CO.
--
-- The data: Ayuntamiento de Madrid, "Calidad del aire. Tiempo real" (datos.madrid.es, dataset
-- 212531), under the portal's terms (free use with attribution).
--
-- source: http://feeds/madrid/air/realtime.json
-- interval: 300
-- order: hex, ts

WITH rec AS (
  -- The records as JSON, so a file with none still reads (as no rows).
  SELECT unnest(records) AS r
  FROM read_json(getvariable('source'), columns = {records: 'JSON[]'}, maximum_object_size = 16777216)
),
hours AS (
  SELECT r->>'PUNTO_MUESTREO' AS point,
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
