-- Reads the sequence's pictures build.sh leaves in the working directory (items.json, a GeoJSON
-- FeatureCollection as Panoramax's STAC API gives it) and writes:
--
--   ride.parquet    one row per picture, in time order:
--     camera          'Camera': the one moving thing, named for the map's Asset
--     time            when the picture was taken (UTC)
--     latitude, longitude
--     heading         which way the camera looked, degrees clockwise from north (view:azimuth)
--     field_of_view   how wide it sees, degrees (76: a phone's camera)
--     speed_kmh       the GPS's speed when it took the picture
--     distance_m, elapsed_s  from the first picture
--     picture_id, photo   the picture's id and the address of its 2048 px copy on Panoramax
--   places.parquet  Overture's places within 300 m of a picture: place, category (basic_category),
--                   confidence, latitude, longitude
INSTALL spatial;
LOAD spatial;
SET TimeZone = 'UTC';

CREATE TEMP TABLE pics AS
WITH f AS (
  SELECT unnest(features) AS f
  FROM read_json('items.json', columns = {'features': 'JSON[]'}, maximum_object_size = 67108864)
),
raw AS (
  SELECT f->>'$.id' AS picture_id,
         (f->>'$.properties.datetime')::TIMESTAMPTZ::TIMESTAMP AS time,
         (f->>'$.geometry.coordinates[1]')::DOUBLE AS latitude,
         (f->>'$.geometry.coordinates[0]')::DOUBLE AS longitude,
         (f->>'$.properties."view:azimuth"')::DOUBLE AS heading,
         (f->>'$.properties."pers:interior_orientation".field_of_view')::DOUBLE AS field_of_view,
         f->>'$.properties.exif."Exif.GPSInfo.GPSSpeed"' AS speed_raw,
         f->>'$.properties.exif."Exif.GPSInfo.GPSSpeedRef"' AS speed_ref,
         f->>'$.assets.sd.href' AS photo
  FROM f
)
SELECT *,
       -- EXIF writes the speed as a fraction, in km/h (K), miles (M) or knots (N) an hour.
       round(split_part(speed_raw, '/', 1)::DOUBLE / nullif(split_part(speed_raw, '/', 2)::DOUBLE, 0)
             * CASE speed_ref WHEN 'M' THEN 1.609344 WHEN 'N' THEN 1.852 ELSE 1 END, 1) AS speed_kmh
FROM raw;

COPY (
  WITH steps AS (
    SELECT *,
           2 * 6371000 * asin(sqrt(pow(sin(radians(latitude - lag(latitude) OVER w) / 2), 2)
             + cos(radians(latitude)) * cos(radians(lag(latitude) OVER w))
             * pow(sin(radians(longitude - lag(longitude) OVER w) / 2), 2))) AS step_m
    FROM pics
    WINDOW w AS (ORDER BY time)
  )
  SELECT 'Camera' AS camera, time, latitude, longitude, heading, field_of_view, speed_kmh,
         round(sum(coalesce(step_m, 0)) OVER (ORDER BY time)) AS distance_m,
         round(epoch(time) - epoch(min(time) OVER ()), 1) AS elapsed_s,
         picture_id, photo
  FROM steps
  ORDER BY time
) TO 'ride.parquet' (FORMAT parquet);

-- Overture's files that hold places in the route's box, as its STAC catalogue lists them.
CREATE TEMP TABLE box AS
SELECT min(longitude) - 0.005 AS xmin, max(longitude) + 0.005 AS xmax,
       min(latitude) - 0.004 AS ymin, max(latitude) + 0.004 AS ymax
FROM pics;
SET VARIABLE places_files = (
  SELECT list(replace(assets.aws.alternate.s3.href, 's3://overturemaps-us-west-2/',
                      'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/'))
  FROM read_parquet('https://stac.overturemaps.org/2026-10-21.0/collections.parquet'), box
  WHERE bbox.xmin <= box.xmax AND bbox.xmax >= box.xmin AND bbox.ymin <= box.ymax AND bbox.ymax >= box.ymin
    AND assets.aws.alternate.s3.href LIKE '%type=place/%'
);

COPY (
  WITH candidates AS (
    SELECT p.id AS place_id, p.names.primary AS place, coalesce(p.basic_category, 'other') AS category,
           round(p.confidence, 2) AS confidence, ST_Y(p.geometry) AS latitude, ST_X(p.geometry) AS longitude
    FROM read_parquet(getvariable('places_files')) p, box
    WHERE p.bbox.xmin <= box.xmax AND p.bbox.xmax >= box.xmin AND p.bbox.ymin <= box.ymax AND p.bbox.ymax >= box.ymin
      AND p.names.primary IS NOT NULL
  )
  SELECT c.*
  FROM candidates c
  WHERE EXISTS (
    SELECT 1 FROM pics r
    WHERE abs(r.latitude - c.latitude) < 0.003 AND abs(r.longitude - c.longitude) < 0.0045
      AND 2 * 6371000 * asin(sqrt(pow(sin(radians(c.latitude - r.latitude) / 2), 2)
          + cos(radians(r.latitude)) * cos(radians(c.latitude))
          * pow(sin(radians(c.longitude - r.longitude) / 2), 2))) <= 300
  )
  ORDER BY place_id
) TO 'places.parquet' (FORMAT parquet);

SELECT (SELECT count(*) FROM 'ride.parquet') AS pictures,
       (SELECT max(distance_m) FROM 'ride.parquet') AS metres,
       (SELECT max(elapsed_s) FROM 'ride.parquet') AS seconds,
       (SELECT count(*) FROM 'places.parquet') AS places;
