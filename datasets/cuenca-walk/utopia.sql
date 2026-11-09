-- The utopia of cuenca-10-minute-utopia, after walk.sql in the same session (its
-- `reach` table: the walks from each cell holding a need). A hub is a place
-- with all six needs, opened in a cell that already holds one of them (a shop,
-- a stop, a school...), so every walk from it is one R5 already timed. Whoever
-- lives within a 10-minute walk of a hub reaches all six. hub.sql, run once per
-- hub, opens the next where it brings all six to the most people who lack
-- them; plan.sql writes the plan. `population` is Pacha's
-- datasets/cuenca-access/population.parquet.

-- The cells within a 10-minute walk of each candidate cell (minutes as in
-- walk.sql: R5's whole minute plus one).
CREATE TABLE cover AS
SELECT DISTINCT dpx AS hx, dpy AS hy, px, py FROM reach WHERE minutes <= 10;

CREATE TABLE people AS
SELECT px, py, sum(population) AS people
FROM read_parquet(getvariable('population'))
GROUP BY ALL;

-- Every cell that reaches all six, and the hub that brought them (0: today).
CREATE TABLE done AS
SELECT px, py, 0 AS hub FROM 'walk.parquet' WHERE minutes <= 10 GROUP BY ALL HAVING count(*) = 6;

CREATE TABLE hubs (hub INTEGER, px INTEGER, py INTEGER, people DOUBLE);
SET VARIABLE hub = 0;
