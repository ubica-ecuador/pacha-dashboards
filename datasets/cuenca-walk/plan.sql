-- The plan (utopia.sql, then hub.sql once per hub), next to needs.parquet:
--
--   hubs.parquet    one row per hub, in the order they open: its cell and
--                   centre, the stop nearest that centre, to name it by, and
--                   the people it brings all six to
--   gained.parquet  one row per cell that reaches all six in a 10-minute walk
--                   only with the hubs: the cell and the hub that brings them

COPY (
  WITH hub AS (
    SELECT h.hub, h.px, h.py, h.people,
           round(degrees(atan(sinh(pi() * (1 - 2 * (h.py + 0.5) / 262144)))), 6) AS latitude,
           round((h.px + 0.5) / 262144 * 360 - 180, 6) AS longitude
    FROM hubs AS h
    WHERE h.people > 0
  ),
  stop AS (
    SELECT hub.hub, arg_min(n.name, (n.latitude - hub.latitude) ^ 2 + (n.longitude - hub.longitude) ^ 2) AS stop
    FROM hub, 'needs.parquet' AS n
    WHERE n.need = 'Transit'
    GROUP BY hub.hub
  )
  SELECT hub.hub, hub.px, hub.py, hub.latitude, hub.longitude, stop.stop,
         round(hub.people)::INTEGER AS people
  FROM hub
  JOIN stop USING (hub)
  ORDER BY hub.hub
) TO 'hubs.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT px, py, hub FROM done WHERE hub > 0 ORDER BY hub, py, px
) TO 'gained.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT count(*) AS hubs, sum(people) AS people,
       (SELECT count(*) FROM 'gained.parquet') AS cells
FROM 'hubs.parquet';
