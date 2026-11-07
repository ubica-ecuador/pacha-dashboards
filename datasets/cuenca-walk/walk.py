"""Walks of up to 15 minutes from each cell of R5's grid holding a daily need,
asked of iso-cuenca (the bridge to the R5 instance of Cuenca). build.sh runs
it inside iso-cuenca's container, which publishes no port.

Reads `px,py,lat,lon` lines on stdin: a cell and its centre, where the walk
starts. Writes `px,py,minutos,geom` lines on stdout: the cell walked from,
R5's whole minute for each cell reached (1 to 14; R5 leaves out its 0, which
means both "here" and "out of reach") and that cell as hex WKB. Progress goes
to stderr. Exits 1 if R5 never answered for a cell: its needs would read as
out of reach.
"""
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ISO = os.environ.get("ISO_URL", "http://localhost:8099")
# On foot, no transit, flat ground (the base bundle), within 15 minutes.
PARAMS = dict(date=os.environ.get("DATE", "2026-09-02"), calle="apie",
              transit="none", walk=20, rides=1, bundle="base", max=14)


def walk(cell):
    px, py, lat, lon = cell
    query = urllib.parse.urlencode(dict(lat=lat, lon=lon, **PARAMS))
    url = f"{ISO}/cells.json?{query}"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return cell, json.load(r)
        except Exception as e:  # R5 busy or building: wait, ask again
            err = e
            time.sleep(5 * (attempt + 1))
    print(f"failed {url}: {err}", file=sys.stderr, flush=True)
    return cell, None


cells = [tuple(line.strip().split(",")) for line in sys.stdin if line.strip()]
done, failed, t0 = 0, 0, time.time()
with cf.ThreadPoolExecutor(int(os.environ.get("PARALLEL", "3"))) as pool:
    for (px, py, _, _), rows in pool.map(walk, cells):
        if rows is None:
            failed += 1
        for row in rows or []:
            sys.stdout.write(f"{px},{py},{row['minutos']},{row['geom']}\n")
        done += 1
        if done % 100 == 0 or done == len(cells):
            print(f"{done}/{len(cells)} cells, {time.time() - t0:.0f} s",
                  file=sys.stderr, flush=True)
sys.exit(1 if failed else 0)
