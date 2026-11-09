-- One more hub (utopia.sql): the candidate cell whose 10-minute walk reaches the
-- most people still without all six; ties go to the northernmost, then the
-- westernmost cell, so a rebuild opens the same hubs.
SET VARIABLE hub = getvariable('hub') + 1;

INSERT INTO hubs
SELECT getvariable('hub'), c.hx, c.hy, sum(p.people) AS people
FROM cover AS c
JOIN people AS p USING (px, py)
LEFT JOIN done AS d USING (px, py)
WHERE d.px IS NULL
GROUP BY c.hx, c.hy
ORDER BY people DESC, c.hy, c.hx
LIMIT 1;

INSERT INTO done
SELECT c.px, c.py, getvariable('hub')
FROM cover AS c
JOIN hubs AS h ON h.px = c.hx AND h.py = c.hy AND h.hub = getvariable('hub')
LEFT JOIN done AS d ON d.px = c.px AND d.py = c.py
WHERE d.px IS NULL;
