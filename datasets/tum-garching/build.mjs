// Builds the TUM Garching campus files for datasets/tum-garching/build.sh: the Mathematics and Informatics building and
// the Mechanical Engineering building inside (rooms, corridors and doors as mapped in OpenStreetMap, ODbL), every other
// building of the campus as a facade, the kind of every room and one day's lectures from NavigaTUM (nav.tum.de, TUM's
// open campus API, from TUMonline). Written by the Kepler Plus showcase builder first (its floors-campus dashboard);
// here it writes newline-delimited JSON for DuckDB instead of a dashboard.
//
//   node build.mjs <work dir> [YYYY-MM-DD]
//
// The inputs are downloaded into the work dir: the OSM map of the campus (api.openstreetmap.org), NavigaTUM's data
// (70 MB, kept as the two buildings' rooms only) and the day's calendar (10 rooms a request, as NavigaTUM asks).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { union } from 'polyclip-ts';
import buffer from '@turf/buffer';


const [cache, day = '2026-11-10'] = process.argv.slice(2);
if (!cache) {
  console.error('usage: node build.mjs <work dir> [YYYY-MM-DD]');
  process.exit(1);
}
mkdirSync(cache, { recursive: true });
const AGENT = { 'user-agent': 'pacha-dashboards tum-garching dataset builder' };
const BBOX = '11.6640,48.2615,11.6760,48.2690';
const LEVELS = [-1, 0, 1, 2, 3, 4];
const FLOOR_NAMES = {
  '-1': 'Basement',
  0: 'Ground floor',
  1: '1st floor',
  2: '2nd floor',
  3: '3rd floor',
  4: '4th floor',
};
/** The buildings drawn inside: their rooms by TUM's code, their footprint in OSM by its name. */
const BUILDINGS = [
  { id: 'MI', label: 'Mathematics and Informatics', code: /^56(0|1)/, footprint: /^TUM School of Computation/ },
  { id: 'MW', label: 'Mechanical Engineering', code: /^55/, footprint: /^TUM School of Engineering and Design/ },
];
/** A floor's height for a building OSM gives levels but no height. */
const STOREY_M = 4;
// Central European Time in November (the day's local times; the dashboard shows Europe/Berlin).
const UTC_OFFSET_H = 1;
const SLOT_MS = 15 * 60 * 1000;
const WALL_HEIGHT_M = 1.2;
const WALL_THICKNESS_M = 0.16;
const DOOR_M = 0.9;

// --- inputs ---------------------------------------------------------------------------------------------------------
async function cached(name, fetchIt) {
  const path = join(cache, name);
  if (!existsSync(path)) {
    console.log(`fetching ${name}…`);
    writeFileSync(path, await fetchIt());
  }
  return readFileSync(path, 'utf8');
}
const osmXml = await cached('campus.osm', async () => {
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${BBOX}`, { headers: AGENT });
  if (!res.ok) {
    throw new Error(`OSM ${res.status}`);
  }
  return res.text();
});
const navigatum = JSON.parse(
  await cached('navigatum-campus.json', async () => {
    const res = await fetch('https://nav.tum.de/cdn/api_data.json', { headers: AGENT });
    const all = await res.json();
    return JSON.stringify(all.filter((x) => x.type === 'room' && BUILDINGS.some((b) => b.code.test(String(x.id)))));
  })
);
const roomInfo = new Map(navigatum.map((x) => [x.id, x]));
const calendar = JSON.parse(
  await cached(`calendar-campus-${day}.json`, async () => {
    const ids = navigatum.filter((x) => x.props?.calendar_url).map((x) => x.id);
    const start = new Date(`${day}T00:00:00Z`).getTime() - UTC_OFFSET_H * 3600e3;
    const window = { start_after: new Date(start).toISOString(), end_before: new Date(start + 86400e3).toISOString() };
    const out = {};
    const ask = async (batch) => {
      const res = await fetch('https://nav.tum.de/api/calendar', {
        method: 'POST',
        headers: { ...AGENT, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: batch, ...window }),
      });
      if (!res.ok) {
        throw new Error(String(res.status));
      }
      Object.assign(out, await res.json());
    };
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      try {
        await ask(batch);
      } catch {
        // One room the calendar cannot answer fails its batch: ask for each alone.
        for (const id of batch) {
          await ask([id]).catch(() => console.log(`no calendar for ${id}`));
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return JSON.stringify(out);
  })
);

// --- OpenStreetMap ----------------------------------------------------------------------------------------------------
const attrs = (text) => Object.fromEntries([...text.matchAll(/(\w[\w:]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const unescape = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const tagsOf = (body) =>
  Object.fromEntries(
    [...(body ?? '').matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)].map((m) => [m[1], unescape(m[2])])
  );
const nodes = new Map();
const ways = [];
const relations = [];
for (const m of osmXml.matchAll(/<(node|way|relation)\s([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
  const a = attrs(m[2]);
  if (m[1] === 'node') {
    nodes.set(a.id, { lon: Number(a.lon), lat: Number(a.lat), tags: tagsOf(m[3]) });
  } else if (m[1] === 'way') {
    ways.push({ id: a.id, refs: [...(m[3] ?? '').matchAll(/<nd ref="(\d+)"/g)].map((r) => r[1]), tags: tagsOf(m[3]) });
  } else {
    const members = [...(m[3] ?? '').matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].map((r) => ({
      ref: r[1],
      role: r[2],
    }));
    relations.push({ id: a.id, members, tags: tagsOf(m[3]) });
  }
}
const wayById = new Map(ways.map((w) => [w.id, w]));
const ringOf = (way) => way.refs.map((r) => nodes.get(r)).map((n) => [n.lon, n.lat]);
const closed = (way) => way.refs.length >= 4 && way.refs[0] === way.refs[way.refs.length - 1];
const complete = (way) => way.refs.every((r) => nodes.has(r));
/** A multipolygon's outer rings, its member ways joined end to end; rings with a node outside the map are left out. */
function outerRings(relation) {
  const parts = relation.members
    .filter((m) => m.role === 'outer')
    .map((m) => wayById.get(m.ref))
    .filter((w) => w && complete(w))
    .map((w) => [...w.refs]);
  const rings = [];
  while (parts.length) {
    let ring = parts.shift();
    let grown = true;
    while (ring[0] !== ring[ring.length - 1] && grown) {
      grown = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const end = ring[ring.length - 1];
        if (p[0] === end) {
          ring = [...ring, ...p.slice(1)];
        } else if (p[p.length - 1] === end) {
          ring = [...ring, ...[...p].reverse().slice(1)];
        } else {
          continue;
        }
        parts.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) {
      rings.push(ring.map((r) => nodes.get(r)).map((n) => [n.lon, n.lat]));
    }
  }
  return rings;
}

function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
// A ring in metres east and north of its first corner: products of whole longitudes and latitudes (11.66 × 48.26) cancel
// out to noise at a room's size, tens of metres off.
const metres = (ring) => {
  const [x0, y0] = ring[0];
  const k = mPerDegLng(y0);
  return ring.map(([x, y]) => [(x - x0) * k, (y - y0) * M_PER_DEG_LAT]);
};
const centroid = (ring) => {
  // The area-weighted centre of a ring; its corners' mean for a degenerate one.
  const pts = metres(ring);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  const [mx, my] =
    Math.abs(a) < 1e-6
      ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
      : [cx / (3 * a), cy / (3 * a)];
  return [ring[0][0] + mx / mPerDegLng(ring[0][1]), ring[0][1] + my / M_PER_DEG_LAT];
};
const areaM2 = (ring) => {
  const pts = metres(ring);
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return Math.abs(a / 2);
};
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r7 = (v) => Math.round(v * 1e7) / 1e7;
const roundRing = (ring) => ring.map(([x, y]) => [r7(x), r7(y)]);

const boxOf = (ring) =>
  ring.reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
// Each building's footprint: a way named so, or a multipolygon's outer ring.
for (const b of BUILDINGS) {
  const way = ways.find((w) => b.footprint.test(w.tags.name ?? '') && closed(w) && complete(w));
  // The building's multipolygon, not another relation of the same name (the school's site).
  const relation = relations.find(
    (r) =>
      b.footprint.test(r.tags.name ?? '') &&
      r.tags.type === 'multipolygon' &&
      r.tags.building &&
      outerRings(r).length > 0
  );
  b.ring = way ? ringOf(way) : relation ? outerRings(relation)[0] : null;
  b.osm = way ? `way:${way.id}` : relation ? `relation:${relation.id}` : null;
  if (!b.ring) {
    throw new Error(`the footprint of ${b.label} is not in the map`);
  }
  b.box = boxOf(b.ring);
}
// Within 15 m of a footprint's box.
const near = ([x, y], box) =>
  x > box[0] - 15 / mPerDegLng(y) &&
  x < box[2] + 15 / mPerDegLng(y) &&
  y > box[1] - 15 / M_PER_DEG_LAT &&
  y < box[3] + 15 / M_PER_DEG_LAT;
/** The building a room or corridor is in: by TUM's code near its footprint, else by the footprint it stands in. */
const buildingOf = (code, centre) =>
  BUILDINGS.find((b) => code && b.code.test(code) && near(centre, b.box)) ??
  BUILDINGS.find((b) => inside(centre, b.ring));

/** The levels a feature stands on: "1", "0;1", "-1-0" (a span); fractional landings are left out. */
function levelsOf(value) {
  const out = new Set();
  for (const part of String(value ?? '').split(';')) {
    const span = part.trim().match(/^(-?\d+)-(-?\d+)$/);
    if (span) {
      for (let l = Number(span[1]); l <= Number(span[2]); l++) {
        out.add(l);
      }
    } else if (/^-?\d+$/.test(part.trim())) {
      out.add(Number(part.trim()));
    }
  }
  return [...out].filter((l) => LEVELS.includes(l)).sort((a, b) => a - b);
}

// --- rooms ------------------------------------------------------------------------------------------------------------
const KINDS = [
  ['Lecture hall', '#f4c08f'],
  ['Teaching room', '#f7dfa0'],
  ['Office', '#dde8f4'],
  ['Meeting room', '#c9daf0'],
  ['Lab', '#d4ecd9'],
  ['Library and study', '#e6dcf3'],
  ['Social', '#f4d6e2'],
  ['Toilets', '#d3e6ef'],
  ['Stairs and lifts', '#dcd7e8'],
  ['Services', '#e9e8e4'],
  ['Corridor', '#ffffff'],
];
// The kind of a room from NavigaTUM's use (or OSM's room=* when NavigaTUM has none), first rule that matches.
const KIND_RULES = [
  [/lecture hall|auditorium/, 'lecture', 'Lecture hall'],
  [/classroom|seminar|exercise|student workroom|tutorial|pc pool|computer/, null, 'Teaching room'],
  [/meeting|conference/, null, 'Meeting room'],
  [/office|secretariat|copy|reception/, 'office', 'Office'],
  [/laborator|server|workshop/, null, 'Lab'],
  [/library|reading|study/, null, 'Library and study'],
  [/kitchen|social|lounge|cafe|cafeteria|balcony|common/, null, 'Social'],
  [/\bwc\b|toilet|shower|changing/, 'toilets', 'Toilets'],
  [/stair|elevator|lift/, 'stairs', 'Stairs and lifts'],
  [/corridor|hall|foyer|lobby|entrance|magistrale/, null, 'Corridor'],
];
function kindOf(usage, osmRoom) {
  const u = (usage ?? '').toLowerCase();
  return KIND_RULES.find(([use, room]) => use.test(u) || (room !== null && osmRoom === room))?.[2] ?? 'Services';
}
// "5606.EG.011 (MI Hörsaal 3)" → "MI Hörsaal 3"; a name that only says the room's use ("Büro", "Unterrichtsraum ohne
// Infrastruktur") is no name: such a room goes by its architect's number, 00.06.011, as the building's signs do.
const GENERIC =
  /^(büro|wimi büro|flur|wc|lager|seminar|seminarraum|übung|übungsraum|besprechungsraum|unter+richts+raum.*|einzelarbeitsraum|gruppenarbeitsraum|praktikumsraum|treppenhaus|aufzug|teeküche|sekretariat|labor.*|technik.*)$/i;
function nameOf(info) {
  const m = String(info?.name ?? '').match(/\((.*)\)\s*$/);
  const name = m ? m[1].trim() : '';
  const usage = info?.usage?.name?.de ?? '';
  return name && name.toLowerCase() !== usage.toLowerCase() && !GENERIC.test(name) ? name : '';
}
const architects = (info) => (info?.props?.computed ?? []).find((c) => c.name?.en === "Architect's name")?.text ?? '';

const features = [];
for (const way of ways) {
  const t = way.tags;
  if (!['room', 'corridor', 'area'].includes(t.indoor) || !closed(way)) {
    continue;
  }
  const levels = levelsOf(t.level);
  const ring = ringOf(way);
  const code = t['ref:tum'] ?? '';
  const building = buildingOf(code, centroid(ring));
  if (!levels.length || !building) {
    continue;
  }
  const info = roomInfo.get(code);
  const usage = info?.usage?.name?.en ?? '';
  const kind = t.indoor === 'room' ? kindOf(usage, t.room) : 'Corridor';
  const named = t.name && !GENERIC.test(t.name) ? t.name : nameOf(info);
  features.push({
    way,
    ring,
    levels,
    code,
    info,
    usage,
    kind,
    name: named,
    ref: t.ref || architects(info),
    building: building.id,
  });
}

// --- the day's lectures ----------------------------------------------------------------------------------------------
const TYPES = {
  Vorlesung: 'Lecture',
  Übung: 'Exercise class',
  Seminar: 'Seminar',
  Praktikum: 'Lab course',
  Prüfung: 'Exam',
};
const events = Object.values(calendar)
  .flatMap((c) => c.events ?? [])
  .filter((e) => e.entry_type !== 'barred');
const eventsByRoom = new Map();
for (const e of events) {
  eventsByRoom.set(e.room_code, [...(eventsByRoom.get(e.room_code) ?? []), e]);
}
const local = (iso) => {
  const d = new Date(new Date(iso).getTime() + UTC_OFFSET_H * 3600e3);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// --- frames -----------------------------------------------------------------------------------------------------------
const polygon = (ring) => JSON.stringify({ type: 'Polygon', coordinates: [roundRing(ring)] });
const level = (f) => (f.levels.length > 1 ? f.levels.join(';') : String(f.levels[0]));
const floorName = (f) => f.levels.map((l) => FLOOR_NAMES[l]).join(', ');

const rooms = features
  .filter((f) => f.kind !== 'Corridor')
  .map((f) => ({
    room: f.name || f.ref || f.code,
    building: f.building,
    code: f.code,
    kind: f.kind,
    use: f.usage || 'Not listed',
    level: level(f),
    floor_name: floorName(f),
    lectures: (eventsByRoom.get(f.code) ?? []).length,
    area_m2: Math.round(areaM2(f.ring)),
    geometry: polygon(f.ring),
  }));
const corridors = features
  .filter((f) => f.kind === 'Corridor')
  .map((f) => ({
    room: f.name || 'Corridor',
    building: f.building,
    level: level(f),
    floor_name: floorName(f),
    geometry: polygon(f.ring),
  }));

// A slab per floor: its rooms and corridors grown by half a wall, merged, shrunk back; small holes filled.
const GROW_M = 0.5;
const slabs = [];
for (const [b, l] of BUILDINGS.flatMap((x) => LEVELS.map((lv) => [x.id, lv]))) {
  const parts = features
    .filter((f) => f.building === b && f.levels.includes(l))
    .map((f) =>
      buffer({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [f.ring] } }, GROW_M, {
        units: 'meters',
        steps: 1,
      })
    )
    .filter((g) => g?.geometry)
    .map((g) => (g.geometry.type === 'Polygon' ? [g.geometry.coordinates] : g.geometry.coordinates));
  if (!parts.length) {
    continue;
  }
  const merged = union(...parts.flat().map((p) => [p]));
  const shrunk = buffer(
    { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: merged } },
    -GROW_M,
    {
      units: 'meters',
      steps: 1,
    }
  );
  const polys = (shrunk.geometry.type === 'Polygon' ? [shrunk.geometry.coordinates] : shrunk.geometry.coordinates)
    .map((p) => [p[0], ...p.slice(1).filter((hole) => areaM2(hole) > 12)].map(roundRing))
    .filter((p) => areaM2(p[0]) > 4);
  slabs.push({
    building: b,
    level: String(l),
    floor_name: FLOOR_NAMES[l],
    geometry: JSON.stringify({ type: 'MultiPolygon', coordinates: polys }),
  });
}

// Walls: every room edge once (two rooms share their nodes), a slab WALL_THICKNESS_M thick, open DOOR_M at each door.
const doorWidth = (id) => {
  const n = nodes.get(id);
  if (!n || !(n.tags.door || n.tags.entrance)) {
    return 0;
  }
  const w = Number.parseFloat(n.tags.width);
  return Number.isFinite(w) && w > 0.5 && w < 4 ? w : DOOR_M;
};
const wallsByLevel = new Map();
const seen = new Set();
for (const f of features.filter((x) => x.kind !== 'Corridor')) {
  const l = f.levels[0];
  const here = `${f.building}|${l}`;
  const slabsHere = wallsByLevel.get(here) ?? [];
  wallsByLevel.set(here, slabsHere);
  for (let i = 0; i < f.way.refs.length - 1; i++) {
    const [ia, ib] = [f.way.refs[i], f.way.refs[i + 1]];
    const key = `${l}:${ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const a = nodes.get(ia);
    const b = nodes.get(ib);
    const kx = mPerDegLng(a.lat);
    const dx = (b.lon - a.lon) * kx;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    const s0 = doorWidth(ia) / 2;
    const s1 = len - doorWidth(ib) / 2;
    if (s1 - s0 < 0.15) {
      continue;
    }
    const [ux, uy] = [dx / len, dy / len];
    const half = WALL_THICKNESS_M / 2;
    const at = (s, side) => [r7(a.lon + (ux * s - uy * side) / kx), r7(a.lat + (uy * s + ux * side) / M_PER_DEG_LAT)];
    const from = s0 > 0 ? s0 : -half;
    const to = s1 < len ? s1 : len + half;
    const ring = [at(from, -half), at(to, -half), at(to, half), at(from, half)];
    slabsHere.push([[...ring, ring[0]]]);
  }
}
const walls = [...wallsByLevel.entries()].map(([here, polys]) => ({
  building: here.split('|')[0],
  level: here.split('|')[1],
  floor_name: FLOOR_NAMES[here.split('|')[1]],
  height_m: WALL_HEIGHT_M,
  geometry: JSON.stringify({ type: 'MultiPolygon', coordinates: polys }),
}));

// The rooms in a lecture, a row per room and quarter hour: the panel keeps the quarters in the dashboard's range, so the
// rooms light up as the time moves. Two bookings of one room in one quarter (a lecture and its exercise class) are one
// row, the lecture's.
const byCode = new Map(features.filter((f) => f.code).map((f) => [f.code, f]));
const lectures = [];
const titles = [];
const onNow = [];
const taken = new Set();
const RANK = { Vorlesung: 0, Seminar: 1, Übung: 2 };
for (const e of [...events].sort((a, b) => (RANK[a.stp_type] ?? 3) - (RANK[b.stp_type] ?? 3))) {
  const f = byCode.get(e.room_code);
  if (!f) {
    continue;
  }
  const start = Math.floor(new Date(e.start_at).getTime() / SLOT_MS) * SLOT_MS;
  const end = new Date(e.end_at).getTime();
  // The callout stands over the room's middle.
  const [lng, lat] = centroid(f.ring);
  const title = e.title_en || e.title_de || 'Booked';
  for (let t = start; t < end; t += SLOT_MS) {
    if (taken.has(`${e.room_code}@${t}`)) {
      continue;
    }
    taken.add(`${e.room_code}@${t}`);
    lectures.push({
      slot: t,
      room: f.name || f.ref || f.code,
      code: f.code,
      building: f.building,
      title,
      type: TYPES[e.stp_type] ?? 'Other',
      when: `${local(e.start_at)}–${local(e.end_at)}`,
      level: level(f),
      floor_name: floorName(f),
      in_lecture: 1,
      geometry: polygon(f.ring),
    });
    // The table's row: the lecture in its quarter, no shape.
    onNow.push({
      slot: t,
      when: `${local(e.start_at)}–${local(e.end_at)}`,
      title,
      type: TYPES[e.stp_type] ?? 'Other',
      room: f.name || f.ref || f.code,
      floor: FLOOR_NAMES[f.levels[0]],
      building: BUILDINGS.find((b) => b.id === f.building).label,
      code: f.code,
    });
    // Its callout: a card on a stem over the room, "room · lecture" and the minutes left. A point of its own, so it
    // drops out zoomed out, where the buildings stand as facades. The quarter is a number here, not a time: a time
    // column would give the card a chart.
    titles.push({
      slot: t,
      room: f.name || f.ref || f.code,
      title: short(title, 44),
      building: f.building,
      level: level(f),
      min_left: Math.max(0, Math.round((end - t) / 60000)),
      latitude: r6(lat),
      longitude: r6(lng),
    });
  }
}
// The day's quarters, for the Time Brush: how many rooms are in a lecture, 07:00 to 21:00.
const dayStart = new Date(`${day}T07:00:00Z`).getTime() - UTC_OFFSET_H * 3600e3;
const quarters = [];
for (let t = dayStart; t < dayStart + 14 * 3600e3; t += SLOT_MS) {
  quarters.push({ time: t, rooms_in_lecture: lectures.filter((r) => r.slot === t).length });
}

// The campus's buildings as facades, each its footprint raised to its height (OSM's height, else its levels × STOREY_M):
// all of them zoomed out, the ones not looked at indoors. The two drawn inside go by their ids, so their own facade gives
// way to their floors.
const heightOf = (tags) => {
  const h = Number.parseFloat(tags.height);
  const levels = Number.parseFloat(tags['building:levels']);
  return Number.isFinite(h) && h > 0 ? h : Number.isFinite(levels) && levels > 0 ? levels * STOREY_M : 2 * STOREY_M;
};
const shells = [];
for (const b of BUILDINGS) {
  const tags = b.osm.startsWith('way:')
    ? wayById.get(b.osm.slice(4)).tags
    : relations.find((r) => `relation:${r.id}` === b.osm).tags;
  shells.push({ building: b.id, name: b.label, height_m: Math.max(heightOf(tags), 4 * STOREY_M), ring: b.ring });
}
const skip = new Set(BUILDINGS.map((b) => b.osm));
const wanted = (tags) => tags.building && !['roof', 'no', 'construction'].includes(tags.building);
for (const w of ways) {
  if (wanted(w.tags) && closed(w) && complete(w) && !skip.has(`way:${w.id}`)) {
    shells.push({ building: `osm-way-${w.id}`, name: w.tags.name ?? '', height_m: heightOf(w.tags), ring: ringOf(w) });
  }
}
for (const r of relations) {
  if (wanted(r.tags) && r.tags.type === 'multipolygon' && !skip.has(`relation:${r.id}`)) {
    for (const ring of outerRings(r)) {
      shells.push({ building: `osm-relation-${r.id}`, name: r.tags.name ?? '', height_m: heightOf(r.tags), ring });
    }
  }
}
const facades = shells
  .filter((x) => areaM2(x.ring) > 40)
  .map((x) => ({ building: x.building, name: x.name, height_m: x.height_m, geometry: polygon(x.ring) }));


// --- the files --------------------------------------------------------------------------------------------------------
if (!lectures.length) {
  throw new Error(`NavigaTUM lists no lectures in these rooms on ${day}: build another weekday (DAY=YYYY-MM-DD)`);
}
const write = (name, rows) =>
  writeFileSync(join(cache, `${name}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
write('rooms', rooms);
write('corridors', corridors);
write('slabs', slabs);
write('walls', walls);
write('facades', facades);
// One row per room and quarter hour in a lecture: the map's lit room (its outline), its callout (a short title, the
// minutes left, the room's middle) and the table's row, the three made together above.
write(
  'lectures',
  lectures.map((l, i) => ({
    slot: l.slot,
    code: l.code,
    room: l.room,
    building: l.building,
    building_name: onNow[i].building,
    title: l.title,
    title_short: titles[i].title,
    type: l.type,
    when: l.when,
    level: l.level,
    floor_name: l.floor_name,
    floor: onNow[i].floor,
    min_left: titles[i].min_left,
    latitude: titles[i].latitude,
    longitude: titles[i].longitude,
    geometry: l.geometry,
  }))
);
write('quarters', quarters);
console.log(
  `${rooms.length} rooms, ${corridors.length} corridors, ${slabs.length} floors, ${facades.length} facades, ` +
    `${lectures.length} room-quarters in a lecture on ${day}`
);
