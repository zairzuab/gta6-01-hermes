// Procedural vehicles, pedestrians and pickups.
//
// Everything is assembled from a small cache of shared primitives plus canvas
// decals, so a whole city of traffic costs a handful of draw calls per model.
// A vehicle faces local -z (nose at -z, tail at +z). Wheels spin about their
// local X axle; the main rotor spins about Y, the tail rotor about X. A
// pedestrian's limbs pivot at the hip and shoulder.
//
// Layout of this module:
//   1. primitive cache      - box/cylinder/sphere geometries, built once
//   2. materials            - a procedural sky cube and the shared material set
//   3. kit                  - records a model's parts, then realizes them
//   4. decals               - canvas lettering, number plates, stars
//   5. wheels               - a wheel group collapsed to one vertex-coloured mesh
//   6. cars                 - nine silhouettes, liveries, driver and cargo
//   7. helicopter / tank    - the air unit and the armoured response
//   8. person / pickup      - the walker and the glowing collectables
import * as THREE from 'three';
import { clamp, mergeGeoms, mergeSharedMaterials } from './util.js';

// ---------------------------------------------------------------------------
// 1. Primitive cache. Every geometry here is shared by every model, so each is
// tagged: disposeGroup must never release a resource other cars still use.
// ---------------------------------------------------------------------------
const PRIMS = new Map();
function prim(key, make) {
  let g = PRIMS.get(key);
  if (!g) {
    g = make();
    g.userData.shared = true;
    PRIMS.set(key, g);
  }
  return g;
}
const boxGeo = (w, h, d) => prim(`b${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylGeo = (rt, rb, h, seg = 14) =>
  prim(`c${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
const sphGeo = (r, w = 16, h = 12) =>
  prim(`s${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h));
/** A limb box whose origin sits on its top edge, so it swings from the joint. */
const limbGeo = (w, h, d) => prim(`l${w}|${h}|${d}`, () => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, -h / 2, 0);
  return g;
});

// ---------------------------------------------------------------------------
// 2. Materials. A tiny procedural sky cube is the environment map on paint,
// chrome and glass; it is what keeps a cheap box model reading as a car.
// ---------------------------------------------------------------------------
function makeEnvCube() {
  const faces = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 64);
    if (i === 2) { grad.addColorStop(0, '#dcefff'); grad.addColorStop(1, '#8fc4ee'); }
    else if (i === 3) { grad.addColorStop(0, '#2c3244'); grad.addColorStop(1, '#12161f'); }
    else { grad.addColorStop(0, '#8fc4ee'); grad.addColorStop(0.55, '#cfe2ee'); grad.addColorStop(1, '#e8c9a0'); }
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    // A hot streak on the side faces reads as a low sun in the paintwork.
    if (i === 0 || i === 1 || i === 4 || i === 5) {
      const rg = g.createRadialGradient(32, 40, 2, 32, 40, 26);
      rg.addColorStop(0, 'rgba(255,244,214,0.95)');
      rg.addColorStop(1, 'rgba(255,244,214,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    }
    faces.push(c);
  }
  const tex = new THREE.CubeTexture(faces);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
const ENV = makeEnvCube();

const MATERIALS = new Map();
function cachedMat(key, make) {
  let m = MATERIALS.get(key);
  if (!m) {
    m = make();
    m.userData.shared = true;
    MATERIALS.set(key, m);
  }
  return m;
}
/** Glossy painted metal: the body colour of a car. */
const painted = (color) => cachedMat(`paint|${color}`, () => new THREE.MeshStandardMaterial({
  color, roughness: 0.34, metalness: 0.62, envMap: ENV, envMapIntensity: 0.85,
}));
/** Flat, mostly-non-metallic trim: plastic, cloth, skin, cargo. */
const matte = (color) => cachedMat(`matte|${color}`, () => new THREE.MeshStandardMaterial({
  color, roughness: 0.78, metalness: 0.12, envMap: ENV, envMapIntensity: 0.4,
}));
/** Self-lit trim: tail lights and light bars. */
const lit = (color, intensity = 1.6) => cachedMat(`lit|${color}|${intensity}`, () => new THREE.MeshStandardMaterial({
  color, roughness: 0.4, metalness: 0.2, emissive: color, emissiveIntensity: intensity,
}));

const MAT = {
  glass: cachedMat('glass', () => new THREE.MeshStandardMaterial({
    color: 0x101d28, roughness: 0.08, metalness: 0.95, envMap: ENV, envMapIntensity: 1.4,
  })),
  chrome: cachedMat('chrome', () => new THREE.MeshStandardMaterial({
    color: 0xdfe4ea, roughness: 0.16, metalness: 1.0, envMap: ENV, envMapIntensity: 1.3,
  })),
  tyre: cachedMat('tyre', () => new THREE.MeshStandardMaterial({
    color: 0x0c0d0f, roughness: 0.94, metalness: 0.02,
  })),
  hub: cachedMat('hub', () => new THREE.MeshStandardMaterial({
    color: 0xcfd4da, roughness: 0.22, metalness: 0.95, envMap: ENV, envMapIntensity: 1.0,
  })),
  headlight: cachedMat('headlight', () => new THREE.MeshBasicMaterial({ color: 0xfff6c8 })),
  fog: cachedMat('fog', () => new THREE.MeshBasicMaterial({ color: 0xffe9a8 })),
  taillight: lit(0xff1a1a, 1.8),
  tailStrip: lit(0xcc0a0a, 1.4),
  black: matte(0x14161a),
  darkTrim: matte(0x23262b),
  white: painted(0xf4f4f4),
  navy: painted(0x14264d),
  olive: matte(0x5a6136),
  oliveDark: matte(0x424a28),
  track: matte(0x1c1e20),
};

// ---------------------------------------------------------------------------
// 3. Kit: a part recorder. A builder describes its model as descriptors and
// flush() turns them into meshes in one pass. Every descriptor carries its
// transform, so the shape of a model is data rather than a sequence of calls.
// ---------------------------------------------------------------------------
function kit(parent) {
  const parts = [];
  const record = (geo, mat, at, rot = [0, 0, 0], scale = null) =>
    parts.push({ geo, mat, at, rot, scale });
  return {
    box(mat, size, at, rot, scale) {
      record(boxGeo(size[0], size[1], size[2]), mat, at, rot, scale);
    },
    cyl(mat, spec, at, rot, scale) {
      record(cylGeo(spec[0], spec[1], spec[2], spec[3] ?? 14), mat, at, rot, scale);
    },
    sph(mat, spec, at, rot, scale) {
      record(sphGeo(spec[0], spec[1] ?? 16, spec[2] ?? 12), mat, at, rot, scale);
    },
    /** A geometry the cache does not own (a cone, a torus, a fresh plane). */
    mesh(geo, mat, at, rot, scale) {
      record(geo, mat, at, rot, scale);
    },
    flush() {
      const made = [];
      for (const p of parts) {
        const m = new THREE.Mesh(p.geo, p.mat);
        m.position.set(p.at[0], p.at[1], p.at[2]);
        if (p.rot[0]) m.rotation.x = p.rot[0];
        if (p.rot[1]) m.rotation.y = p.rot[1];
        if (p.rot[2]) m.rotation.z = p.rot[2];
        if (p.scale) m.scale.set(p.scale[0], p.scale[1], p.scale[2]);
        parent.add(m);
        made.push(m);
      }
      parts.length = 0;
      return made;
    },
  };
}

/** Position, rotate and attach a finished mesh or group. */
function place(obj, parent, at, rot = [0, 0, 0]) {
  obj.position.set(at[0], at[1], at[2]);
  obj.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// 4. Decals. Lettering is drawn once per distinct label into a cached canvas
// texture; only the cheap plane mesh and its basic material are per decal.
// ---------------------------------------------------------------------------
const DECALS = new Map();
function textDecal(text, w, h, { font = 'bold 96px Arial, sans-serif', fg = '#ffffff', bg = null, stroke = null } = {}) {
  const cw = 512;
  const ch = Math.max(64, Math.round((512 * h) / w));
  const key = `${text}|${ch}|${font}|${fg}|${bg}|${stroke}`;
  let tex = DECALS.get(key);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch); }
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Shrink the face until the widest word fits the plate.
    let size = parseInt(font.match(/(\d+)px/)?.[1] || '96', 10);
    while (ctx.measureText(text).width > cw - 16 && size > 18) {
      size -= 4;
      ctx.font = font.replace(/(\d+)px/, `${size}px`);
    }
    if (stroke) { ctx.lineWidth = 8; ctx.strokeStyle = stroke; ctx.strokeText(text, cw / 2, ch / 2 + 2); }
    ctx.fillStyle = fg;
    ctx.fillText(text, cw / 2, ch / 2 + 2);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.userData.shared = true;   // cached for the session; never dispose with a car
    DECALS.set(key, tex);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.renderOrder = 3;
  return m;
}

const PLATE_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f8f8f2'; ctx.fillRect(0, 0, 256, 72);
  ctx.strokeStyle = '#14304d'; ctx.lineWidth = 6; ctx.strokeRect(3, 3, 250, 66);
  ctx.fillStyle = '#14304d'; ctx.textAlign = 'center';
  ctx.font = 'bold 19px Arial'; ctx.fillText('PORT AZUL', 128, 22);
  ctx.font = 'bold 29px Arial'; ctx.fillText('4NE-0N1', 128, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const STAR_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2ea';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 58 : 24;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

// ---------------------------------------------------------------------------
// 5. Wheels. Three cylinders per corner, baked into a single vertex-coloured
// mesh: nine-ish draw calls a car instead of forty-five.
// ---------------------------------------------------------------------------
const WHEEL_MATERIAL = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 });
WHEEL_MATERIAL.userData.shared = true;

function buildWheel(radius = 0.36, width = 0.28) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(cylGeo(radius, radius, width, 18), MAT.tyre);
  tyre.rotation.z = Math.PI / 2;
  const hub = new THREE.Mesh(cylGeo(radius * 0.62, radius * 0.62, width + 0.02, 12), MAT.hub);
  hub.rotation.z = Math.PI / 2;
  // A slotted dark disc reads as spokes at a fraction of the draw calls.
  const disc = new THREE.Mesh(cylGeo(radius * 0.52, radius * 0.52, width + 0.04, 8), MAT.darkTrim);
  disc.rotation.z = Math.PI / 2;
  g.add(tyre, hub, disc);
  return g;
}

/** Bake a wheel's tyre, hub and disc into one vertex-coloured mesh. */
function bakeWheel(wheel) {
  const parts = [];
  for (const child of wheel.children) {
    if (!child.isMesh) continue;
    child.updateMatrix();
    parts.push({
      geo: child.geometry,
      matrix: child.matrix.clone(),
      color: child.material && child.material.color ? child.material.color.getHex() : 0x888888,
    });
  }
  if (parts.length === 0) return;
  wheel.clear();
  wheel.add(new THREE.Mesh(mergeGeoms(parts), WHEEL_MATERIAL));
}

// ---------------------------------------------------------------------------
// 6. Cars. Nine silhouettes: sports, sedan, coupe, hatch, pickup, van, taxi
// and a police cruiser, each with its own proportions and trim.
// ---------------------------------------------------------------------------
const CAR_MODELS = [
  { name: 'BRISA GT', color: 0xd21f2b, top: 34, style: 'sports', len: 4.6, wid: 1.95 },
  { name: 'COMET S', color: 0x1f5fd2, top: 34, style: 'sports', len: 4.5, wid: 1.9 },
  { name: 'PRADO SEDAN', color: 0xc8ccd2, top: 24, style: 'sedan', len: 4.7, wid: 1.95 },
  { name: 'BISON PICKUP', color: 0x2e7d32, top: 24, style: 'pickup', len: 5.0, wid: 2.0 },
  { name: 'SOL TAXI', color: 0xf5c518, top: 26, style: 'sedan', len: 4.7, wid: 1.95, taxi: true },
  { name: 'ORCA VAN', color: 0x7b2fbe, top: 24, style: 'van', len: 4.9, wid: 2.05 },
  { name: 'FUEGO COUPE', color: 0xf26a1b, top: 34, style: 'coupe', len: 4.4, wid: 1.9 },
  { name: 'MARLIN HATCH', color: 0x0f9d8f, top: 24, style: 'hatch', len: 4.1, wid: 1.85 },
  { name: 'TIBURON MUSCLE', color: 0x8a1fbf, top: 33, style: 'coupe', len: 4.8, wid: 1.98, muscle: true },
];

/** Which silhouette a request asks for. `seed` picks a traffic model. */
function specFor(kind, seed) {
  if (kind === 'player') {
    return { name: 'BRISA GT', color: 0xd21f2b, top: 42, style: 'sports', len: 4.6, wid: 1.95, spoiler: true };
  }
  if (kind === 'police') {
    return { name: 'PORT AZUL PD', color: 0xf4f4f4, top: 40, style: 'sedan', len: 4.8, wid: 2.0 };
  }
  if (kind === 'taxi') return { ...CAR_MODELS[4] };
  const i = ((seed % CAR_MODELS.length) + CAR_MODELS.length) % CAR_MODELS.length;
  return { ...CAR_MODELS[i] };
}

/** The proportions a silhouette is built from. */
function carDims(style) {
  const wheelR = style === 'van' ? 0.4 : style === 'sports' ? 0.34 : 0.37;
  const bodyH = style === 'van' ? 1.18 : style === 'sports' ? 0.5 : style === 'pickup' ? 0.58 : 0.6;
  const bodyY = style === 'van' ? 1.02 : wheelR + bodyH / 2 + 0.16;
  return {
    wheelR,
    wheelW: 0.3,
    bodyH,
    bodyY,
    bodyTop: bodyY + bodyH / 2,
    hoodLen: style === 'sports' ? 1.25 : 1.0,
    trunkLen: style === 'hatch' ? 0.45 : style === 'pickup' ? 0 : 0.9,
  };
}

/** Per-car paint: a clone, so damage darkens one car and not every car of
 *  the same colour. The clone is deliberately not shared. */
function carPaint(color) {
  const m = painted(color).clone();
  m.userData.shared = false;
  return m;
}

/**
 * Build the shell of a car into the kit: tub, decks, cabin, front and rear
 * clips, flanks and wing. Returns the cabin anchor, the headlight-beam
 * materials and the per-car brake-light material the game drives.
 */
function buildShell(k, spec, dims, paint) {
  const { len, wid, style } = spec;
  const { wheelR, bodyY, bodyTop, hoodLen, trunkLen } = dims;

  // Lower tub and the sloped bonnet / boot decks.
  k.box(paint, [wid, dims.bodyH, len], [0, bodyY, 0]);
  k.box(paint, [wid * 0.96, 0.14, hoodLen], [0, bodyTop - 0.1, -len / 2 + hoodLen / 2 - 0.05], [-0.16, 0, 0]);
  if (trunkLen > 0) {
    k.box(paint, [wid * 0.96, 0.14, trunkLen], [0, bodyTop - 0.08, len / 2 - trunkLen / 2 + 0.05], [0, 0, 0.14]);
  }
  if (spec.muscle) {
    // Blower scoop and chrome intake: the silhouette that reads as "muscle".
    k.box(MAT.darkTrim, [wid * 0.4, 0.16, 1.0], [0, bodyTop, -len / 2 + 1.15]);
    k.box(MAT.chrome, [wid * 0.34, 0.05, 0.5], [0, bodyTop + 0.1, -len / 2 + 1.15]);
  }

  // Cabin. The van and the pickup carry their own furniture; the rest share
  // a glasshouse with pillars and a roof panel.
  let cabinY = bodyTop, cabinZ = 0, cabinLen = 0, cabinH = 0;
  if (style === 'van') {
    k.box(MAT.glass, [wid * 0.86, 0.78, 0.08], [0, bodyTop + 0.3, -len / 2 + 0.42], [0.32, 0, 0]);
    k.box(paint, [wid * 0.98, 0.1, len * 0.94], [0, bodyTop + 0.62, 0]);
    for (const s of [-1, 1]) {
      k.box(MAT.glass, [0.04, 0.5, len * 0.52], [s * (wid / 2 + 0.005), bodyTop + 0.3, 0.3]);
      k.box(MAT.glass, [0.04, 0.5, 0.7], [s * (wid / 2 + 0.005), bodyTop + 0.3, -len / 2 + 0.75]);
    }
    k.box(MAT.glass, [wid * 0.8, 0.55, 0.06], [0, bodyTop + 0.3, len / 2 - 0.02]);
  } else if (style === 'pickup') {
    cabinLen = 1.7; cabinH = 0.62; cabinZ = -len / 2 + 1.55;
    k.box(MAT.glass, [wid * 0.8, cabinH, cabinLen], [0, cabinY + cabinH / 2 - 0.04, cabinZ]);
    k.box(paint, [wid * 0.84, 0.09, cabinLen * 0.98], [0, cabinY + cabinH - 0.02, cabinZ]);
    k.box(MAT.glass, [wid * 0.78, 0.5, 0.06], [0, cabinY + 0.32, cabinZ - cabinLen / 2 - 0.08], [0.38, 0, 0]);
    k.box(MAT.glass, [wid * 0.78, 0.42, 0.06], [0, cabinY + 0.3, cabinZ + cabinLen / 2 + 0.06], [-0.22, 0, 0]);
    const bedZ0 = cabinZ + cabinLen / 2 + 0.1;
    const bedZ1 = len / 2 - 0.08;
    const bedLen = bedZ1 - bedZ0;
    const bedZ = (bedZ0 + bedZ1) / 2;
    k.box(MAT.darkTrim, [wid * 0.92, 0.08, bedLen], [0, bodyTop - 0.1, bedZ]);
    for (const s of [-1, 1]) {
      k.box(paint, [0.09, 0.42, bedLen], [s * (wid / 2 - 0.05), bodyTop + 0.1, bedZ]);
      k.box(MAT.chrome, [0.05, 0.05, bedLen], [s * (wid / 2 - 0.05), bodyTop + 0.33, bedZ]);
    }
    k.box(paint, [wid * 0.94, 0.42, 0.09], [0, bodyTop + 0.1, bedZ1]);
    k.cyl(MAT.tyre, [0.34, 0.34, 0.2, 16], [0.4, bodyTop + 0.12, bedZ + 0.3], [Math.PI / 2, 0, 0]);
  } else {
    cabinLen = style === 'sports' ? 2.3 : style === 'coupe' ? 2.0 : style === 'hatch' ? 2.2 : 2.4;
    cabinH = style === 'sports' ? 0.5 : style === 'coupe' ? 0.52 : 0.62;
    cabinZ = style === 'hatch' ? 0.25 : style === 'sports' ? 0.15 : 0.05;
    k.box(MAT.glass, [wid * 0.8, cabinH, cabinLen], [0, cabinY + cabinH / 2 - 0.04, cabinZ]);
    k.box(paint, [wid * 0.84, 0.09, cabinLen * 0.96], [0, cabinY + cabinH - 0.02, cabinZ]);
    k.box(MAT.glass, [wid * 0.78, 0.46, 0.06], [0, cabinY + 0.3, cabinZ - cabinLen / 2 - 0.1], [0.42, 0, 0]);
    k.box(MAT.glass, [wid * 0.78, 0.4, 0.06], [0, cabinY + 0.28, cabinZ + cabinLen / 2 + 0.08], [-0.38, 0, 0]);
    for (const s of [-1, 1]) {
      k.box(paint, [0.09, 0.5, 0.09], [s * wid * 0.4, cabinY + 0.3, cabinZ - cabinLen / 2 - 0.06], [0.42, 0, 0]);
      k.box(paint, [0.05, cabinH * 0.9, 0.08], [s * (wid * 0.4 + 0.01), cabinY + cabinH / 2, cabinZ]);
    }
  }

  // Front clip: grille, headlights, fog lamps, beams, bumper.
  const noseZ = -len / 2;
  const beams = [];
  k.box(MAT.chrome, [wid * 0.52, 0.16, 0.06], [0, bodyY + 0.08, noseZ - 0.02]);
  for (let i = 0; i < 3; i++) {
    k.box(MAT.darkTrim, [wid * 0.46, 0.025, 0.03], [0, bodyY + 0.03 + i * 0.05, noseZ - 0.05]);
  }
  for (const s of [-1, 1]) {
    k.box(MAT.headlight, [0.44, 0.15, 0.07], [s * wid * 0.32, bodyY + 0.14, noseZ - 0.03]);
    k.cyl(MAT.fog, [0.09, 0.09, 0.05, 12], [s * wid * 0.3, bodyY - 0.14, noseZ - 0.04], [Math.PI / 2, 0, 0]);
    // A soft additive wedge thrown forward onto the road.
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0b8, transparent: true, opacity: 0.055,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    k.mesh(new THREE.ConeGeometry(1.5, 9, 12, 1, true), beamMat,
      [s * wid * 0.3, bodyY + 0.05, noseZ - 4.6], [-Math.PI / 2, 0, 0]);
    beams.push(beamMat);
  }
  k.box(MAT.darkTrim, [wid + 0.08, 0.2, 0.28], [0, wheelR + 0.02, noseZ - 0.06]);

  // Rear clip: tail lights, light strip, brake lights, bumper, exhausts.
  const tailZ = len / 2;
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x5a0a0a, roughness: 0.45, metalness: 0.2,
    emissive: 0xff1010, emissiveIntensity: 1.6,
  });
  for (const s of [-1, 1]) {
    k.box(MAT.taillight, [0.42, 0.14, 0.07], [s * wid * 0.32, bodyY + 0.14, tailZ + 0.03]);
    k.box(brakeMat, [0.2, 0.13, 0.06], [s * wid * 0.44, bodyY + 0.14, tailZ + 0.035]);
    k.cyl(MAT.chrome, [0.07, 0.07, 0.3, 10], [s * 0.55, wheelR - 0.02, tailZ + 0.12], [Math.PI / 2, 0, 0]);
  }
  k.box(MAT.tailStrip, [wid * 0.7, 0.06, 0.04], [0, bodyY + 0.02, tailZ + 0.04]);
  k.box(MAT.darkTrim, [wid + 0.08, 0.2, 0.28], [0, wheelR + 0.02, tailZ + 0.06]);

  // Flanks: mirrors and skirts.
  for (const s of [-1, 1]) {
    const mirrorZ = style === 'van' ? -len / 2 + 0.55 : cabinZ - cabinLen / 2 + 0.25;
    k.box(paint, [0.06, 0.1, 0.16], [s * (wid / 2 + 0.03), cabinY + 0.28, mirrorZ]);
    k.box(MAT.black, [0.1, 0.14, 0.06], [s * (wid / 2 + 0.09), cabinY + 0.3, mirrorZ]);
    k.box(MAT.darkTrim, [0.06, 0.12, len * 0.82], [s * (wid / 2 + 0.005), wheelR + 0.1, 0]);
  }

  if (spec.spoiler || spec.muscle) {
    const sy = bodyTop + 0.3;
    for (const s of [-1, 1]) k.box(MAT.black, [0.08, 0.32, 0.3], [s * 0.62, sy - 0.1, tailZ - 0.25]);
    k.box(MAT.black, [wid * 0.94, 0.1, 0.46], [0, sy + 0.06, tailZ - 0.25], [0, 0, -0.08]);
  }
  if (style === 'sports' || style === 'coupe') {
    k.box(MAT.glass, [wid * 0.6, 0.05, cabinLen * 0.5], [0, cabinY + cabinH + 0.02, cabinZ - 0.1]);
  }

  return { cabinY, cabinZ, cabinLen, beams, brakeMat };
}

/** Front and rear number plates on a shared per-car material. */
function addPlates(g, len, y) {
  const mat = new THREE.MeshBasicMaterial({ map: PLATE_TEX });
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.17), mat);
  rear.position.set(0, y, len / 2 + 0.145);
  rear.rotation.y = Math.PI;
  const front = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.17), mat);
  front.position.set(0, y, -len / 2 - 0.145);
  g.add(rear, front);
}

/** Police livery: pushers, a light bar and the PORT AZUL PD decals. */
function dressCruiser(k, g, spec, dims, built) {
  const { len, wid } = spec;
  const { bodyTop } = dims;
  const noseZ = -len / 2, tailZ = len / 2;
  k.box(MAT.black, [wid * 0.94, 0.05, 1.05], [0, bodyTop + 0.02, noseZ + 0.6], [0, 0, -0.14]);
  k.box(MAT.black, [wid * 0.94, 0.05, 0.95], [0, bodyTop + 0.02, tailZ - 0.55], [0, 0, 0.12]);
  for (const s of [-1, 1]) {
    k.box(MAT.black, [0.04, 0.52, 2.3], [s * (wid / 2 + 0.012), bodyTop - 0.22, 0.1]);
    k.box(MAT.chrome, [0.09, 0.55, 0.09], [s * 0.55, 0.55, noseZ - 0.2]);
  }
  k.box(MAT.chrome, [1.35, 0.09, 0.09], [0, 0.72, noseZ - 0.2]);
  k.box(MAT.chrome, [1.35, 0.09, 0.09], [0, 0.42, noseZ - 0.2]);

  const bar = new THREE.Group();
  bar.add(new THREE.Mesh(boxGeo(1.15, 0.1, 0.4), MAT.black));
  const redMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 0.2, roughness: 0.4 });
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x2040ff, emissive: 0x1020ff, emissiveIntensity: 0.2, roughness: 0.4 });
  const red = new THREE.Mesh(boxGeo(0.5, 0.16, 0.36), redMat);
  red.position.set(-0.3, 0.12, 0);
  const blue = new THREE.Mesh(boxGeo(0.5, 0.16, 0.36), blueMat);
  blue.position.set(0.3, 0.12, 0);
  bar.add(red, blue);
  bar.position.set(0, built.cabinY + 0.72, 0.05);
  bar.userData = { red, blue };
  g.add(bar);

  const navy = '#0a2a6b';
  for (const s of [-1, 1]) {
    place(textDecal('POLICE', 1.15, 0.34, { font: 'bold 96px Arial', fg: '#ffffff' }), g,
      [s * (wid / 2 + 0.045), bodyTop - 0.22, 0.1], [0, s * Math.PI / 2, 0]);
    place(textDecal('PORT AZUL PD', 0.9, 0.2, { font: 'bold 78px Arial', fg: navy }), g,
      [s * (wid / 2 + 0.035), bodyTop - 0.15, noseZ + 0.78], [0, s * Math.PI / 2, 0]);
  }
  place(textDecal('POLICE', 1.3, 0.34, { font: 'bold 96px Arial', fg: navy }), g,
    [0, bodyTop + 0.06, noseZ + 0.62], [-Math.PI / 2 - 0.14, 0, 0]);
  place(textDecal('POLICE', 1.3, 0.3, { font: 'bold 96px Arial', fg: navy }), g,
    [0, bodyTop - 0.12, tailZ + 0.08], [0, Math.PI, 0]);
  return bar;
}

/** Taxi livery: a roof sign and door lettering. */
function dressTaxi(k, g, spec, dims, built) {
  const { wid } = spec;
  const { bodyTop } = dims;
  const sign = new THREE.Group();
  sign.add(new THREE.Mesh(boxGeo(0.72, 0.2, 0.3), matte(0xf5c518)));
  for (const rz of [-0.16, 0.16]) {
    const t = textDecal('TAXI', 0.6, 0.15, { font: 'bold 90px Arial', fg: '#111111' });
    t.position.set(0, 0, rz);
    if (rz > 0) t.rotation.y = Math.PI;
    sign.add(t);
  }
  sign.position.set(0, built.cabinY + 0.74, 0.05);
  g.add(sign);
  for (const s of [-1, 1]) {
    place(textDecal('TAXI', 0.7, 0.22, { font: 'bold 90px Arial', fg: '#111111' }), g,
      [s * (wid / 2 + 0.035), bodyTop - 0.2, 0.1], [0, s * Math.PI / 2, 0]);
  }
}

/** A driver silhouette: head, shoulders and hands-on-wheel arms, so an
 *  occupied car reads as occupied. Three boxes and two arms. */
function addDriver(k, built, wid, shirt = 0x2a3a55) {
  const { cabinY, cabinZ, cabinLen } = built;
  const skin = matte(0xd9a066);
  k.box(matte(shirt), [0.42, 0.4, 0.24], [0, cabinY + 0.18, cabinZ + cabinLen * 0.22]);
  k.box(skin, [0.24, 0.26, 0.24], [0, cabinY + 0.52, cabinZ + cabinLen * 0.22]);
  k.box(matte(shirt), [0.1, 0.34, 0.1], [-wid * 0.24, cabinY + 0.24, cabinZ + cabinLen * 0.02], [-0.7, 0, 0]);
  k.box(matte(shirt), [0.1, 0.34, 0.1], [wid * 0.24, cabinY + 0.24, cabinZ + cabinLen * 0.02], [-0.7, 0, 0]);
}

export function makeCar(kind = 'traffic', seed = 0) {
  const spec = specFor(kind, seed);
  const police = kind === 'police';
  const paint = carPaint(spec.color);
  const g = new THREE.Group();
  const k = kit(g);
  const dims = carDims(spec.style);
  const built = buildShell(k, spec, dims, paint);
  const { len, wid } = spec;
  const { wheelR } = dims;

  addPlates(g, len, dims.bodyY + 0.02);
  let lightBar = null;
  if (police) lightBar = dressCruiser(k, g, spec, dims, built);
  if (spec.taxi) dressTaxi(k, g, spec, dims, built);
  // A cruiser implies its officers through the light bar and carries no
  // visible driver; a van carries a crate so it reads as a working vehicle.
  if (!police) addDriver(k, built, wid, spec.driverShirt ?? 0x2a3a55);
  if (spec.style === 'van' && kind !== 'player') {
    k.box(matte(0xb08a4a), [1.4, 1.0, 1.2], [0, dims.bodyTop + 0.6, 0.6]);
  }

  // Wheels: the fronts steer, every corner spins about its axle.
  const wheels = [];
  const wz = len * 0.32;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = buildWheel(wheelR, dims.wheelW);
      wheel.position.set(sx * (wid / 2 - 0.06), wheelR, sz * wz);
      g.add(wheel);
      wheels.push(wheel);
    }
  }

  g.userData = {
    kind,
    name: spec.name,
    topSpeed: spec.top,
    wheels,
    lightBar,
    bodyColor: spec.color,
    beams: built.beams,       // headlight beam materials, for the night pass
    brakeMat: built.brakeMat, // traffic lights this as it brakes
    steerWheels: [wheels[0], wheels[2]],
    damage: 0,
    setSteer(a) {
      for (const w of this.steerWheels) w.rotation.y = a * 0.42;
    },
    setDamage(f) {
      this.damage = clamp(f, 0, 1);
      paint.color.setHex(this.bodyColor).multiplyScalar(1 - 0.4 * this.damage);
    },
  };

  k.flush();
  for (const wheel of wheels) bakeWheel(wheel);
  mergeSharedMaterials(g);
  return g;
}

// ---------------------------------------------------------------------------
// 7. Helicopter: a Port Azul PD bird with a searchlight, a rotor blur disc
// and a flashing beacon. Front is -z; the group origin is the fuselage centre.
// ---------------------------------------------------------------------------
export function makeHelicopter() {
  const g = new THREE.Group();
  const k = kit(g);
  const white = MAT.white;
  const navy = MAT.navy;

  k.box(white, [2.1, 1.5, 3.6], [0, 0, 0]);
  k.box(navy, [2.14, 0.34, 3.62], [0, -0.55, 0]);
  k.box(navy, [1.9, 0.14, 3.3], [0, 0.8, 0]);
  k.sph(white, [1.02, 18, 14], [0, -0.05, -1.8], [0, 0, 0], [1.02, 0.72, 1.15]);
  k.box(navy, [2.0, 0.22, 0.5], [0, -0.62, -1.85]);
  k.box(MAT.glass, [1.7, 0.85, 0.9], [0, 0.28, -1.55], [0.5, 0, 0]);
  k.box(MAT.glass, [1.55, 0.6, 0.7], [0, 0.18, -0.75], [0.18, 0, 0]);
  for (const s of [-1, 1]) {
    k.box(MAT.glass, [0.04, 0.62, 1.15], [s * 1.06, 0.12, -0.35]);
    k.box(MAT.glass, [0.04, 0.55, 0.9], [s * 1.06, 0.12, 0.85]);
    k.box(navy, [0.05, 0.9, 0.95], [s * 1.06, -0.05, 0.85]);
    k.box(white, [0.05, 0.74, 0.8], [s * 1.07, -0.05, 0.85]);
    place(textDecal('PORT AZUL PD', 1.9, 0.34, { font: 'bold 84px Arial', fg: '#14264d' }), g,
      [s * 1.12, -0.28, 0.35], [0, s * Math.PI / 2, 0]);
  }

  k.cyl(white, [0.32, 0.62, 4.6, 12], [0, 0.15, 3.9], [Math.PI / 2, 0, 0]);
  k.cyl(navy, [0.34, 0.6, 4.4, 12], [0, -0.12, 3.9], [Math.PI / 2, 0, 0], [1, 1, 0.35]);
  k.box(navy, [0.1, 1.5, 1.0], [0, 0.75, 6.0], [-0.25, 0, 0]);
  for (const s of [-1, 1]) {
    place(textDecal('POLICE', 0.85, 0.24, { font: 'bold 90px Arial', fg: '#ffffff' }), g,
      [s * 0.075, 0.85, 6.02], [0, s * Math.PI / 2, 0]);
  }
  k.box(white, [0.08, 1.0, 0.7], [0, 0.6, 5.7], [-0.25, 0, 0]);
  k.box(navy, [2.4, 0.08, 0.55], [0, 0.15, 5.6]);

  // Main rotor: mast, two blades with red tips, and a translucent blur disc.
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.05, 0);
  const mast = new THREE.Mesh(cylGeo(0.14, 0.18, 0.5, 10), MAT.darkTrim);
  mast.position.y = -0.1;
  rotor.add(mast);
  for (const a of [0, Math.PI / 2]) {
    const blade = new THREE.Mesh(boxGeo(7.6, 0.06, 0.42), MAT.darkTrim);
    blade.rotation.y = a;
    rotor.add(blade);
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(boxGeo(0.5, 0.07, 0.43), matte(0xc22a2a));
      tip.position.set(s * 3.5, 0, 0);
      tip.rotation.y = a;
      rotor.add(tip);
    }
  }
  const blur = new THREE.Mesh(
    new THREE.CircleGeometry(3.85, 40),
    new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = 0.06;
  rotor.add(blur);
  g.add(rotor);

  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.42, 0.45, 5.85);
  const tailHub = new THREE.Mesh(cylGeo(0.09, 0.09, 0.3, 8), MAT.darkTrim);
  tailHub.rotation.z = Math.PI / 2;
  tailRotor.add(tailHub);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(boxGeo(0.05, 1.15, 0.16), MAT.darkTrim);
    b.rotation.x = (i * Math.PI) / 2;
    tailRotor.add(b);
  }
  g.add(tailRotor);

  // Skids and struts.
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(cylGeo(0.07, 0.07, 3.4, 8), MAT.darkTrim);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(s * 0.95, -1.25, -0.1);
    g.add(skid);
    for (const sz of [-0.9, 0.7]) {
      const strut = new THREE.Mesh(cylGeo(0.05, 0.05, 0.75, 8), MAT.darkTrim);
      strut.position.set(s * 0.85, -0.95, sz);
      strut.rotation.z = s * 0.5;
      g.add(strut);
    }
  }

  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 0.3, roughness: 0.4 });
  const beacon = new THREE.Mesh(sphGeo(0.14, 10, 8), beaconMat);
  beacon.position.set(0, 1.62, 5.85);
  g.add(beacon);

  // Nose searchlight: lamp body, lens and an additive cone to the ground.
  const spotGroup = new THREE.Group();
  spotGroup.position.set(0, -0.85, -1.7);
  const lampBody = new THREE.Mesh(cylGeo(0.22, 0.26, 0.3, 12), MAT.darkTrim);
  lampBody.rotation.x = Math.PI / 2;
  spotGroup.add(lampBody);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.2, 16), MAT.headlight);
  lens.position.set(0, -0.05, -0.16);
  lens.rotation.x = 0.35;
  spotGroup.add(lens);
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, 16, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xfff3b0, transparent: true, opacity: 0.09,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  beam.position.set(0, -8, -2.2);
  beam.rotation.x = 0.28;
  spotGroup.add(beam);
  g.add(spotGroup);

  // The hull is dozens of primitives; bucketing them by material is what a car
  // already does, and the air unit should not cost more draw calls than one.
  k.flush();
  mergeSharedMaterials(g);

  g.userData = { rotor, tailRotor, beacon, spotGroup };
  return g;
}

// ---------------------------------------------------------------------------
// Armoured truck: the five-star response. Olive hull, turret, white star.
// ---------------------------------------------------------------------------
export function makeTank() {
  const g = new THREE.Group();
  const k = kit(g);
  const olive = MAT.olive, oliveDark = MAT.oliveDark;

  k.box(olive, [2.5, 0.85, 4.1], [0, 0.85, 0]);
  k.box(olive, [2.4, 0.7, 1.0], [0, 0.95, -2.1], [0.5, 0, 0]);
  k.box(oliveDark, [2.55, 0.18, 4.15], [0, 0.5, 0]);
  for (const s of [-1, 1]) {
    k.box(MAT.track, [0.72, 0.95, 4.5], [s * 1.55, 0.48, 0]);
    for (let i = 0; i < 5; i++) {
      k.cyl(matte(0x3a3d33), [0.3, 0.3, 0.06, 12], [s * 1.93, 0.42, -1.6 + i * 0.8], [0, 0, Math.PI / 2]);
    }
  }
  for (const s of [-1, 1]) {
    const star = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.7),
      new THREE.MeshBasicMaterial({ map: STAR_TEX, transparent: true, depthWrite: false }));
    star.position.set(s * 1.27, 0.95, 0.2);
    star.rotation.y = s * Math.PI / 2;
    star.renderOrder = 3;
    g.add(star);
  }
  for (const s of [-1, 1]) k.box(MAT.headlight, [0.2, 0.12, 0.06], [s * 0.9, 1.0, -2.55]);

  const turret = new THREE.Group();
  turret.position.set(0, 1.32, 0.25);
  const tk = kit(turret);
  tk.box(olive, [1.7, 0.62, 2.1], [0, 0.31, 0]);
  tk.box(oliveDark, [1.78, 0.16, 2.15], [0, 0.05, 0]);
  tk.cyl(oliveDark, [0.32, 0.32, 0.1, 12], [-0.4, 0.68, 0.3]);
  tk.box(MAT.glass, [0.3, 0.12, 0.2], [0.45, 0.68, -0.2]);
  tk.cyl(MAT.darkTrim, [0.11, 0.13, 2.7, 12], [0, 0.38, -2.2], [Math.PI / 2, 0, 0]);
  tk.cyl(MAT.darkTrim, [0.17, 0.17, 0.4, 12], [0, 0.38, -3.35], [Math.PI / 2, 0, 0]);
  tk.flush();
  g.add(turret);

  // Same bucketing as the helicopter: the armoured truck is a handful of
  // boxes, not forty draw calls.
  k.flush();
  mergeSharedMaterials(g);

  g.userData = { turret };
  return g;
}

// ---------------------------------------------------------------------------
// 8. Person: an articulated figure with pivoted limbs.
// ---------------------------------------------------------------------------
const SKIN = matte(0xd9a066);
const HAIR = matte(0x1c1410);

export function makePerson(shirt = 0x2ea88a, pants = 0x2a3a55) {
  const g = new THREE.Group();
  const k = kit(g);
  const shirtMat = matte(shirt);
  const pantsMat = matte(pants);

  k.box(shirtMat, [0.56, 0.62, 0.3], [0, 1.12, 0]);        // torso
  k.box(SKIN, [0.32, 0.34, 0.3], [0, 1.62, 0]);           // head
  k.box(shirtMat, [0.36, 0.1, 0.34], [0, 1.82, 0]);       // cap
  k.box(shirtMat, [0.36, 0.04, 0.16], [0, 1.78, -0.22]);  // cap brim

  // Legs and arms stay separate meshes: they are animated every frame.
  const legs = [];
  const arms = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(limbGeo(0.2, 0.78, 0.22), pantsMat);
    leg.position.set(s * 0.13, 0.8, 0);
    const shoe = new THREE.Mesh(boxGeo(0.22, 0.1, 0.34), MAT.black);
    shoe.position.set(0, -0.74, 0.05);
    leg.add(shoe);
    g.add(leg);
    legs.push(leg);

    const arm = new THREE.Mesh(limbGeo(0.16, 0.62, 0.18), shirtMat);
    arm.position.set(s * 0.36, 1.4, 0);
    const hand = new THREE.Mesh(boxGeo(0.15, 0.14, 0.16), SKIN);
    hand.position.set(0, -0.62, 0);
    arm.add(hand);
    g.add(arm);
    arms.push(arm);
  }

  const [torso, head] = k.flush();
  g.userData = { legs, arms, torso, head };
  // The static body parts share one mesh; the limbs stay separate to animate.
  mergeSharedMaterials(g, (c) => legs.includes(c) || arms.includes(c));
  return g;
}

// ---------------------------------------------------------------------------
// Pickups: a glowing core, a ring and a light pool on the ground.
// ---------------------------------------------------------------------------
const PICKUP_COLORS = { health: 0xff4d6d, armour: 0x3aa0ff, weapon: 0xffc93a, cash: 0x7dffa8 };

export function makePickup(kind) {
  const g = new THREE.Group();
  const color = PICKUP_COLORS[kind] ?? PICKUP_COLORS.weapon;

  const coreMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.4, roughness: 0.35, metalness: 0.2 });
  const core = new THREE.Mesh(boxGeo(0.7, 0.7, 0.7), coreMat);
  core.position.y = 0.85;
  core.rotation.y = Math.PI / 4;
  g.add(core);

  const inner = new THREE.Mesh(boxGeo(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  inner.position.y = 0.85;
  inner.rotation.y = Math.PI / 4;
  g.add(inner);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.06, 8, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.08;
  g.add(ring);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 24),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  g.add(disc);

  g.userData = { kind, core, ring };
  return g;
}
