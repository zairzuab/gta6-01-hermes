// Shared helpers for PORT AZUL: the seeded PRNG, math and easing, the game's
// heading convention, canvas textures, colour work, geometry batching, GPU
// disposal and HUD formatting. The city, the vehicles, the props and the HUD
// all draw from here so their random draws and their conventions agree.
//
// Every generator takes its stream as an argument (mulberry32 for a reproducible
// run, Math.random where variety is fine), which is what lets a screenshot preset
// pin a seed and replay the same city. Nothing in this file touches the DOM except
// to build a canvas texture.
import * as THREE from 'three';

// ===========================================================================
// Seeded randomness
// ===========================================================================

/**
 * mulberry32 — a small, fast, seedable PRNG returning floats in [0, 1).
 * Deterministic per seed, so one seed lays out one identical city.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A float in [lo, hi) drawn from a stream. */
export function randRange(rnd, lo, hi) { return lo + rnd() * (hi - lo); }

/** An inclusive integer in [lo, hi] drawn from a stream. */
export function randInt(rnd, lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

/** One element of `arr`, drawn from a stream. */
export function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

// ===========================================================================
// Scalar maths and easing
// ===========================================================================

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach; `rate` is speed per second. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Hermite smoothstep, for easing camera and UI motion. */
export function smoothstep(t) { return t * t * (3 - 2 * t); }

/** Move `cur` toward `target` by at most `maxDelta`. */
export function moveTowards(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

// ===========================================================================
// Headings and distances
// ===========================================================================

export const TAU = Math.PI * 2;

/**
 * Smallest signed difference between two headings. `damp` is deliberately not
 * used here: a camera should reach its target heading at a bounded rate rather
 * than asymptotically, so a half turn takes the same time on any frame.
 */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Squared distance — cheap rejection test for nearest-of queries. */
export function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

/** Plain distance, for callers that only need a magnitude once. */
export function dist(ax, az, bx, bz) { return Math.sqrt(dist2(ax, az, bx, bz)); }

/** The heading that faces from (ax,az) toward (bx,bz), in the game's convention. */
export function headingTo(ax, az, bx, bz) { return Math.atan2(-(bx - ax), -(bz - az)); }

// ===========================================================================
// Canvas textures
// ===========================================================================

/** A canvas texture with sRGB colour space and repeat wrapping. */
export function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
// Colour
// ===========================================================================

/** Multiply a #rrggbb colour's channels by f, for shading a facade. */
export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.min(255, Math.max(0, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** Interpolate two hex colours, returning a THREE.Color. */
export function mixColor(hexA, hexB, t) {
  return new THREE.Color(hexA).lerp(new THREE.Color(hexB), t);
}

/** Window colours that read as lit at night: a facade's window ramp. */
export const WINDOW_LIT = ['#ffd98a', '#ffe6b0', '#fff3c8', '#cfe6ff'];

// ===========================================================================
// Geometry batching
// ===========================================================================

/**
 * Merge transformed copies of geometries into one non-indexed BufferGeometry.
 * Used to build a whole palm crown (or a cluster of nuts) as a single draw call
 * instead of one mesh per frond.
 */
export function mergeGeoms(parts) {
  const pos = [], norm = [], uv = [], col = [];
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const { geo, matrix, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    if (color !== undefined) c.setHex(color); else c.setRGB(1, 1, 1);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      pos.push(v.x, v.y, v.z);
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        norm.push(v.x, v.y, v.z);
      } else {
        norm.push(0, 1, 0);
      }
      if (u) uv.push(u.getX(i), u.getY(i));
      else uv.push(0, 0);
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/**
 * Merge the direct-child meshes of `group` that share a material into one mesh
 * each, so a model built out of dozens of primitives costs a handful of draw
 * calls. Textured, transparent and skipped children are left alone.
 */
export function mergeSharedMaterials(group, skip = null) {
  const buckets = new Map();
  const merged = [];
  for (const child of group.children) {
    if (!child.isMesh) continue;
    const m = child.material;
    if (!m || m.transparent || m.map || (skip && skip(child))) continue;
    if (!buckets.has(m)) buckets.set(m, []);
    child.updateMatrix();
    buckets.get(m).push({ geo: child.geometry, matrix: child.matrix.clone() });
    merged.push(child);
  }
  if (merged.length === 0) return 0;
  const kept = group.children.filter((c) => !merged.includes(c));
  group.clear();
  for (const child of kept) group.add(child);
  let made = 0;
  for (const [m, parts] of buckets) {
    if (parts.length === 1) {
      const mesh = new THREE.Mesh(parts[0].geo, m);
      mesh.matrix.copy(parts[0].matrix);
      mesh.matrixAutoUpdate = false;
      // A single-part bucket is still a rebuilt mesh, so it needs the same
      // shadow flag the merged ones get or that part of the model loses its
      // shadow.
      mesh.castShadow = true;
      group.add(mesh);
      continue;
    }
    const mesh = new THREE.Mesh(mergeGeoms(parts), m);
    mesh.castShadow = true;
    group.add(mesh);
    made++;
  }
  return made;
}

// ===========================================================================
// GPU resource ownership
// ===========================================================================

/**
 * True for a geometry or material that belongs to a module-level cache and is
 * shared by many meshes. `disposeGroup` uses this to release only per-instance
 * resources; disposing a shared one would break every other model.
 */
export function isSharedResource(r) {
  return !!(r && r.userData && r.userData.shared);
}

/**
 * Release the per-instance GPU resources under `root`: every geometry and
 * material not flagged shared. Called when a car is replaced, stolen or a police
 * unit is cleared, so a long session does not accumulate buffers for cars that
 * are no longer on the road.
 */
export function disposeGroup(root) {
  if (!root) return;
  const release = (x) => {
    if (!x || isSharedResource(x)) return;
    // A material's map is a GPU resource of its own; a per-instance texture
    // (a decal, a plate) must go with the material or it leaks on every stolen
    // car and cleared cruiser.
    const map = x.map;
    if (map && !isSharedResource(map)) map.dispose();
    x.dispose();
  };
  root.traverse((o) => {
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    const g = o.geometry;
    if (g && !isSharedResource(g)) g.dispose();
    const m = o.material;
    if (Array.isArray(m)) m.forEach(release);
    else release(m);
  });
}

// ===========================================================================
// Formatting for the HUD
// ===========================================================================

/** Millions-formatted money, matching the HUD's counter. */
export function formatMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

/** "HH:MM" from minutes since midnight, for the HUD clock. */
export function formatClock(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
