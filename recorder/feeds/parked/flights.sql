-- Every aircraft adsb.lol sees, one row per position heard: the feed behind
-- air-traffic-world's history. The recorder sets `source` (a URL, or a file in
-- its tests) and keeps what this returns; the columns are the recording's
-- schema, and gateway/recordings/flights-empty.parquet must match them
-- (recorder/make-empty.sh).
--
-- source: http://feeds/adsblol/world
-- interval: 60
WITH snap AS (
  SELECT make_timestamptz((now * 1000)::BIGINT) AS polled, unnest(ac) AS a
  FROM read_json(getvariable('source'), columns = {now: 'DOUBLE', ac: 'JSON[]'})
)
SELECT
  -- When the position was heard, not when it was polled.
  polled - to_milliseconds((coalesce((a->>'seen_pos')::DOUBLE, 0) * 1000)::BIGINT) AS ts,
  a->>'hex' AS hex,
  nullif(trim(a->>'flight'), '') AS flight,
  a->>'r' AS reg,
  a->>'t' AS type,
  a->>'category' AS category,
  a->>'type' AS source,
  (a->>'lat')::DOUBLE AS lat,
  (a->>'lon')::DOUBLE AS lon,
  h3_latlng_to_cell((a->>'lat')::DOUBLE, (a->>'lon')::DOUBLE, 4) AS cell,
  -- alt_baro is feet, or the string "ground".
  try_cast(a->>'alt_baro' AS INTEGER) AS alt_baro,
  coalesce(a->>'alt_baro' = 'ground', false) AS on_ground,
  try_cast(a->>'alt_geom' AS INTEGER) AS alt_geom,
  try_cast(a->>'baro_rate' AS INTEGER) AS baro_rate,
  (a->>'gs')::DOUBLE AS gs,
  (a->>'track')::DOUBLE AS track,
  a->>'squawk' AS squawk,
  a->>'emergency' AS emergency,
  -- adsb.lol's database flags: 1 military, 2 interesting, 4 PIA, 8 LADD.
  try_cast(a->>'dbFlags' AS INTEGER) AS db_flags
FROM snap
WHERE a->>'lat' IS NOT NULL
