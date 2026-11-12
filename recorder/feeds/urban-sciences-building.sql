-- The air in the Urban Sciences Building's rooms, as its building management
-- system pushes it (Newcastle University's Urban Observatory, CC BY 4.0): CO2,
-- temperature, humidity, brightness and occupancy. The feed behind
-- urban-sciences-building. The stream carries the plant too (heat pumps, air
-- handlers, meters: some 95% of its messages), which this feed leaves out.
--
-- The stream sends a reading when its value changes, and nothing from before
-- the recorder connects: this recording is the history. A message is
-- {signal: 2, data: {brokerage, entity, feed, timeseries}}; signal 0 is the
-- server's hello. `point` (data.brokerage.id) is the BMS point, the sourceId of
-- a feed's brokerage in the REST API (api.usb.urbanobservatory.ac.uk), which
-- datasets/urban-sciences-building maps to its room. Room number and zone are
-- on few messages: rooms are found by point, not by them.
--
-- source: wss://api.usb.urbanobservatory.ac.uk/stream
-- schedule: stream
-- order: point, ts

WITH m AS (
  SELECT json -> 'data' AS d
  FROM read_ndjson_objects(getvariable('source'))
  WHERE (json ->> 'signal') = '2'
)
SELECT (d ->> '$.timeseries.value.time')::TIMESTAMPTZ AS ts,
       d ->> '$.brokerage.id' AS point,
       d ->> '$.feed.metric' AS metric,
       TRY_CAST(d ->> '$.timeseries.value.data' AS DOUBLE) AS value,
       d ->> '$.timeseries.unit' AS unit,
       d ->> '$.entity.name' AS entity,
       d ->> '$.entity.meta.buildingFloor' AS floor,
       d ->> '$.entity.meta.roomNumber' AS room_number,
       d ->> '$.entity.meta.roomZone' AS room_zone,
       d ->> '$.brokerage.meta.roomDescription' AS room_description,
       d ->> '$.brokerage.broker.id' AS broker
FROM m
WHERE (d ->> '$.timeseries.value.time') IS NOT NULL
  AND (d ->> '$.brokerage.id') IS NOT NULL
  -- Room air by its metric's name, which the BMS spells many ways ("CO2", "Rm2 CO2",
  -- "Room temperature", "BrightnessValueZ3", "Room Occupied"); a plant reading of the
  -- same kind (an air handler's CO2) is kept too, and left to the dataset's points.
  AND regexp_matches(lower(d ->> '$.feed.metric'), 'co2|room temp|humid|bright|occup|lux')
