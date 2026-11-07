-- walk.parquet, for cuenca-10-minute-city: one row per cell of R5's grid and
-- daily need within a 15-minute walk, with the minutes to its nearest place.
-- Run by build.sh in the folder the file is written to, next to needs.parquet;
-- it sets `raw`, R5's walks from each cell holding a need: one line per cell
-- reached, with the cell walked from (dpx, dpy), R5's whole minute and the
-- cell reached as hex WKB.

INSTALL spatial;
LOAD spatial;

CREATE MACRO px(lon) AS floor((lon + 180) / 360 * 262144)::INTEGER;
CREATE MACRO py(lat) AS floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 262144)::INTEGER;

-- On flat ground a walk takes as long one way as the other, so the minutes
-- from a need's cell to a cell are the minutes from that cell to the need.
-- R5 counts a cell within m minutes when it reaches it in less than m: its
-- whole minute plus one, as in cuenca-accessibility.
CREATE TABLE reach AS
SELECT dpx, dpy, px(ST_X(c)) AS px, py(ST_Y(c)) AS py, minutos + 1 AS minutes
FROM (
  SELECT dpx, dpy, minutos, ST_Centroid(ST_GeomFromHEXWKB(geom)) AS c
  FROM read_csv(getvariable('raw'), header = false,
                columns = {'dpx': 'INTEGER', 'dpy': 'INTEGER', 'minutos': 'INTEGER', 'geom': 'VARCHAR'})
)
UNION ALL
-- R5 leaves out the cell a walk starts from: a need is a minute from its own cell.
SELECT DISTINCT px, py, px, py, 1 FROM 'needs.parquet';

COPY (
  SELECT r.px, r.py, n.need, min(r.minutes)::INTEGER AS minutes
  FROM reach AS r
  JOIN (SELECT DISTINCT need, px, py FROM 'needs.parquet') AS n ON n.px = r.dpx AND n.py = r.dpy
  GROUP BY ALL
  ORDER BY r.py, r.px, n.need
) TO 'walk.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT need, count(*) AS cells, count(*) FILTER (WHERE minutes <= 10) AS within_10
FROM 'walk.parquet'
GROUP BY need
ORDER BY need;
