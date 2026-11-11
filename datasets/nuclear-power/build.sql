-- Reads the two downloads build.sh leaves in the working directory and writes:
--
--   reactors.parquet    one row per nuclear power reactor GeoNuclearData lists with a place, every
--                       status: its plant name and unit, country, reactor type and model, net
--                       capacity (MWe), when construction started, when it entered commercial
--                       operation (started) and when it was shut down for good (shut_down), and its
--                       status in March 2024. A reactor without a start date (under construction,
--                       planned, or one the list gives none, such as Palisades) has started NULL.
--   generation.parquet  the electricity nuclear power made, country by country and year by year,
--                       1965 to 2025 (TWh), and its share of each country's electricity (%), for
--                       every country that ever made any, and the World.

COPY (
  SELECT Id AS id,
         Name AS name,
         -- Our World in Data's name, so a country is one name across both files.
         CASE Country WHEN 'Türkiye' THEN 'Turkey' ELSE Country END AS country,
         CountryCode AS country_code,
         Status AS status,
         ReactorType AS reactor_type,
         nullif(trim(ReactorModel), '') AS model,
         ConstructionStartAt::TIMESTAMP AS construction_start,
         OperationalFrom::TIMESTAMP AS started,
         OperationalTo::TIMESTAMP AS shut_down,
         Capacity::DOUBLE AS capacity_mw,
         Latitude AS latitude,
         Longitude AS longitude
  FROM read_csv('nuclear_power_plants.csv', header = true)
  WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
  ORDER BY id
) TO 'reactors.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  WITH o AS (
    SELECT country, iso_code, "year"::INTEGER AS "year",
           nuclear_electricity::DOUBLE AS twh, nuclear_share_elec::DOUBLE AS share
    FROM read_csv('owid-energy-data.csv', header = true)
    -- Countries (three-letter ISO codes) and the World; not the regions and income groups.
    WHERE (length(iso_code) = 3 OR country = 'World') AND nuclear_electricity IS NOT NULL
  )
  SELECT country, iso_code, make_timestamp("year", 1, 1, 0, 0, 0) AS "time", "year",
         round(twh, 2) AS twh, round(share, 2) AS share
  FROM o
  WHERE country IN (SELECT country FROM o GROUP BY country HAVING max(twh) > 0)
  ORDER BY country, "year"
) TO 'generation.parquet' (FORMAT parquet, COMPRESSION zstd);
