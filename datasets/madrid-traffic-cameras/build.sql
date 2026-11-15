-- Reads the city's camera list build.sh leaves in the working directory (CCTV.kml, one Placemark per
-- camera) and writes cameras.parquet:
--
--   camera_id    the city's number, as its picture is named (Camara<number>.jpg)
--   camera       the name the city gives it, upper case as written; where two cameras share a name
--                (two on the M-30 at Alcalá) the number follows it, so the name picks one camera
--   latitude, longitude
--   picture_url  the JPEG the camera last took, replaced every few minutes
--   setting      'street', 'M-30' (on the ring road, much of it in tunnels the map cannot show) or
--                'tunnel' (named as one: it looks along a tunnel, not at the street)
--   listed_at    when the list was read
--
-- The KML gives every camera the same 10 m above the ground: a placeholder, not each camera's height.

COPY (
  WITH placemarks AS (
    SELECT unnest(regexp_extract_all(content, '(?s)<Placemark>(.*?)</Placemark>', 1)) AS p
    FROM read_text('CCTV.kml')
  ),
  fields AS (
    SELECT trim(regexp_extract(p, '<Data name="Numero">\s*<Value>([^<]*)</Value>', 1)) AS camera_id,
           trim(replace(replace(regexp_extract(p, '<Data name="Nombre">\s*<Value>([^<]*)</Value>', 1),
                                '&amp;', '&'), '&apos;', '''')) AS name,
           regexp_extract(p, 'img src=(https://[^ ?]+\.jpg)', 1) AS picture_url,
           string_split(trim(regexp_extract(p, '<coordinates>\s*([^<]*)</coordinates>', 1)), ',') AS lnglat
    FROM placemarks
  )
  SELECT camera_id,
         CASE WHEN count(*) OVER (PARTITION BY name) > 1 THEN name || ' (' || camera_id || ')' ELSE name END AS camera,
         lnglat[2]::DOUBLE AS latitude,
         lnglat[1]::DOUBLE AS longitude,
         picture_url,
         CASE WHEN regexp_matches(name, '(^|\W)T(UNEL|ÚNEL)\W') OR starts_with(name, 'TUNEL') THEN 'tunnel'
              WHEN regexp_matches(name, '^M-?30') THEN 'M-30'
              ELSE 'street' END AS setting,
         now()::TIMESTAMP AS listed_at
  FROM fields
  WHERE camera_id <> '' AND len(lnglat) >= 2
  ORDER BY camera_id
) TO 'cameras.parquet' (FORMAT parquet, COMPRESSION zstd);

SELECT count(*) AS cameras, count(DISTINCT camera) AS names, count(*) FILTER (WHERE picture_url = '') AS no_picture,
       count(*) FILTER (WHERE setting = 'tunnel') AS tunnels, count(*) FILTER (WHERE setting = 'M-30') AS on_m30,
       min(latitude), max(latitude), min(longitude), max(longitude)
FROM 'cameras.parquet';
