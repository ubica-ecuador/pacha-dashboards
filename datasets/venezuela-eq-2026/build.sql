-- venezuela-eq-2026: from what build.sh fetched (in the working directory) to the four Parquet files.
INSTALL spatial; LOAD spatial;
INSTALL h3 FROM community; LOAD h3;

-- ohsome's GeoJSON, one feature per change; a building on a tile edge comes back from both tiles. Only
-- creations and deletions are kept: edits to a building's shape or tags do not change how many there are.
CREATE TEMP TABLE raw_changes AS
SELECT f->'properties' AS properties, f->'geometry' AS geometry
FROM (SELECT unnest(features) AS f
      FROM read_json('changes/*.geojson', columns = {features: 'JSON[]'}, maximum_object_size = 1000000000));

COPY (
  WITH c AS (
    SELECT DISTINCT
      CAST(regexp_extract(properties->>'@osmId', '[0-9]+$') AS BIGINT) AS osm_id,
      CAST(properties->>'@timestamp' AS TIMESTAMP) AS time,
      CASE WHEN (properties->>'@creation')::BOOLEAN THEN 'creation'
           WHEN (properties->>'@deletion')::BOOLEAN THEN 'deletion' END AS kind,
      round(CAST(geometry->'coordinates'->>1 AS DOUBLE), 6) AS latitude,
      round(CAST(geometry->'coordinates'->>0 AS DOUBLE), 6) AS longitude,
      CAST(properties->>'@contributionChangesetId' AS BIGINT) AS changeset
    FROM raw_changes
  )
  -- one place per building: a deletion comes with no geometry, and a building cut by a tile edge has a
  -- centroid per tile
  , place AS (SELECT osm_id, any_value(latitude) AS latitude, any_value(longitude) AS longitude
              FROM c WHERE latitude IS NOT NULL GROUP BY 1)
  SELECT c.osm_id, c.time, c.kind, p.latitude, p.longitude,
         h3_latlng_to_cell_string(p.latitude, p.longitude, 9) AS hex, any_value(c.changeset) AS changeset
  FROM c JOIN place AS p USING (osm_id)
  WHERE c.kind IS NOT NULL
  GROUP BY c.osm_id, c.time, c.kind, p.latitude, p.longitude
  ORDER BY c.time
) TO 'osm_changes.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT area, damaged::INTEGER AS damaged_votes, not_sure::INTEGER AS not_sure_votes, total_validators::INTEGER AS validators,
         round(damaged_share::DOUBLE, 2) AS damaged_share,
         round(ST_Y(ST_Centroid(geom)), 6) AS latitude, round(ST_X(ST_Centroid(geom)), 6) AS longitude,
         ST_AsGeoJSON(geom)::VARCHAR AS geojson
  FROM ST_Read('damage_cells.geojson')
  WHERE verdict = 'accepted'
) TO 'damage_cells.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT round(ST_Y(ST_Centroid(geom)), 6) AS latitude, round(ST_X(ST_Centroid(geom)), 6) AS longitude,
         damaged AS level, nullif(nullif(name, damaged), '') AS name
  FROM ST_Read('damage_points.geojson')
  WHERE damaged IN ('complete', 'significant', 'minimal')
) TO 'damage_points.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT id, properties->>'phase' AS phase, CAST(properties->>'datetime' AS TIMESTAMP) AS time,
         CAST(properties->>'eo:cloud_cover' AS DOUBLE) AS cloud_cover, CAST(properties->>'pan_gsd' AS DOUBLE) AS gsd,
         CAST(properties->>'view:off_nadir' AS DOUBLE) AS off_nadir,
         CAST(bbox->>0 AS DOUBLE) AS west, CAST(bbox->>1 AS DOUBLE) AS south,
         CAST(bbox->>2 AS DOUBLE) AS east, CAST(bbox->>3 AS DOUBLE) AS north,
         assets->'visual'->>'href' AS raster_url
  FROM read_json('items/*.json', columns = {id: 'VARCHAR', properties: 'JSON', bbox: 'JSON', assets: 'JSON'})
  ORDER BY phase, time
) TO 'scenes.parquet' (FORMAT parquet, COMPRESSION zstd);
