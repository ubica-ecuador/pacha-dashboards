-- What the cuenca-accessibility dashboard joins R5's travel times to, in
-- three Parquet files (http://feeds/datasets/cuenca-access/). Run by build.sh,
-- which sets `release` (an Overture Maps release) and the paths of the files
-- it downloaded (`buildings`, `parks`, `stops`), and runs this in the folder
-- the files are written to.
--
-- Every row carries the cell of R5's grid it falls in, px and py. R5 lays its
-- grid on Web Mercator pixels: at zoom 10 the world is 256 * 2^10 = 262,144
-- pixels across, and a cell is one pixel, about 153 m in Cuenca. The cells
-- iso-cuenca returns are those pixels, so px and py are the whole join.

INSTALL spatial;
LOAD spatial;
INSTALL httpfs;
LOAD httpfs;
SET geometry_always_xy = true;

-- The pixel of a longitude and of a latitude, and the edges of a pixel.
CREATE MACRO px(lon) AS floor((lon + 180) / 360 * 262144)::INTEGER;
CREATE MACRO py(lat) AS floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 262144)::INTEGER;
CREATE MACRO px_lon(x) AS x / 262144 * 360 - 180;
CREATE MACRO py_lat(y) AS degrees(atan(sinh(pi() * (1 - 2 * y / 262144))));
-- Names in the sources are in capitals: MIGUEL HEREDIA Y LAMAR reads Miguel Heredia Y Lamar.
CREATE MACRO initcap(s) AS array_to_string(list_transform(string_split(lower(s), ' '), lambda w: upper(w[1]) || w[2:]), ' ');
CREATE MACRO cell(x, y) AS ST_MakeEnvelope(px_lon(x), py_lat(y + 1), px_lon(x + 1), py_lat(y));

-- R5's analysis extent (iso-cuenca's BOUNDS).
CREATE MACRO in_box(b) AS b.xmin <= -78.87 AND b.xmax >= -79.11 AND b.ymin <= -2.76 AND b.ymax >= -3.02;

-- Overture's files that hold Cuenca, from the release's STAC index. The
-- collection is read off the path: the index's own column has been null since
-- Overture rewrote it on 2026-09-22.
CREATE TABLE ov AS
SELECT regexp_extract(assets.aws.alternate.s3.href, 'type=([^/]*)/', 1) AS collection,
       replace(assets.aws.alternate.s3.href, 's3://overturemaps-us-west-2/',
               'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/') AS href
FROM read_parquet('https://stac.overturemaps.org/' || getvariable('release') || '/collections.parquet')
WHERE in_box(bbox);
SET VARIABLE segment = (SELECT list(href) FROM ov WHERE collection = 'segment');
SET VARIABLE land_use = (SELECT list(href) FROM ov WHERE collection = 'land_use');
SET VARIABLE building = (SELECT list(href) FROM ov WHERE collection = 'building');

-- People per cell. A building on a cell's edge counts in one cell only.
COPY (
  SELECT px(longitude) AS px, py(latitude) AS py,
         round(sum(coalesce(try_cast(poblacion_edificacion AS DOUBLE), 0)), 2) AS population
  FROM read_csv(getvariable('buildings'), header = true, all_varchar = true,
                columns = {'FID': 'VARCHAR', 'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'poblacion_edificacion': 'VARCHAR'})
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  GROUP BY ALL
  HAVING sum(coalesce(try_cast(poblacion_edificacion AS DOUBLE), 0)) > 0
  ORDER BY py, px
) TO 'population.parquet' (FORMAT parquet, COMPRESSION zstd);

-- Roads, cut at the edges of the cells they cross: a piece is reached at the
-- minute its cell is. Footways and steps stay (the reader may be walking).
CREATE TABLE segments AS
SELECT id, class, geometry AS g, bbox
FROM read_parquet(getvariable('segment'))
WHERE subtype = 'road' AND in_box(bbox);

COPY (
  WITH pairs AS (
    SELECT s.id, s.class, s.g, x, y
    FROM segments s,
         range(px(s.bbox.xmin), px(s.bbox.xmax) + 1) AS rx(x),
         range(py(s.bbox.ymax), py(s.bbox.ymin) + 1) AS ry(y)
  ),
  pieces AS (
    SELECT id, class, x::INTEGER AS px, y::INTEGER AS py,
           ST_Intersection(g, cell(x, y)) AS geometry
    FROM pairs
    WHERE ST_Intersects(g, cell(x, y))
  )
  SELECT id, class, px, py, geometry
  FROM pieces
  WHERE ST_GeometryType(geometry) IN ('LINESTRING', 'MULTILINESTRING') AND ST_Length(geometry) > 0
  ORDER BY py, px, id
) TO 'streets.parquet' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 16384);

-- Services from Overture, as the free dashboard r5-calles chose them: land
-- use of hospitals, schools and colleges; shopping centres by name, as land
-- use or as a building that is not inside one already.
CREATE TABLE lu AS
SELECT id, class, names.primary AS name, geometry AS g
FROM read_parquet(getvariable('land_use'))
WHERE in_box(bbox) AND class IN ('hospital', 'school', 'college', 'retail', 'commercial');
CREATE TABLE bu AS
SELECT id, names.primary AS name, geometry AS g
FROM read_parquet(getvariable('building'))
WHERE in_box(bbox)
  AND regexp_matches(lower(names.primary), 'mall|shopping|centro comercial|plaza de las am[eé]ricas|mill?enn?ium plaza|racar plaza');
CREATE MACRO mall(n) AS regexp_matches(lower(n), 'mall|shopping|centro comercial|plaza de las am[eé]ricas|mill?enn?ium plaza|racar plaza');

CREATE TABLE services AS
SELECT id, 'Health' AS kind, coalesce(name, 'Hospital') AS name, g FROM lu WHERE class = 'hospital'
UNION ALL
SELECT id, 'Education', coalesce(name, 'School'), g FROM lu WHERE class IN ('school', 'college')
UNION ALL
SELECT id, 'Shopping', name, g FROM lu
WHERE class IN ('retail', 'commercial') AND mall(name) AND ST_Area_Spheroid(g) >= 50
UNION ALL
SELECT b.id, 'Shopping', b.name, b.g FROM bu b
WHERE ST_Area_Spheroid(b.g) >= 50
  AND NOT EXISTS (SELECT 1 FROM lu WHERE lu.class IN ('retail', 'commercial') AND ST_Intersects(lu.g, b.g));

-- One row per place and cell it touches: a hospital is reached as soon as one
-- of its cells is. Points (stops, park entrances) touch one. A park is reached
-- at its first entrance: its entrances share its id.
COPY (
  WITH area AS (
    SELECT s.id, s.kind, s.name, s.g, x::INTEGER AS px, y::INTEGER AS py
    FROM services s,
         range(px(ST_XMin(s.g)), px(ST_XMax(s.g)) + 1) AS rx(x),
         range(py(ST_YMax(s.g)), py(ST_YMin(s.g)) + 1) AS ry(y)
    WHERE ST_Intersects(s.g, cell(x, y))
  ),
  stops AS (
    -- Two feeds, buses and the tram, each numbering its stops from 0.
    SELECT feedId AS feed, unnest(s) FROM (SELECT feedId, unnest(stops) AS s FROM read_json(getvariable('stops')))
  ),
  parks AS (
    SELECT park_id, nombre, tipo, geom FROM ST_Read(getvariable('parks'))
    WHERE situacion IS DISTINCT FROM 'RESERVA'
  )
  SELECT id, kind, name, px, py,
         round(ST_Y(ST_PointOnSurface(g)), 6) AS latitude, round(ST_X(ST_PointOnSurface(g)), 6) AS longitude
  FROM area
  UNION ALL
  SELECT 'stop-' || feed || '-' || _id, 'Transit stop', initcap(name), px(lon), py(lat), round(lat, 6), round(lon, 6)
  FROM stops
  UNION ALL
  SELECT 'park-' || park_id, 'Park',
         CASE WHEN nombre IS NULL OR nombre = 'PARQUE O PLAZA' THEN initcap(coalesce(tipo, 'Park')) ELSE initcap(nombre) END,
         px(ST_X(geom)), py(ST_Y(geom)), round(ST_Y(geom), 6), round(ST_X(geom), 6)
  FROM parks
  ORDER BY kind, id, py, px
) TO 'places.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT 'population' AS file, count(*) AS rows, round(sum(population)) AS total FROM 'population.parquet'
UNION ALL SELECT 'streets', count(*), round(sum(ST_Length_Spheroid(geometry)) / 1000) FROM 'streets.parquet'
UNION ALL SELECT 'places ' || kind, count(DISTINCT id), count(*) FROM 'places.parquet' GROUP BY kind
ORDER BY file;
