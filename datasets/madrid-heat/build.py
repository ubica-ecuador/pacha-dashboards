"""Madrid's surface heat, by day and by night, against its countryside.

Called by build.sh, which explains the files. Writes into the directory given as
its only argument: day.tif and night.tif (paletted COGs) and the CSVs that
build.sql turns into Parquet. Needs GDAL's Python bindings and numpy.
"""
import calendar
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
OUT = Path(sys.argv[1])
WORK = OUT / 'work'
WORK.mkdir(parents=True, exist_ok=True)
MONTH = os.environ.get("MONTH", "2026-07")
STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1'
SAS = 'https://planetarycomputer.microsoft.com/api/sas/v1/token'
WORLDCOVER = ('https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'
              'ESA_WorldCover_10m_2021_v200_N39W006_Map.tif')
# The frame, in UTM 30N (EPSG:32630, the CRS of Landsat's scenes of Madrid): 60 km
# a side around Puerta del Sol, the city with its ring of towns and countryside.
X0, Y0, X1, Y1 = 410000, 4445000, 470000, 4505000
SOL = (-3.7038, 40.4168)
UTM = osr.SpatialReference()
UTM.ImportFromEPSG(32630)
WGS = osr.SpatialReference()
WGS.ImportFromEPSG(4326)
WGS.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
TO_UTM = osr.CoordinateTransformation(WGS, UTM)
TO_WGS = osr.CoordinateTransformation(UTM, WGS)
SX, SY, _ = TO_UTM.TransformPoint(*SOL)
# ESA WorldCover's classes, merged into the ones the charts name.
CLASSES = {10: 'Trees', 20: 'Scrub and grass', 30: 'Scrub and grass', 40: 'Cropland',
           50: 'Built-up', 60: 'Bare ground', 80: 'Water', 90: 'Water'}


def get_json(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def bbox_wgs():
    pts = [TO_WGS.TransformPoint(x, y)[:2] for x in (X0, X1) for y in (Y0, Y1)]
    return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]


def search(collection, query=None):
    body = {'collections': [collection], 'bbox': bbox_wgs(), 'limit': 200,
            'datetime': f'{MONTH}-01T00:00:00Z/{MONTH}-{calendar.monthrange(*map(int, MONTH.split("-")))[1]}T23:59:59Z'}
    if query:
        body['query'] = query
    return sorted(get_json(f'{STAC}/search', body)['features'], key=lambda f: f['id'])


def warp(href, token, res, resampling='near'):
    """The frame of a remote COG at res metres, as an array."""
    src = f'/vsicurl/{href}?{token}' if token else f'/vsicurl/{href}'
    ds = gdal.Warp('', src, format='MEM', dstSRS='EPSG:32630', outputBounds=(X0, Y0, X1, Y1),
                   xRes=res, yRes=res, resampleAlg=resampling)
    return ds.GetRasterBand(1).ReadAsArray()


def landsat():
    """July's clear Landsat 8 and 9 passes of path 201, row 32 (10:55 UTC, 12:55 in
    Madrid): surface temperature in °C at 30 m, clouds and their shadows masked,
    the median of the passes."""
    token = get_json(f'{SAS}/landsateuwest/landsat-c2')['token']
    scenes = [f for f in search('landsat-c2-l2', {'eo:cloud_cover': {'lt': 20}})
              if f['properties'].get('landsat:wrs_path') == '201' and f['properties'].get('landsat:wrs_row') == '032']
    stack, used = [], []
    for f in scenes:
        st = warp(f['assets']['lwir11']['href'], token, 30).astype(np.float32)
        qa = warp(f['assets']['qa_pixel']['href'], token, 30)
        # QA_PIXEL bits: 0 fill, 1 dilated cloud, 3 cloud, 4 cloud shadow.
        bad = (qa & 0b11011) != 0
        c = np.where(bad | (st == 0), np.nan, st * 0.00341802 + 149 - 273.15)
        stack.append(c)
        used.append(f['properties']['datetime'][:10])
        print(f"  {f['id']}: {100 * np.isnan(c).mean():.1f} % masked", flush=True)
    stack = np.stack(stack)
    valid = np.sum(~np.isnan(stack), axis=0)
    med = np.where(valid >= 2, np.nanmedian(np.where(valid >= 2, stack, 0), axis=0), np.nan)
    return med, used


def modis():
    """July's MODIS Terra passes (MOD11A1 v6.1, 1 km), day and night, good-quality
    retrievals only, the median of each. Terra has drifted since 2020: in July 2026
    it crossed Madrid at about 9:20 and 20:25 solar time, not 10:30 and 22:30."""
    token = get_json(f'{SAS}/modiseuwest/modis-061-cogs')['token']
    items = [f for f in search('modis-11A1-061') if f['id'].startswith('MOD11A1')]
    out = {}
    for part in ('Day', 'Night'):
        stack, times = [], []
        for f in items:
            lst = warp(f['assets'][f'LST_{part}_1km']['href'], token, 1000).astype(np.float32)
            qc = warp(f['assets'][f'QC_{part}']['href'], token, 1000)
            vt = warp(f['assets'][f'{part}_view_time']['href'], token, 1000).astype(np.float32)
            # QC bits 0-1: 00 good, 01 check bits 6-7 (LST error: 00 <= 1 K, 01 <= 2 K).
            ok = (lst > 0) & (((qc & 3) == 0) | (((qc & 3) == 1) & (((qc >> 6) & 3) <= 1)))
            stack.append(np.where(ok, lst * 0.02 - 273.15, np.nan))
            times.append(np.where(ok & (vt < 255), vt * 0.1, np.nan))
        stack = np.stack(stack)
        valid = np.sum(~np.isnan(stack), axis=0)
        med = np.where(valid >= 5, np.nanmedian(np.where(valid >= 5, stack, 0), axis=0), np.nan)
        out[part] = (med, valid, float(np.nanmedian(np.stack(times))), len(items))
        print(f'  MODIS {part}: {len(items)} days, local solar time {out[part][2]:.2f} h, '
              f'cells with 5+ clear nights/days {100 * np.mean(valid >= 5):.0f} %', flush=True)
    return out


def worldcover():
    """ESA WorldCover 2021 at 10 m, and its class at 30 m (the most common)."""
    wc10 = warp(WORLDCOVER, None, 10)
    wc30 = warp(WORLDCOVER, None, 30, 'mode')
    return wc10, wc30


# Diverging palette for °C against the countryside: blue cooler, red warmer.
# The ends are ±6 °C, so that night's few degrees read as clearly as day's.
STOPS = [(-6, (33, 102, 172)), (-3, (103, 169, 207)), (-1, (209, 229, 240)), (0, (247, 247, 247)),
         (1, (253, 219, 199)), (3, (239, 138, 98)), (6, (178, 24, 43))]


def colour(v):
    v = max(STOPS[0][0], min(STOPS[-1][0], v))
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if v <= b:
            t = (v - a) / (b - a)
            return tuple(round(ca[i] + t * (cb[i] - ca[i])) for i in range(3))
    return STOPS[-1][1]


def write_cog(name, anom, res):
    """uint8: 128 + 10 × °C (±12.7 °C in steps of 0.1), 0 where there is no value,
    with a colour table, so the tile server paints it (rasterPainted)."""
    code = np.where(np.isnan(anom), 0, np.clip(np.round(128 + 10 * np.nan_to_num(anom)), 1, 255)).astype(np.uint8)
    tmp = str(WORK / f'{name}.tif')
    ds = gdal.GetDriverByName('GTiff').Create(tmp, code.shape[1], code.shape[0], 1, gdal.GDT_Byte)
    ds.SetGeoTransform((X0, res, 0, Y1, 0, -res))
    ds.SetProjection(UTM.ExportToWkt())
    band = ds.GetRasterBand(1)
    # The colour table goes in before the pixels: GTiff refuses it afterwards.
    ct = gdal.ColorTable()
    ct.SetColorEntry(0, (0, 0, 0, 0))
    for k in range(1, 256):
        ct.SetColorEntry(k, colour((k - 128) / 10) + (255,))
    band.SetColorTable(ct)
    band.SetNoDataValue(0)
    band.WriteArray(code)
    ds = None
    gdal.Translate(str(OUT / f'{name}.tif'), tmp, format='COG',
                   creationOptions=['COMPRESS=DEFLATE', 'OVERVIEW_RESAMPLING=NEAREST', 'BLOCKSIZE=256'])


def blocks(a, k):
    """Means over k × k blocks (a's side is a multiple of k), NaN ignored."""
    h, w = a.shape
    b = a.reshape(h // k, k, w // k, k)
    with np.errstate(invalid='ignore'):
        return np.nanmean(b, axis=(1, 3))


def main():
    cache = WORK / 'inputs.npz'
    if cache.exists():
        # A rerun in the same work directory skips the downloads.
        z = np.load(cache, allow_pickle=True)
        day30, passes, m, wc10, wc30 = z['day30'], sorted(str(p) for p in z['passes']), z['m'].item(), z['wc10'], z['wc30']
    else:
        print('Landsat ...', flush=True)
        day30, passes = landsat()
        passes = sorted(passes)
        print('MODIS ...', flush=True)
        m = modis()
        print('WorldCover ...', flush=True)
        wc10, wc30 = worldcover()
        np.savez(cache, day30=day30, passes=np.array(passes), m=np.array(m, dtype=object), wc10=wc10, wc30=wc30)

    # The 1 km cells (60 × 60), the grid MODIS was warped to.
    n = (X1 - X0) // 1000
    share = {name: blocks(np.isin(wc10, [k for k, v in CLASSES.items() if v == name]).astype(np.float32), 100)
             for name in sorted(set(CLASSES.values()))}
    built, water = share['Built-up'], share['Water']
    # The countryside: cells under 5 % built and mostly not water.
    rural = (built < 0.05) & (water < 0.5)
    # Landsat's 30 m frame is 2000 px a side, not a multiple of 1 km's 33.3: average
    # it to 1 km with GDAL instead.
    mem = gdal.GetDriverByName('MEM').Create('', day30.shape[1], day30.shape[0], 1, gdal.GDT_Float32)
    mem.SetGeoTransform((X0, 30, 0, Y1, 0, -30))
    mem.SetProjection(UTM.ExportToWkt())
    mem.GetRasterBand(1).WriteArray(np.nan_to_num(day30, nan=-9999))
    mem.GetRasterBand(1).SetNoDataValue(-9999)
    day1k = gdal.Warp('', mem, format='MEM', outputBounds=(X0, Y0, X1, Y1), xRes=1000, yRes=1000,
                       resampleAlg='average', dstNodata=-9999).ReadAsArray()
    day1k = np.where(day1k == -9999, np.nan, day1k)
    # Landsat's countryside: its 30 m pixels inside the rural cells.
    ys = (np.arange(2000) * 30 + 15) // 1000
    rural30 = rural[np.ix_(ys, ys)]
    ref = {'landsat': float(np.nanmedian(day30[rural30])),
           'day': float(np.nanmedian(m['Day'][0][rural])),
           'night': float(np.nanmedian(m['Night'][0][rural]))}
    print('  countryside medians', {k: round(v, 2) for k, v in ref.items()}, 'rural cells', int(rural.sum()), flush=True)

    write_cog('day', day30 - ref['landsat'], 30)
    write_cog('night', m['Night'][0] - ref['night'], 1000)

    # cells.csv: one row per 1 km cell.
    with open(WORK / 'cells.csv', 'w') as f:
        names = sorted(share)
        f.write('px,py,x,y,longitude,latitude,dist_km,rural,' + ','.join(s.lower().replace(' ', '_').replace('-', '_') for s in names)
                + ',landsat,day,night,day_obs,night_obs\n')
        for r in range(n):
            for c in range(n):
                x, y = X0 + 1000 * c + 500, Y1 - 1000 * r - 500
                lon, lat, _ = TO_WGS.TransformPoint(x, y)
                vals = [day1k[r, c], m['Day'][0][r, c], m['Night'][0][r, c]]
                f.write(f'{c},{r},{x},{y},{lon:.6f},{lat:.6f},{np.hypot(x - SX, y - SY) / 1000:.3f},{str(bool(rural[r, c])).lower()},'
                        + ','.join(f'{share[s][r, c]:.4f}' for s in names) + ','
                        + ','.join('' if np.isnan(v) else f'{v:.2f}' for v in vals)
                        + f",{int(m['Day'][1][r, c])},{int(m['Night'][1][r, c])}\n")

    # landcover.csv: Landsat's 30 m pixels by WorldCover class, against the
    # countryside: how many, and their percentiles.
    anom = day30 - ref['landsat']
    with open(WORK / 'landcover.csv', 'w') as f:
        f.write('class,pixels,p10,p25,p50,p75,p90\n')
        for k in sorted(set(CLASSES.values())):
            v = anom[np.isin(wc30, [c for c, x in CLASSES.items() if x == k]) & ~np.isnan(anom)]
            f.write(f'{k},{v.size},' + ','.join(f'{q:.2f}' for q in np.percentile(v, [10, 25, 50, 75, 90])) + '\n')

    with open(WORK / 'summary.csv', 'w') as f:
        f.write('product,overpass,local_time,observations,countryside\n')
        f.write(f"landsat,Landsat 8 and 9 surface temperature (30 m),12:55,{len(passes)},{ref['landsat']:.2f}\n")
        for part, key in (('Day', 'day'), ('Night', 'night')):
            solar = m[part][2]
            # Madrid's clock (CEST, UTC+2) is 2 h 15 min ahead of its solar time.
            clock = (solar + 2 + 3.7038 / 15) % 24
            f.write(f"modis_{key},MODIS Terra {part.lower()} surface temperature (1 km),"
                    f"{int(clock):02d}:{round(clock % 1 * 60):02d},{m[part][3]},{ref[key]:.2f}\n")
    print('  Landsat passes', passes, flush=True)


main()
