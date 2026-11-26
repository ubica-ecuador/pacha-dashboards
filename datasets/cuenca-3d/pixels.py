# Sentinel-2 L2A true colour (TCI, 10 m) over the area of the build, one CSV row per pixel. The first scene is the base
# (12 September 2024, as the centre was first built from); where its scene classification (SCL, 20 m) says cloud,
# cloud shadow, cirrus or no data, the next scene's pixel is taken, and so on. The area: WEST SOUTH EAST NORTH (env).
import os, numpy as np, rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds
BASE = 'https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/17/M/QS'
SCENES = ['2024/9/S2B_T17MQS_20240912T154332_L2A', '2023/8/S2A_T17MQS_20230824T153624_L2A',
          '2023/9/S2B_T17MQS_20230908T153756_L2A', '2024/11/S2B_T17MQS_20241111T153851_L2A']
BAD = [0, 1, 3, 8, 9, 10]       # no data, saturated, cloud shadow, cloud medium/high, cirrus
GROW = 4
W, S_, E, N = (float(os.environ.get(k, v)) for k, v in (('WEST', -79.02), ('SOUTH', -2.91), ('EAST', -78.985), ('NORTH', -2.885)))
out = None
for k, sc in enumerate(SCENES):
    with rasterio.open(f'{BASE}/{sc}/TCI.tif') as src:
        if out is None:
            l, b, r, t = transform_bounds('EPSG:4326', src.crs, W - 0.002, S_ - 0.002, E + 0.002, N + 0.002)
            win = from_bounds(l, b, r, t, src.transform).round_offsets().round_lengths()
            tr = src.window_transform(win)
            bounds = rasterio.windows.bounds(win, src.transform)
        a = src.read(window=from_bounds(*bounds, src.transform).round_offsets().round_lengths())
    with rasterio.open(f'{BASE}/{sc}/SCL.tif') as scl:
        m = scl.read(1, window=from_bounds(*bounds, scl.transform), out_shape=a.shape[1:], resampling=Resampling.nearest)
    bad = np.isin(m, BAD) | (a.sum(axis=0) == 0)
    # SCL misses the thin edges of clouds and their shadows: grow the mask by GROW pixels (40 m).
    for _ in range(GROW):
        g = bad.copy(); g[1:] |= bad[:-1]; g[:-1] |= bad[1:]; g[:, 1:] |= bad[:, :-1]; g[:, :-1] |= bad[:, 1:]; bad = g
    good = ~bad
    if out is None:
        out = np.zeros_like(a); filled = np.zeros(a.shape[1:], bool); src_of = np.full(a.shape[1:], -1, np.int8)
    take = good & ~filled
    out[:, take] = a[:, take]; src_of[take] = k; filled |= take
    print(sc[-35:], 'fills', round(float(take.mean()), 3), 'still empty', round(float((~filled).mean()), 3))
_, h, wd = out.shape
with open('/work/pixels.csv', 'w') as f:
    f.write('col,row,x,y,r,g,b,scene\n')
    for j in range(h):
        for i in range(wd):
            if not filled[j, i]:
                continue
            x, y = tr * (i + 0.5, j + 0.5)
            f.write(f'{i},{j},{x:.1f},{y:.1f},{out[0,j,i]},{out[1,j,i]},{out[2,j,i]},{src_of[j,i]}\n')
print(out.shape, 'mean rgb', out.reshape(3, -1).mean(axis=1))
