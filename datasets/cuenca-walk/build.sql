-- needs.parquet, for cuenca-10-minute-city: six daily needs of Cuenca, one row
-- per place with a point and the cell of R5's grid it falls in, px and py:
-- what walk.py times a walk to from every cell. Run by build.sh, which sets
-- `release` (an Overture Maps release), `usos` (LlactaLAB's land uses, the
-- file it downloaded) and `places` (Pacha's cuenca-access places.parquet), and
-- runs this in the folder the file is written to.
--
-- R5 lays its grid on Web Mercator pixels: at zoom 10 the world is
-- 256 * 2^10 = 262,144 pixels across, and a cell is one pixel, about 153 m in
-- Cuenca, as in Pacha's datasets/cuenca-access.

INSTALL spatial;
LOAD spatial;
INSTALL httpfs;
LOAD httpfs;
SET geometry_always_xy = true;

CREATE MACRO px(lon) AS floor((lon + 180) / 360 * 262144)::INTEGER;
CREATE MACRO py(lat) AS floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 262144)::INTEGER;
-- Names in the sources are in capitals: MIGUEL HEREDIA Y LAMAR reads Miguel Heredia Y Lamar.
CREATE MACRO initcap(s) AS array_to_string(list_transform(string_split(lower(s), ' '), lambda w: upper(w[1]) || w[2:]), ' ');
-- R5's analysis extent (iso-cuenca's BOUNDS).
CREATE MACRO in_box(b) AS b.xmin <= -78.87 AND b.xmax >= -79.11 AND b.ymin <= -2.76 AND b.ymax >= -3.02;

-- Overture's place files that hold Cuenca, from the release's STAC index. The
-- collection is read off the path: the index's own column has been null since
-- Overture rewrote it on 2026-09-22.
SET VARIABLE place = (
  SELECT list(replace(assets.aws.alternate.s3.href, 's3://overturemaps-us-west-2/',
                      'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/'))
  FROM read_parquet('https://stac.overturemaps.org/' || getvariable('release') || '/collections.parquet')
  WHERE in_box(bbox) AND regexp_extract(assets.aws.alternate.s3.href, 'type=([^/]*)/', 1) = 'place'
);

-- Food, health and schools are LlactaLAB's land uses of Cuenca, the city's
-- trade permits and its public facilities: food is a corner shop, a grocery, a
-- minimarket, a bakery, a food distributor or a market or fair of fresh
-- produce; health a centre, clinic or hospital of the Ministry of Health's
-- register; a school any level up to the end of secondary (universities left
-- out). Pharmacies are the permits' and Overture's (confidence 0.5 or more),
-- as neither holds them all; one listed by both counts twice, which changes no
-- walk to the nearest. Parks and stops are those of cuenca-access's
-- places.parquet, a park by each of its entrances. The land uses' names came
-- to LlactaLAB with a ? for every accented letter; they are kept as they are.
COPY (
  WITH usos AS (
    SELECT fid, source, sub_tipo, dpa_nombre, ST_Centroid(geom) AS g
    FROM ST_Read(getvariable('usos'))
  ),
  need AS (
    SELECT 'usos-' || fid AS id,
           CASE WHEN source = 'Permisos_muni'
                     AND (sub_tipo IN ('Despensas', 'Minimercados', 'Panaderias',
                                       'Tiendas Distribuidoras De Productos Alimenticios En General')
                          OR sub_tipo LIKE 'Tiendas De Abarrotes%') THEN 'Food'
                -- Fresh produce: 'NO PERECIBLES' (clothes, hardware) is another market.
                WHEN source = 'Aprovisionami' AND sub_tipo LIKE '%PRODUCTOS PERECIBLES%' THEN 'Food'
                WHEN source = 'Permisos_muni' AND sub_tipo = 'Farmacias' THEN 'Pharmacy'
                WHEN source = 'Salud' THEN 'Health'
                WHEN source = 'Educacion' AND sub_tipo IS DISTINCT FROM 'NIVEL SUPERIOR' THEN 'School'
           END AS need,
           coalesce(nullif(trim(dpa_nombre), ''), initcap(sub_tipo)) AS name, ST_Y(g) AS lat, ST_X(g) AS lon
    FROM usos
    UNION ALL
    SELECT id, 'Pharmacy', names.primary, ST_Y(ST_Centroid(geometry)), ST_X(ST_Centroid(geometry))
    FROM read_parquet(getvariable('place'))
    WHERE in_box(bbox) AND basic_category = 'pharmacy_and_drug_store' AND confidence >= 0.5
    UNION ALL
    SELECT id, CASE kind WHEN 'Park' THEN 'Park' ELSE 'Transit' END, name, latitude, longitude
    FROM read_parquet(getvariable('places'))
    WHERE kind IN ('Park', 'Transit stop')
  )
  SELECT id, need, name, px(lon) AS px, py(lat) AS py, round(lat, 6) AS latitude, round(lon, 6) AS longitude
  FROM need
  WHERE need IS NOT NULL AND lon BETWEEN -79.11 AND -78.87 AND lat BETWEEN -3.02 AND -2.76
  ORDER BY need, id
) TO 'needs.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT need, count(*) AS places, count(DISTINCT (px, py)) AS cells
FROM 'needs.parquet'
GROUP BY need
ORDER BY need;
