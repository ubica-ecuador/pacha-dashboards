"""Places NYC DEP's drinking-water sampling stations, which Distribution Water Quality (NYC Open Data, bkwf-xfky) names
only by a description: "SS - N/S Lafayette Ave 1st SS W/O Underhill Ave IFO 1871 Lafayette Avenue 12\"" is the sampling
station on the north side of Lafayette Avenue, the first west of Underhill Avenue, in front of number 1871, on a
12-inch main. Each station is put where its two streets meet on NYC's street centerline (Centerline, inkn-q76z),
the middle of the block for "between X and Y"; failing that, at its address on NYC GeoSearch (Planning Labs); where
neither works (islands, plants, a highway median), it stays unplaced and keeps its samples.

Writes stations.csv beside this file, which is committed: build.sh reads it. Run again when DEP adds stations:
    python3 -I locate.py        (needs the duckdb Python package; DuckDB installs spatial)
"""
import csv, json, os, re, shutil, sys, tempfile, time, urllib.parse, urllib.request
import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- descriptions into a main street, a cross street (or two) and an address
ABBR = [(r'\bAVENUE\b', 'AVE'), (r'\bAVES?\b', 'AVE'), (r'\bSTREETS?\b', 'ST'), (r'\bSTS\b', 'ST'), (r'\bROAD\b', 'RD'), (r'\bRDS\b', 'RD'),
        (r'\bPLACE\b', 'PL'), (r'\bBOULEVARD\b', 'BLVD'), (r'\bPARKWAY\b', 'PKWY'), (r'\bPKY\b', 'PKWY'), (r'\bDRIVE\b', 'DR'),
        (r'\bLANE\b', 'LN'), (r'\bCOURT\b', 'CT'), (r'\bTERRACE\b', 'TER'), (r'\bTERR\b', 'TER'), (r'\bHIGHWAY\b', 'HWY'),
        (r'\bEXPRESSWAY\b', 'EXPY'), (r'\bTURNPIKE\b', 'TPKE'), (r'\bTPK\b', 'TPKE'), (r'\bSQUARE\b', 'SQ'), (r'\bCRESCENT\b', 'CRES'),
        (r'^EAST (?=\d)', 'E '), (r'^WEST (?=\d)', 'W '), (r'^NORTH (?=\d)', 'N '), (r'^SOUTH (?=\d)', 'S '), (r'\bLA$', 'LN'), (r'\bSAINT\b', 'ST'), (r'\bMOUNT\b', 'MT'),
        (r'\bFIRST\b', '1'), (r'\bSECOND\b', '2'), (r'\bTHIRD\b', '3'), (r'\bFOURTH\b', '4'), (r'\bFIFTH\b', '5'),
        (r'\bSIXTH\b', '6'), (r'\bSEVENTH\b', '7'), (r'\bEIGHTH\b', '8'), (r'\bNINTH\b', '9'), (r'\bTENTH\b', '10')]

def norm(s):
    s = s.upper().replace('.', ' ').replace("'", '').replace('’', '')
    s = re.sub(r'\([^)]*\)', ' ', s)
    s = re.sub(r'\b(\d+)(ST|ND|RD|TH)\b', r'\1', s)
    s = re.sub(r'\s+', ' ', s).strip()
    for a, b in ABBR: s = re.sub(a, b, s)
    return re.sub(r'\s+', ' ', s).strip()

STOP = r'(?=\s+(?:IFO|OPP|@|AT)\b|\s*\(|\s*;|\s*,|\s+-\s|\s+\d+\s*"|\s*"|\s+ON\b|\s+NEAR\b|$)'
def parse(desc):
    d = (desc or '').replace('\xa0', ' ').strip().strip('"')
    d = d.replace('”', '"').replace('–', '-')
    d = re.sub(r'\s+\d+\s*"+\s*(main)?', ' ', d, flags=re.I)
    d = re.sub(r'\s+\d+\s*$', '', d)
    d = re.sub(r'^\d+"*\s*HYT\s*-\s*', '', d, flags=re.I)
    d = re.sub(r'^SS\s*[-]\s*', '', d, flags=re.I)
    d = re.sub(r'^IFO\s+\d+\s+', '', d)
    d = re.sub(r'\bopposite\b', '@', d, flags=re.I)
    out = {}
    m = re.search(r'\b(?:IFO|OPP)\.?\s*#?\s*(\d+(?:-\d+)?[A-Z]?)\s+([A-Za-z0-9 .\']+?)' + STOP, d, re.I)
    if m: out['address'] = f'{m.group(1)} {m.group(2).strip()}'
    m = re.match(r'(?:[NSEW]{1,2}/[SO]\s+(?:of\s+)?)(.+?)\s+(?:(?:\d+\s*(?:st|nd|rd|th)?\s*(?:SS\s*)?)?[NSEW]/O\b|BTW\b|BET\b|@|AT\b|&)', d, re.I)
    if m:
        out['a'] = m.group(1)
        rest = d[m.end(0):]
        k = m.group(0).split()[-1].upper()
        if k in ('BTW', 'BET'):
            mm = re.match(r'\s*(?:of\s+)?(.+?)\s*(?:&|and)\s*(.+?)' + STOP, rest, re.I)
            if mm:
                b1, b2 = mm.group(1), mm.group(2)
                suf = re.search(r'\b(AVES?|STS?|RDS?|PLS?|BLVDS?|DRS?)\.?$', b2, re.I)
                if suf and not re.search(r'\b(AVE|ST|RD|PL|BLVD|DR|PKWY|LN|CT|BROADWAY)\b', b1, re.I) and not re.match(r'(AVE|ST)\b', b1, re.I):
                    b1 = b1 + ' ' + re.sub(r's$', '', suf.group(1), flags=re.I)
                out['b'] = b1; out['b2'] = b2
        else:
            mm = re.match(r'\s*(?:of\s+)?(.+?)' + STOP, rest, re.I)
            if mm: out['b'] = mm.group(1)
    for k in ('a', 'b', 'b2'):
        if k in out: out[k + 'n'] = norm(out[k])
    return out

# ---- the stations DEP sampled for free chlorine since 2024, each under the description it was sampled most under
SOCRATA = 'https://data.cityofnewyork.us/resource'
def socrata(dataset, params, fmt='json'):
    url = f'{SOCRATA}/{dataset}.{fmt}?' + urllib.parse.urlencode(params)
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Pacha'}), timeout=600).read()

work = tempfile.mkdtemp()
CENTERLINE = os.path.join(work, 'centerline.csv')
open(CENTERLINE, 'wb').write(socrata('inkn-q76z', {'$select': 'full_street_name,stname_label,boroughcode,the_geom',
    '$where': "rw_type in('1','2','3','4','6','9','11','13')", '$limit': 500000}, 'csv'))
raw = json.loads(socrata('bkwf-xfky', {'$query': 'SELECT site, borough, description, count(*) AS n WHERE analyte="Chlorine - Free Residual" '
    'AND sampledatetime > "2024-01-01" GROUP BY site, borough, description ORDER BY site LIMIT 5000'}))
best = {}
for r in raw:
    if r['site'] not in best or int(r['n']) > int(best[r['site']]['n']): best[r['site']] = r
rows = []
for r in best.values():
    if not r.get('borough'): continue   # plants, shafts and reservoirs: no street address
    rows.append({'site': r['site'], 'borough': r['borough'],
                 'description': (r.get('description') or '').replace('\xa0', ' ').strip().strip('"'), **parse(r.get('description'))})

# ---- streets and addresses into points
BORO = {'Manhattan': 1, 'Bronx': 2, 'Brooklyn': 3, 'Queens': 4, 'Staten Island': 5}
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
con.execute(f"""CREATE TABLE cl AS SELECT upper(regexp_replace(stname_label, '\\s+', ' ', 'g')) AS label,
  upper(regexp_replace(full_street_name, '\\s+', ' ', 'g')) AS fullname, boroughcode::INT AS boro, ST_GeomFromText(the_geom) AS g
  FROM read_csv('{CENTERLINE}', all_varchar = true) WHERE the_geom IS NOT NULL""")

def lines(name, boro):
    for cond in ("label = $n OR fullname = $n", "label LIKE $n || ' %' OR label LIKE '% ' || $n", "jaro_winkler_similarity(label, $n) > 0.93"):
        r = con.execute(f"SELECT ST_Union_Agg(g) FROM cl WHERE boro = $b AND ({cond})", {'n': name, 'b': boro}).fetchone()[0]
        if r is not None: return r
    return None

def meet(a, b, boro):
    """The point where streets a and b meet: their crossing, or the closest point of a to b within 60 m."""
    r = con.execute("""
      WITH s AS (SELECT (SELECT ST_Union_Agg(g) FROM cl WHERE boro = $b AND (label = $a OR fullname = $a)) AS ga,
                        (SELECT ST_Union_Agg(g) FROM cl WHERE boro = $b AND (label = $c OR fullname = $c)) AS gb)
      SELECT ST_X(p), ST_Y(p), d FROM (SELECT ST_StartPoint(ST_ShortestLine(ga, gb)) AS p,
             ST_Distance_Sphere(ST_StartPoint(ST_ShortestLine(ga, gb)), ST_EndPoint(ST_ShortestLine(ga, gb))) AS d FROM s
             WHERE ga IS NOT NULL AND gb IS NOT NULL)""", {'a': a, 'c': b, 'b': boro}).fetchone()
    return r

def fuzzy(name, boro):
    r = con.execute("""SELECT label FROM cl WHERE boro = $b GROUP BY label
        ORDER BY jaro_winkler_similarity(label, $n) DESC LIMIT 1""", {'n': name, 'b': boro}).fetchone()
    return r[0] if r else None

def geosearch(text):
    url = 'https://geosearch.planninglabs.nyc/v2/search?' + urllib.parse.urlencode({'text': text, 'size': 1})
    for _ in range(3):
        try:
            f = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Pacha'}), timeout=30))['features']
            if not f: return None
            p = f[0]['properties']
            return {'lon': f[0]['geometry']['coordinates'][0], 'lat': f[0]['geometry']['coordinates'][1], 'label': p.get('label'),
                    'borough': p.get('borough'), 'confidence': p.get('confidence'), 'match_type': p.get('match_type'), 'layer': p.get('layer')}
        except Exception as e:
            time.sleep(2)
    return None

out = []
for x in rows:
    boro = BORO[x['borough']]
    res = dict(x)
    if x.get('an') and x.get('bn'):
        an = x['an'] if con.execute("SELECT 1 FROM cl WHERE boro=$b AND (label=$n OR fullname=$n) LIMIT 1", {'n': x['an'], 'b': boro}).fetchone() else fuzzy(x['an'], boro)
        pts = []
        for k in ('bn', 'b2n'):
            if not x.get(k): continue
            bn = x[k] if con.execute("SELECT 1 FROM cl WHERE boro=$b AND (label=$n OR fullname=$n) LIMIT 1", {'n': x[k], 'b': boro}).fetchone() else fuzzy(x[k], boro)
            m = meet(an, bn, boro)
            if m and m[2] < 60: pts.append(m)
            res.setdefault('matched', []).append([an, bn, None if not m else round(m[2])])
        if pts:
            res['ix_lon'] = sum(p[0] for p in pts) / len(pts); res['ix_lat'] = sum(p[1] for p in pts) / len(pts)
    if x.get('address'):
        g = geosearch(f"{x['address']}, {x['borough']}, NY")
        if g: res['addr'] = g
        time.sleep(0.2)
    out.append(res)
    print(x['site'], 'ix' if 'ix_lon' in res else '--', 'addr' if 'addr' in res else '--', res.get('matched'), flush=True)

with open(os.path.join(HERE, 'stations.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['site', 'borough', 'description', 'latitude', 'longitude', 'located'])
    for x in sorted(out, key=lambda r: r['site']):
        if 'ix_lon' in x: lat, lon, how = x['ix_lat'], x['ix_lon'], 'intersection'
        elif 'addr' in x: lat, lon, how = x['addr']['lat'], x['addr']['lon'], 'address'
        else: lat = lon = None; how = 'unplaced'
        if lat is not None and not (40.48 < lat < 40.93 and -74.27 < lon < -73.68): lat = lon = None; how = 'unplaced'
        w.writerow([x['site'], x['borough'], ' '.join(x['description'].split()),
                    None if lat is None else round(lat, 6), None if lon is None else round(lon, 6), how])
shutil.rmtree(work)
