-- One station's daily east, north and up position, in millimetres from the
-- processing reference (absolute, so a panel subtracts the value at the start
-- of its own window). A component the source flags as an outlier that day is
-- NULL, so it drops out of every median the dashboard takes.
--
-- So is a day more than 10 cm off the median of the two months around it (30
-- days each side): the source leaves a few runs of metres-off days unflagged
-- (PORT in June 2026, about two weeks of them), short enough for that median to
-- stay with the good days. A real jump survives, an earthquake's included: it
-- lasts, so on the days after it most of the window is after it too.
--
-- Run by build.sh once per station, which sets `src` to the station's JSON;
-- it writes part.parquet, and build.sh joins the stations into one file.
-- Each component is turned into a map from day to {value, outlier} in one pass:
-- looking each day up by key instead is quadratic in the length of the record.
COPY (
  WITH f AS (
    SELECT data -> 'properties' AS p, data -> 'graphs' AS g
    FROM read_json(getvariable('src'), columns = {data: 'JSON'}, maximum_object_size = 64000000)
  ),
  comp AS (
    SELECT p ->> 'id' AS id, 'east' AS k, unnest(map_entries(CAST(g -> 'east' AS MAP(VARCHAR, STRUCT(value DOUBLE, outlier INTEGER))))) AS m FROM f
    UNION ALL
    SELECT p ->> 'id', 'north', unnest(map_entries(CAST(g -> 'north' AS MAP(VARCHAR, STRUCT(value DOUBLE, outlier INTEGER))))) FROM f
    UNION ALL
    SELECT p ->> 'id', 'up', unnest(map_entries(CAST(g -> 'up' AS MAP(VARCHAR, STRUCT(value DOUBLE, outlier INTEGER))))) FROM f
  ),
  daily AS (
    SELECT id, m.key::TIMESTAMP AS day, k,
           CASE WHEN coalesce(m.value.outlier, 0) = 0 THEN round(m.value.value * 1000, 1) END AS mm
    FROM comp
  ),
  checked AS (
    SELECT id, day, k,
           CASE WHEN abs(mm - median(mm) OVER (PARTITION BY k ORDER BY day
                       RANGE BETWEEN INTERVAL 30 DAYS PRECEDING AND INTERVAL 30 DAYS FOLLOWING)) <= 100
                THEN mm END AS mm
    FROM daily
  )
  SELECT
    d.id,
    (SELECT (p ->> 'y_location')::DOUBLE FROM f) AS latitude,
    (SELECT (p ->> 'x_location')::DOUBLE FROM f) AS longitude,
    d.day,
    max(mm) FILTER (WHERE k = 'east') AS east_mm,
    max(mm) FILTER (WHERE k = 'north') AS north_mm,
    max(mm) FILTER (WHERE k = 'up') AS up_mm
  FROM checked d
  GROUP BY d.id, d.day
  ORDER BY d.day
) TO 'part.parquet' (FORMAT parquet);
