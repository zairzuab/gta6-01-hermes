// The city: a coastal American-inspired grid — downtown towers, residential
// blocks, a shopping strip, a boardwalk with a Ferris wheel, a cargo port, a
// gas station, a police station, a hospital, beaches and a highway bridge.
//
// Layout, in world metres, before the coast skew:
//   x = east/ west, z = south/ north.  Streets run on a PITCH grid centred on
//   the origin; the sea is south of the grid and the coast road bends around a
//   bay.  Every building, kerb, lamp and prop is procedural: no assets.
import * as THREE from 'three';
import { mulberry32, canvasTexture, shade, WINDOW_LIT, clamp, lerp, mixColor, mergeGeoms } from './util.js';

// ---- street geometry -------------------------------------------------------
export const PITCH = 60;          // distance between parallel street centrelines
export const STREET_W = 15;       // kerb to kerb
export const BLOCK = PITCH - STREET_W;
export const GRID = 7;            // blocks per side
export const CITY_HALF = 210;     // half extent of the street grid
export const COAST_Z = CITY_HALF + 46;   // the shoreline
export const SEA_Z = COAST_Z + 240;

export const streetCoord = (i) => -CITY_HALF + i * PITCH;

/** The street centreline nearest to x, or null when x is off-grid. */
export function nearestStreet(x) {
  const i = Math.round((x + CITY_HALF) / PITCH);
  if (i < 0 || i > GRID) return null;
  return streetCoord(i);
}

/** A point on a street: ix is the street index, `along` is metres along it. */
export function streetPoint(ix, iz, along = 0) {
  return { x: streetCoord(ix), z: streetCoord(iz) + along };
}

export const AVENUES = [
  'Harbor Line', 'Neon Avenue', 'Palmetto Row', 'Meridian Street',
  'Boardwalk', 'Coral Way', 'Sunset Boulevard', 'Port Authority Road',
];
export const DISTRICTS = [
  'THE STRIP', 'DOWNTOWN', 'OLD TOWN', 'THE DOCKS', 'PALM HEIGHTS',
  'SALT MARSH', 'LITTLE HAVANA', 'NORTH RIDGE',
];

// ---- textures --------------------------------------------------------------
function facadeTexture(base, seed, litRatio) {
  const rnd = mulberry32(seed);
  const floors = 5 + Math.floor(rnd() * 6);      // 5..10 floors
  const cols = 4 + Math.floor(rnd() * 3);        // 4..6 window columns
  return canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    // A soft vertical sheen so the flat wall is not one uniform colour.
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.16)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,50,0.12)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const fh = h / floors, cw = w / cols;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw * 0.16, y = f * fh + fh * 0.18;
        const ww = cw * 0.68, wh = fh * 0.6;
        // Concrete mullion frame.
        g.fillStyle = shade(base, 0.86); g.fillRect(x - 3, y - 3, ww + 6, wh + 6);
        const lit = rnd() < litRatio;
        if (lit) {
          g.fillStyle = WINDOW_LIT[Math.floor(rnd() * WINDOW_LIT.length)];
        } else {
          const gg = g.createLinearGradient(x, y, x + ww, y + wh);
          gg.addColorStop(0, '#2d4f70'); gg.addColorStop(0.55, '#1c3450'); gg.addColorStop(1, '#2a4a6b');
          g.fillStyle = gg;
        }
        g.fillRect(x, y, ww, wh);
        if (lit) {
          // A lit window reads as a lamp: a warm core and a cool frame edge.
          g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(x, y, ww, 2);
        } else {
          // A diagonal reflection streak on the dark glass.
          g.fillStyle = 'rgba(255,255,255,0.22)';
          g.beginPath();
          g.moveTo(x + ww * 0.1, y + wh); g.lineTo(x + ww * 0.42, y);
          g.lineTo(x + ww * 0.58, y); g.lineTo(x + ww * 0.26, y + wh);
          g.closePath(); g.fill();
        }
        g.fillStyle = shade(base, 0.7); g.fillRect(x + ww / 2 - 1, y, 2, wh);
        g.fillRect(x, y + wh / 2 - 1, ww, 2);
      }
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, f * fh + fh - 2, w, 2);
    }
    // Roofline parapet + a lighter coping.
    g.fillStyle = shade(base, 0.7); g.fillRect(0, 0, w, 13);
    g.fillStyle = 'rgba(255,255,255,0.26)'; g.fillRect(0, 13, w, 3);
    // A shopfront band at street level, on the textures that map low walls.
    if (rnd() < 0.6) {
      g.fillStyle = '#1d232b'; g.fillRect(6, h - 70, w - 12, 62);
      const sg = g.createLinearGradient(0, h - 70, 0, h - 8);
      sg.addColorStop(0, '#3f6f92'); sg.addColorStop(1, '#1b3247');
      g.fillStyle = sg; g.fillRect(10, h - 66, w - 20, 54);
      g.fillStyle = 'rgba(255,255,255,0.32)';
      g.fillRect(26, h - 62, 10, 50); g.fillRect(w - 36, h - 62, 10, 50);
    }
  });
}

function awningTexture(c1, c2) {
  return canvasTexture(128, 64, (g, w, h) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 === 0 ? c1 : c2;
      g.fillRect((i * w) / 8, 0, w / 8 + 1, h);
    }
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, h - 7, w, 7);
  });
}

function asphaltTexture() {
  return canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = '#42464d'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.12)';
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    // Edge lines and a dashed centreline.
    g.fillStyle = '#dcdad4'; g.fillRect(4, 0, 3, h); g.fillRect(w - 7, 0, 3, h);
    g.fillStyle = '#e8c832';
    for (let y = 0; y < h; y += 32) { g.fillRect(w / 2 - 6, y, 3, 18); g.fillRect(w / 2 + 3, y, 3, 18); }
  }, 1, 8);
}

function sidewalkTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#cfc4ae'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.17)'; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo((i * w) / 4, 0); g.lineTo((i * w) / 4, h); g.stroke();
      g.beginPath(); g.moveTo(0, (i * h) / 4); g.lineTo(w, (i * h) / 4); g.stroke();
    }
    const rnd = mulberry32(11);
    for (let i = 0; i < 220; i++) { g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }, 12, 12);
}

function sandTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#e8d5a8'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(21);
    for (let i = 0; i < 520; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.25)' : 'rgba(120,90,40,0.15)';
      g.fillRect(rnd() * w, rnd() * h, 2, 1);
    }
  }, 26, 26);
}

function grassTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#4c7a3c'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(31);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.09)' : 'rgba(0,40,0,0.16)';
      g.fillRect(rnd() * w, rnd() * h, 2, 3);
    }
  }, 18, 18);
}

function waterTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1b6fa8'); grad.addColorStop(1, '#0e4d80');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(41);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = rnd() < 0.6 ? 'rgba(255,255,255,0.10)' : 'rgba(0,30,60,0.12)';
      const y = rnd() * h;
      g.fillRect(rnd() * w, y, 12 + rnd() * 26, 1.4);
    }
  }, 10, 10);
}

/**
 * A ripple normal map for the sea: the canvas is read as a tangent-space normal
 * map by the water material, so the surface catches the sun and the street
 * lamps instead of reading as a flat blue plane. Cheap, and it animates.
 */
function waterNormalTexture() {
  const tex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(61);
    for (let i = 0; i < 160; i++) {
      const x = rnd() * w, y = rnd() * h, r = 4 + rnd() * 18;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const up = rnd() < 0.5;
      grad.addColorStop(0, up ? 'rgb(168,128,255)' : 'rgb(88,128,255)');
      grad.addColorStop(1, 'rgba(128,128,255,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }, 8, 8);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function containerTexture(hue) {
  return canvasTexture(128, 64, (g, w, h) => {
    g.fillStyle = hue; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let x = 0; x < w; x += 16) g.fillRect(x, 0, 6, h);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 4, w, 4); g.fillRect(0, h - 8, w, 4);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.font = 'bold 15px Arial'; g.textAlign = 'center';
    g.fillText('PORT AZUL', w / 2, h / 2 + 5);
  });
}

function roofTexture(base) {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(53);
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 2;
    g.strokeRect(6, 6, w - 12, h - 12);
  }, 2, 2);
}

function signTexture(text, bg, fg, sub = '') {
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = fg; g.lineWidth = 5; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = fg; g.textAlign = 'center';
    g.font = 'bold 44px Arial';
    g.fillText(text, w / 2, sub ? h / 2 - 2 : h / 2 + 14);
    if (sub) { g.font = 'bold 22px Arial'; g.fillText(sub, w / 2, h / 2 + 34); }
  });
}

// ---- material + geometry caches -------------------------------------------
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12);
const FACADE_BASES = ['#f7f2e6', '#f3e3cf', '#e8c9a8', '#dfe8ea', '#f2d7c9', '#e9dcc3', '#d9c9b4'];
const AWNING_PAIRS = [['#e85d75', '#fdf6ec'], ['#2a9d8f', '#fdf6ec'], ['#f4a261', '#fdf6ec'], ['#4d7bd8', '#fdf6ec']];

export class City {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];      // {x, z, halfX, halfZ} building footprints
    this.palms = [];          // swaying crowns
    this.trafficLights = [];  // {red, amber, green, offset}
    this.wheel = null;
    this.gondolas = [];
    this.signs = [];          // shop signs that glow at night
    this.carHeadlights = [];  // headlight beam materials, lit by the night pass
    this.lampHeads = [];      // emissive lamp bulbs, dimmed by day
    this.lampPools = [];      // warm light pools on the asphalt, lit at night
    this.windowMats = [];     // facade materials whose emissive follows the sun
    this.buildings = [];      // {mesh, x, z, h, glow} for the night-window pass
    this._textures();
    this._skyAndLights();
    this._groundAndStreets();
    this._buildings();
    this._palms();
    this._props();
    this._specials();         // police station, hospital, gas station, shops
    this._port();
    this._bridge();
    this._ferrisWheel();
    this._seaAndSkyline();
    this._park();
    this._pierAndBeach();
    this._buildColliderGrid();
    // Every car's headlight beam material, so the night pass can switch them on.
    this.scene.traverse((o) => {
      if (o.userData && o.userData.beams) this.carHeadlights.push(...o.userData.beams);
    });
    // City props are built before the traffic, so the beam materials that
    // already exist are collected here and any later (stolen) car is picked up
    // by the night pass scanning this list again.
    this.collectHeadlights = () => {
      this.carHeadlights.length = 0;
      this.scene.traverse((o) => {
        if (o.userData && o.userData.beams) this.carHeadlights.push(...o.userData.beams);
      });
    };
    // A car built later (a stolen ride, a cruiser, a roadblock) registers its
    // own beams instead of making the whole scene re-scanned.
    this.addHeadlights = (mesh) => {
      if (mesh && mesh.userData && mesh.userData.beams) this.carHeadlights.push(...mesh.userData.beams);
    };
  }

  // ---- textures (one of each, shared by every mesh) ------------------------
  _textures() {
    this.texAsphalt = asphaltTexture();
    this.texWalk = sidewalkTexture();
    this.texSand = sandTexture();
    this.texGrass = grassTexture();
    this.texWater = waterTexture();
    this.texWaterNormal = waterNormalTexture();
    this.texFacades = FACADE_BASES.map((base, i) => facadeTexture(base, 100 + i * 37, 0.12));
    this.texAwnings = AWNING_PAIRS.map(([a, b]) => awningTexture(a, b));
    this.texRoof = roofTexture('#8a7f70');
    this.texRoofDark = roofTexture('#5d564c');
  }

  _skyAndLights() {
    // A sky dome with a live gradient: day, dusk and night are blended every
    // frame, so the horizon, the fog and the sun always agree with the clock.
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 4; this.skyCanvas.height = 256;
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.skyMat = new THREE.MeshBasicMaterial({
      map: this.skyTex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 20), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.background = new THREE.Color(0x8fcdf0);
    this.scene.fog = new THREE.Fog(0xcfe2ee, 320, 1500);
    this.hemi = new THREE.HemisphereLight(0xbfe3ff, 0xe8c9a0, 0.85);
    this.scene.add(this.hemi);
    // A little ambient so the night streets never crush to pure black.
    this.ambient = new THREE.AmbientLight(0x5a6b88, 0.3);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffe7b8, 2.2);
    this.sun.position.set(150, 220, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -280; sc.right = 280; sc.top = 280; sc.bottom = -280; sc.near = 20; sc.far = 1400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // A visible sun disc + glow, moved along the sun's arc every frame.
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(26, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff3b0, fog: false, transparent: true, opacity: 0.95 }));
    this.scene.add(this.sunDisc);
    this.sunGlow = new THREE.Mesh(new THREE.CircleGeometry(54, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff8d0, fog: false, transparent: true, opacity: 0.28 }));
    this.scene.add(this.sunGlow);
    // Clouds: flattened spheres, cheap and soft.
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false });
    const puff = new THREE.SphereGeometry(1, 10, 8);
    const rnd = mulberry32(97);
    for (const [cx, cy, cz] of [[-180, 130, -280], [70, 150, -320], [240, 120, -190], [-260, 140, 130], [150, 135, 270], [-90, 160, 320]]) {
      const cloud = new THREE.Group();
      const n = 3 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const p = new THREE.Mesh(puff, cloudMat);
        p.position.set((i - n / 2) * 10 + rnd() * 3, rnd() * 2, rnd() * 4);
        p.scale.set(10 + rnd() * 5, 3.4, 5.5);
        cloud.add(p);
      }
      cloud.position.set(cx, cy, cz);
      this.scene.add(cloud);
    }
  }

  // ---- ground, streets, kerbs, crossings ----------------------------------
  _groundAndStreets() {
    const half = CITY_HALF + 90;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshLambertMaterial({ color: 0xd9cfba }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; ground.receiveShadow = true;
    this.scene.add(ground);

    const asphaltMat = new THREE.MeshPhongMaterial({
      map: this.texAsphalt,
      shininess: 26,
      specular: 0x2a3038,
    });
    const walkMat = new THREE.MeshLambertMaterial({ map: this.texWalk });
    const roadLen = CITY_HALF * 2 + STREET_W;
    const roadGeo = new THREE.PlaneGeometry(STREET_W, roadLen);
    const walkGeo = new THREE.PlaneGeometry(6, roadLen);
    for (let i = 0; i <= GRID; i++) {
      const c = streetCoord(i);
      const ns = new THREE.Mesh(roadGeo, asphaltMat);
      ns.rotation.x = -Math.PI / 2; ns.position.set(c, 0, 0); ns.receiveShadow = true;
      this.scene.add(ns);
      const ew = new THREE.Mesh(roadGeo, asphaltMat);
      ew.rotation.x = -Math.PI / 2; ew.rotation.z = Math.PI / 2; ew.position.set(0, 0, c);
      ew.receiveShadow = true; this.scene.add(ew);
      for (const side of [-1, 1]) {
        const off = side * (STREET_W / 2 + 3);
        const wns = new THREE.Mesh(walkGeo, walkMat);
        wns.rotation.x = -Math.PI / 2; wns.position.set(c + off, 0.02, 0); wns.receiveShadow = true;
        this.scene.add(wns);
        const wew = new THREE.Mesh(walkGeo, walkMat);
        wew.rotation.x = -Math.PI / 2; wew.rotation.z = Math.PI / 2; wew.position.set(0, 0.02, c + off);
        wew.receiveShadow = true; this.scene.add(wew);
      }
    }
    // Zebra crossings at the four downtown intersections of the main avenues.
    const zebraMat = new THREE.MeshLambertMaterial({ color: 0xf2f2ea });
    const stripeGeo = new THREE.BoxGeometry(0.9, 0.05, 3.6);
    for (const i of [3, 4]) {
      const c = streetCoord(i);
      for (const j of [3, 4]) {
        const d = streetCoord(j);
        for (let k = -4; k <= 4; k++) {
          const s1 = new THREE.Mesh(stripeGeo, zebraMat);
          s1.position.set(c + k * 1.6, 0.035, d + STREET_W / 2 + 4.2); this.scene.add(s1);
          const s2 = new THREE.Mesh(stripeGeo, zebraMat);
          s2.rotation.y = Math.PI / 2;
          s2.position.set(c + STREET_W / 2 + 4.2, 0.035, d + k * 1.6); this.scene.add(s2);
        }
      }
    }
  }

  // ---- buildings -----------------------------------------------------------
  _buildings() {
    // Facade materials carry a dim emissive map so windows glow at night.
    this.facadeMats = this.texFacades.map((tex, i) => {
      const m = new THREE.MeshLambertMaterial({ map: tex });
      m.emissive = new THREE.Color(0x2a3550);
      m.emissiveMap = tex;
      m.emissiveIntensity = 0;
      this.windowMats.push(m);
      return m;
    });
    this.roofMat = new THREE.MeshLambertMaterial({ map: this.texRoof });
    this.roofDarkMat = new THREE.MeshLambertMaterial({ map: this.texRoofDark });
    const acMat = new THREE.MeshLambertMaterial({ color: 0xb9c0c4 });
    const tankMat = new THREE.MeshLambertMaterial({ color: 0x7a6a55 });
    const balconyMat = new THREE.MeshLambertMaterial({ color: 0xefe8d8 });
    const railMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
    this.awningMats = this.texAwnings.map((t) => new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide }));

    for (let bi = 0; bi < GRID; bi++) {
      for (let bj = 0; bj < GRID; bj++) {
        const rnd = mulberry32(bi * 131 + bj * 17 + 5);
        const cx = streetCoord(bi) + PITCH / 2;
        const cz = streetCoord(bj) + PITCH / 2;
        // Taller downtown: the centre of the grid is the business district.
        const centre = 1 - (Math.abs(cx) + Math.abs(cz)) / (CITY_HALF * 2);
        const count = rnd() < 0.45 ? 1 : rnd() < 0.8 ? 2 : 3;
        const onAvenue = bi === 3 || bi === 4;
        const avenueSide = bi === 3 ? 1 : -1;
        for (let k = 0; k < count; k++) {
          const w = 16 + rnd() * 14;
          const d = 14 + rnd() * 12;
          const h = 12 + rnd() * 12 + centre * 34;
          const ox = count === 1 ? 0 : (k - (count - 1) / 2) * (BLOCK / count) * 0.9;
          const oz = (rnd() - 0.5) * 8;
          const x = cx + ox, z = cz + oz;
          const mat = this.facadeMats[Math.floor(rnd() * this.facadeMats.length)];
          const b = new THREE.Mesh(BOX, mat);
          b.scale.set(w, h, d);
          b.position.set(x, h / 2, z);
          b.castShadow = true; b.receiveShadow = true;
          this.scene.add(b);
          this.colliders.push({ x, z, halfX: w / 2, halfZ: d / 2, h });
          this.buildings.push({ mesh: b, x, z, h, w, d });
          // A parapet cap and a rooftop plant room break up the silhouette.
          const cap = new THREE.Mesh(BOX, this.roofMat);
          cap.scale.set(w + 0.6, 0.8, d + 0.6); cap.position.set(x, h + 0.4, z);
          this.scene.add(cap);
          if (rnd() < 0.65) {
            const ac = new THREE.Mesh(BOX, acMat);
            ac.scale.set(2.4, 1.2, 1.8);
            ac.position.set(x + (rnd() - 0.5) * (w - 5), h + 1.4, z + (rnd() - 0.5) * (d - 5));
            this.scene.add(ac);
          }
          if (rnd() < 0.4) {
            const tank = new THREE.Mesh(CYL, tankMat);
            tank.scale.set(1.2, 2.4, 1.2);
            tank.position.set(x + (rnd() - 0.5) * (w - 5), h + 2, z + (rnd() - 0.5) * (d - 5));
            this.scene.add(tank);
          }
          if (h > 30 && rnd() < 0.5) {
            // A red aircraft-warning beacon on the tall towers.
            const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3344 });
            const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), beaconMat);
            beacon.position.set(x, h + 1.1, z);
            this.scene.add(beacon);
            this.signs.push({ mesh: beacon, mat: beaconMat, night: true, base: 0xff3344 });
          }
          // Balconies and awnings on the blocks facing the main avenue.
          if (onAvenue) {
            const faceX = x + avenueSide * (w / 2 + 0.15);
            const awn = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.14, d * 0.85),
              this.awningMats[Math.floor(rnd() * this.awningMats.length)]);
            awn.position.set(faceX + avenueSide * 1.4, 4.5, z);
            awn.rotation.z = -avenueSide * 0.3;
            awn.castShadow = true;
            this.scene.add(awn);
            const balconies = Math.floor(h / 9);
            for (let f = 0; f < balconies; f++) {
              const by = 8.5 + f * 8;
              if (by > h - 3) break;
              const slab = new THREE.Mesh(BOX, balconyMat);
              slab.scale.set(1.5, 0.35, 5);
              slab.position.set(faceX + avenueSide * 0.75, by, z + (rnd() - 0.5) * (d - 8));
              slab.castShadow = true; this.scene.add(slab);
              const rail = new THREE.Mesh(BOX, railMat);
              rail.scale.set(0.12, 1.0, 5);
              rail.position.set(faceX + avenueSide * 1.45, by + 0.65, slab.position.z);
              this.scene.add(rail);
            }
            // A neon shop sign on the ground floor, facing the avenue.
            if (rnd() < 0.75) {
              const texts = [['TACOS', '#ff5da0'], ['LIQUOR', '#5ff2ff'], ['PAWN', '#ffd75e'],
                ['DINER', '#7dffa8'], ['MOTEL', '#ff8c42'], ['ARCADE', '#b84ad8']];
              const [txt, col] = texts[Math.floor(rnd() * texts.length)];
              const signMat = new THREE.MeshBasicMaterial({ map: signTexture(txt, '#0d1220', col), transparent: true });
              const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 3.2), signMat);
              sign.position.set(faceX + avenueSide * 0.4, 6.6, z + (rnd() - 0.5) * 6);
              sign.rotation.y = avenueSide > 0 ? Math.PI / 2 : -Math.PI / 2;
              this.scene.add(sign);
              this.signs.push({ mesh: sign, mat: signMat, night: false, base: col, sign: true });
            }
          }
        }
      }
    }
  }

  // ---- palms ---------------------------------------------------------------
  _palms() {
    // Palms are scattered, but they are still part of the city: an unseeded
    // scatter made every load (and every staged screenshot) a different city,
    // which contradicts the deterministic-city contract above.
    const rnd = mulberry32(90210);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });
    const frondMat = new THREE.MeshLambertMaterial({ color: 0x46a352, side: THREE.DoubleSide });
    const nutMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.48, 1, 7);
    const frondGeo = new THREE.PlaneGeometry(0.9, 5.0, 1, 3);
    const pos = frondGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      pos.setZ(i, -Math.pow((y + 2.5) / 5.0, 2) * 1.2);
    }
    frondGeo.computeVertexNormals();
    const nutGeo = new THREE.SphereGeometry(0.34, 8, 6);

    // A whole crown and the nuts each become ONE mesh, so a palm costs three
    // draw calls instead of eighteen.
    const tmp = new THREE.Object3D();
    const place = (ry, rx, py, ty) => {
      tmp.position.set(0, 0, 0);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmp.rotation.y = ry; tmp.rotation.x = rx;
      tmp.position.y = py; tmp.translateY(ty);
      tmp.updateMatrix();
      return tmp.matrix.clone();
    };
    const crownParts = [];
    for (let i = 0; i < 6; i++) crownParts.push({ geo: frondGeo, matrix: place((i / 6) * Math.PI * 2, -0.9, 0.4, 2.1) });
    for (let i = 0; i < 8; i++) crownParts.push({ geo: frondGeo, matrix: place((i / 8) * Math.PI * 2 + 0.4, 0.55, 0.1, 2.1) });
    const crownGeo = mergeGeoms(crownParts);
    const nutParts = [];
    for (let i = 0; i < 3; i++) {
      nutParts.push({
        geo: nutGeo,
        matrix: new THREE.Matrix4().makeTranslation(Math.cos(i * 2.1) * 0.55, -0.4, Math.sin(i * 2.1) * 0.55),
      });
    }
    const nutsGeo = mergeGeoms(nutParts);

    const makePalm = (x, z, height, phase) => {
      const palm = new THREE.Group();
      const lean = (rnd() - 0.5) * 0.14;
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.scale.y = height; trunk.position.y = height / 2; trunk.rotation.z = lean;
      trunk.castShadow = true;
      palm.add(trunk);
      const crown = new THREE.Mesh(crownGeo, frondMat);
      crown.position.set(lean * height * -0.5, height, 0);
      crown.castShadow = true;
      palm.add(crown);
      const nuts = new THREE.Mesh(nutsGeo, nutMat);
      nuts.position.copy(crown.position);
      palm.add(nuts);
      palm.position.set(x, 0, z);
      palm.rotation.y = rnd() * Math.PI * 2;
      this.scene.add(palm);
      this.palms.push({ crown, phase });
    };
    // Two rows along Neon Avenue (x = 30) and a scatter on the boardwalk.
    for (let z = -CITY_HALF + 10; z <= CITY_HALF - 10; z += 14) {
      makePalm(30 - 11, z + 2, 8 + rnd() * 3, z * 0.13);
      makePalm(30 + 11, z - 3, 8 + rnd() * 3, z * 0.13 + 2);
    }
    for (let j = 0; j <= GRID; j++) {
      const z = streetCoord(j);
      makePalm(30 - 11, z + 9, 7.6, j);
      makePalm(30 + 11, z - 9, 7.6, j + 3);
      makePalm(-150, z + 7, 7.2, j * 2);
    }
    for (let i = 0; i < 26; i++) {
      makePalm(-140 + rnd() * 320, COAST_Z - 6 + rnd() * 14, 6.5 + rnd() * 2.5, i);
    }
  }

  // ---- street lamps, traffic lights, hydrants, bins ------------------------
  _props() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x2e3438 });
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 7, 8);
    const headGeo = new THREE.SphereGeometry(0.32, 10, 8);
    const lampGeo = new THREE.SphereGeometry(0.34, 10, 8);
    for (let z = -CITY_HALF + 16; z <= CITY_HALF - 16; z += 28) {
      for (const side of [-1, 1]) {
        const x = 30 + side * 10.5;
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(x, 3.5, z); pole.castShadow = true; this.scene.add(pole);
        const arm = new THREE.Mesh(BOX, poleMat);
        arm.scale.set(1.8, 0.13, 0.13); arm.position.set(x - side * 0.9, 6.9, z);
        this.scene.add(arm);
        const lampMat = new THREE.MeshLambertMaterial({ color: 0xfff6c8, emissive: 0xffe9a0, emissiveIntensity: 0 });
        const head = new THREE.Mesh(headGeo, lampMat);
        head.position.set(x - side * 1.7, 6.8, z);
        this.scene.add(head);
        this.lampHeads.push(lampMat);
        // A warm pool of light on the asphalt under every lamp. Additive, cheap,
        // and it is what makes a lit street read as lit at night.
        const poolMat = new THREE.MeshBasicMaterial({
          color: 0xffd79a, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const pool = new THREE.Mesh(new THREE.CircleGeometry(5.2, 20), poolMat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(x - side * 1.7, 0.05, z);
        this.scene.add(pool);
        this.lampPools.push(poolMat);
      }
    }
    // Traffic lights at the four intersections of the two main avenues.
    const headMat = new THREE.MeshLambertMaterial({ color: 0x22262a });
    const mkLamp = (color) => new THREE.MeshLambertMaterial({
      color, emissive: color, emissiveIntensity: 0.15,
    });
    for (const ix of [3, 4]) {
      for (const iz of [3, 4]) {
        const x = streetCoord(ix) + STREET_W / 2 + 1.4;
        const z = streetCoord(iz) + STREET_W / 2 + 1.4;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 5.6, 8), poleMat);
        pole.position.set(x, 2.8, z); pole.castShadow = true; this.scene.add(pole);
        const head = new THREE.Mesh(BOX, headMat);
        head.scale.set(0.72, 1.95, 0.72); head.position.set(x, 5.8, z); this.scene.add(head);
        const red = new THREE.Mesh(lampGeo, mkLamp(0xff2a22));
        const amber = new THREE.Mesh(lampGeo, mkLamp(0xffb020));
        const green = new THREE.Mesh(lampGeo, mkLamp(0x2aff66));
        red.position.set(x, 6.4, z + 0.38); amber.position.set(x, 5.8, z + 0.38); green.position.set(x, 5.2, z + 0.38);
        this.scene.add(red, amber, green);
        this.trafficLights.push({ red, amber, green, offset: (ix + iz * 2) * 3.1 });
      }
    }
    // Hydrants and litter bins on the sidewalks.
    const hydMat = new THREE.MeshLambertMaterial({ color: 0xc23b2e });
    const binMat = new THREE.MeshLambertMaterial({ color: 0x2f5d4a });
    const hydGeo = new THREE.CylinderGeometry(0.22, 0.28, 0.9, 8);
    const binGeo = new THREE.CylinderGeometry(0.34, 0.3, 0.85, 10);
    const rnd = mulberry32(77);
    for (let i = 0; i < 40; i++) {
      const onAvenue = rnd() < 0.6;
      const x = onAvenue ? 30 + (rnd() < 0.5 ? -9.6 : 9.6) : streetCoord(Math.floor(rnd() * (GRID + 1)));
      const z = onAvenue ? -CITY_HALF + rnd() * CITY_HALF * 2 : -CITY_HALF + rnd() * CITY_HALF * 2;
      if (Math.abs(x - 30) < STREET_W / 2 && !onAvenue) continue;
      const m = new THREE.Mesh(rnd() < 0.5 ? hydGeo : binGeo, rnd() < 0.5 ? hydMat : binMat);
      m.position.set(x, 0.45, z); m.castShadow = true; this.scene.add(m);
    }
    // Parked cars along the kerb of the main avenue (stealable).
    this.parkedSpots = [];
    for (let i = 0; i < 16; i++) {
      const z = -CITY_HALF + 22 + i * 26;
      const side = i % 2 ? -1 : 1;
      this.parkedSpots.push({ x: 30 + side * (STREET_W / 2 - 1.6), z, heading: side > 0 ? Math.PI : 0 });
    }
  }

  // ---- the special buildings ----------------------------------------------
  _specials() {
    // Police station: a low civic block with a badge sign, at (-30, -150).
    this._civicBlock(-30, -150, 24, 12, 10, 0x9fb4c8, 'PORT AZUL PD', '#1b3a6b', '#ffffff');
    // Hospital: white block with a red cross, at (90, -90).
    this._hospital(90, -90);
    // Gas station: canopy + pumps on the highway shoulder at (-150, 150).
    this._gasStation(-150, 150);
    // A corner diner with a tall neon sign, on Neon Avenue.
    this._diner(60, 60);
    // A cinema with a marquee on the shopping strip.
    this._cinema(-90, 90);
  }

  _civicBlock(x, z, w, d, h, color, label, fg, bg) {
    const mat = new THREE.MeshLambertMaterial({ color });
    const b = new THREE.Mesh(BOX, mat);
    b.scale.set(w, h, d); b.position.set(x, h / 2, z);
    b.castShadow = true; b.receiveShadow = true; this.scene.add(b);
    // The height is stored on the footprint too, so a crash test can tell a
    // low civic block from a tower without a second lookup.
    this.colliders.push({ x, z, halfX: w / 2, halfZ: d / 2, h });
    const cap = new THREE.Mesh(BOX, this.roofDarkMat);
    cap.scale.set(w + 0.8, 0.7, d + 0.8); cap.position.set(x, h + 0.35, z); this.scene.add(cap);
    // Door band + windows.
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x24405e });
    for (let i = -2; i <= 2; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.4), glassMat);
      win.position.set(x + i * 4.4, 3.2, z + (d / 2 + 0.06));
      this.scene.add(win);
    }
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture(label, bg, fg) });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), signMat);
    sign.position.set(x, h + 3.4, z + d / 2 + 0.2);
    this.scene.add(sign);
    this.signs.push({ mesh: sign, mat: signMat, night: false, base: fg, sign: true });
  }

  _hospital(x, z) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xf2f4f6 });
    const b = new THREE.Mesh(BOX, mat);
    b.scale.set(30, 16, 22); b.position.set(x, 8, z);
    b.castShadow = true; b.receiveShadow = true; this.scene.add(b);
    this.colliders.push({ x, z, halfX: 15, halfZ: 11 });
    const cap = new THREE.Mesh(BOX, this.roofDarkMat);
    cap.scale.set(30.8, 0.8, 22.8); cap.position.set(x, 16.4, z); this.scene.add(cap);
    // A red cross on the roofline and on the facade.
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xe03a3a });
    const c1 = new THREE.Mesh(BOX, crossMat); c1.scale.set(6, 1.8, 0.4); c1.position.set(x, 19.2, z); this.scene.add(c1);
    const c2 = new THREE.Mesh(BOX, crossMat); c2.scale.set(1.8, 6, 0.4); c2.position.set(x, 19.2, z); this.scene.add(c2);
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x2b4a66 });
    for (let i = -3; i <= 3; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.0), glassMat);
      win.position.set(x + i * 4, 5.2, z + 11.06); this.scene.add(win);
    }
    // An ambulance parked at the entrance: the hospital reads as working.
    const amb = new THREE.Group();
    const ambBody = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
    const ambBox = new THREE.Mesh(BOX, ambBody);
    ambBox.scale.set(2.1, 1.3, 4.6); ambBox.position.y = 1.05; ambBox.castShadow = true;
    amb.add(ambBox);
    const cab = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xdfe4e8 }));
    cab.scale.set(2.0, 0.8, 1.2); cab.position.set(0, 0.85, -2.6); amb.add(cab);
    const tyreMat = new THREE.MeshLambertMaterial({ color: 0x0c0d0f });
    const hubMat = new THREE.MeshLambertMaterial({ color: 0xcfd4da });
    for (const s of [-1, 1]) {
      const crossA = new THREE.Mesh(BOX, crossMat);
      crossA.scale.set(0.7, 0.22, 0.06);
      crossA.position.set(s * 1.06, 1.4, 0.4);
      amb.add(crossA);
      const crossB = new THREE.Mesh(BOX, crossMat);
      crossB.scale.set(0.22, 0.7, 0.06);
      crossB.position.set(s * 1.06, 1.4, 0.4);
      amb.add(crossB);
      for (const zz of [-1.4, 1.4]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14), tyreMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(s * 1.02, 0.34, zz);
        amb.add(wheel);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.26, 10), hubMat);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(s * 1.02, 0.34, zz);
        amb.add(hub);
      }
    }
    amb.position.set(x - 20, 0, z + 14);
    amb.rotation.y = 0.2;
    this.scene.add(amb);
    // A parked ambulance is street furniture, not a building: it keeps cars and
    // pedestrians out of its footprint without becoming a wall on the minimap.
    this.colliders.push({ x: x - 20, z: z + 14, halfX: 2.4, halfZ: 1.2, h: 2.2 });
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture('PORT AZUL GENERAL', '#f4f6f8', '#c02626') });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), signMat);
    sign.position.set(x, 13.2, z + 11.2); this.scene.add(sign);
    this.signs.push({ mesh: sign, mat: signMat, night: false, base: '#c02626', sign: true });
  }

  _gasStation(x, z) {
    // Canopy on four columns, two pump islands, a small kiosk.
    const colMat = new THREE.MeshLambertMaterial({ color: 0xd8dde2 });
    for (const dx of [-9, 9]) for (const dz of [-5, 5]) {
      const col = new THREE.Mesh(CYL, colMat);
      col.scale.set(0.3, 6, 0.3); col.position.set(x + dx, 3, z + dz);
      col.castShadow = true; this.scene.add(col);
    }
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0xe8452f });
    const canopy = new THREE.Mesh(BOX, canopyMat);
    canopy.scale.set(22, 0.7, 13); canopy.position.set(x, 6.2, z); canopy.castShadow = true;
    this.scene.add(canopy);
    const trim = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
    trim.scale.set(22.4, 0.35, 13.4); trim.position.set(x, 5.8, z); this.scene.add(trim);
    const pumpMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const pumpScreen = new THREE.MeshBasicMaterial({ color: 0x5ff2ff });
    for (const dx of [-3.5, 3.5]) {
      const pump = new THREE.Mesh(BOX, pumpMat);
      pump.scale.set(1.1, 1.9, 0.8); pump.position.set(x + dx, 0.95, z); pump.castShadow = true;
      this.scene.add(pump);
      const scr = new THREE.Mesh(BOX, pumpScreen);
      scr.scale.set(0.8, 0.5, 0.06); scr.position.set(x + dx, 1.6, z + 0.44); this.scene.add(scr);
    }
    const kiosk = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xf0e6cf }));
    kiosk.scale.set(8, 3.4, 5); kiosk.position.set(x + 16, 1.7, z); kiosk.castShadow = true;
    this.scene.add(kiosk);
    this.colliders.push({ x: x + 16, z, halfX: 4, halfZ: 2.5 });
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture('GAS', '#ffd75e', '#20242e', '24 HRS') });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), signMat);
    sign.position.set(x, 9.2, z); this.scene.add(sign);
    this.signs.push({ mesh: sign, mat: signMat, night: false, base: '#ffd75e', sign: true });
  }

  _diner(x, z) {
    const body = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xf3e6cf }));
    body.scale.set(18, 5, 10); body.position.set(x, 2.5, z); body.castShadow = true;
    this.scene.add(body);
    this.colliders.push({ x, z, halfX: 9, halfZ: 5 });
    // A stainless-steel band and a striped awning.
    const band = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xcfd6dc }));
    band.scale.set(18.4, 1.0, 10.4); band.position.set(x, 4.4, z); this.scene.add(band);
    const awn = new THREE.Mesh(new THREE.BoxGeometry(18.4, 0.16, 3.2), this.awningMats[0]);
    awn.position.set(x, 3.6, z + 6.2); awn.rotation.x = -0.28; this.scene.add(awn);
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture('CORAL DINER', '#ff5da0', '#ffffff') });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), signMat);
    sign.position.set(x, 8.4, z + 3); this.scene.add(sign);
    this.signs.push({ mesh: sign, mat: signMat, night: false, base: '#ff5da0', sign: true });
  }

  _cinema(x, z) {
    const body = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x2b2f4a }));
    body.scale.set(22, 9, 14); body.position.set(x, 4.5, z); body.castShadow = true;
    this.scene.add(body);
    this.colliders.push({ x, z, halfX: 11, halfZ: 7 });
    const marqueeMat = new THREE.MeshBasicMaterial({ map: signTexture('NEON PALACE', '#12162a', '#ffd75e', 'NOW SHOWING') });
    const marquee = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), marqueeMat);
    marquee.position.set(x, 6.6, z + 7.2); this.scene.add(marquee);
    this.signs.push({ mesh: marquee, mat: marqueeMat, night: false, base: '#ffd75e', sign: true });
    // A vertical blade sign.
    const bladeMat = new THREE.MeshBasicMaterial({ map: signTexture('CINEMA', '#ff5da0', '#ffffff') });
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 9), bladeMat);
    blade.position.set(x + 12.2, 9, z + 4); blade.rotation.y = Math.PI / 2; this.scene.add(blade);
    this.signs.push({ mesh: blade, mat: bladeMat, night: false, base: '#ff5da0', sign: true });
  }

  // ---- the cargo port ------------------------------------------------------
  _port() {
    const px = -CITY_HALF - 70, pz = -60;
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(150, 190),
      new THREE.MeshLambertMaterial({ color: 0x9aa0a4 }));
    yard.rotation.x = -Math.PI / 2; yard.position.set(px, 0.03, pz); yard.receiveShadow = true;
    this.scene.add(yard);
    // Stacks of shipping containers.
    const hues = ['#c0392b', '#2980b9', '#27ae60', '#d4a017', '#8e44ad', '#16a085'];
    const contMats = hues.map((h) => new THREE.MeshLambertMaterial({ map: containerTexture(h) }));
    const rnd = mulberry32(2024);
    for (let i = 0; i < 26; i++) {
      const cx = px - 60 + rnd() * 120;
      const cz = pz - 80 + rnd() * 160;
      const stack = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < stack; s++) {
        const c = new THREE.Mesh(BOX, contMats[Math.floor(rnd() * contMats.length)]);
        c.scale.set(6.1, 2.6, 2.5);
        c.position.set(cx + (rnd() - 0.5) * 0.4, 1.3 + s * 2.65, cz);
        c.rotation.y = (rnd() - 0.5) * 0.12;
        c.castShadow = true; c.receiveShadow = true;
        this.scene.add(c);
      }
      this.colliders.push({ x: cx, z: cz, halfX: 3.2, halfZ: 1.5 });
    }
    // Gantry cranes: two portal frames with a beam and a trolley.
    const craneMat = new THREE.MeshLambertMaterial({ color: 0xe0a52a });
    for (const dz of [-40, 40]) {
      const crane = new THREE.Group();
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(BOX, craneMat);
        leg.scale.set(1.6, 26, 1.6); leg.position.set(s * 14, 13, 0); leg.castShadow = true;
        crane.add(leg);
      }
      const beam = new THREE.Mesh(BOX, craneMat);
      beam.scale.set(34, 2.2, 2.4); beam.position.set(0, 26, 0); beam.castShadow = true;
      crane.add(beam);
      const cab = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x30414f }));
      cab.scale.set(3, 2.6, 3); cab.position.set(4, 23.4, 0); crane.add(cab);
      crane.position.set(px, 0, pz + dz);
      this.scene.add(crane);
      this.colliders.push({ x: px - 14, z: pz + dz, halfX: 1, halfZ: 1 });
      this.colliders.push({ x: px + 14, z: pz + dz, halfX: 1, halfZ: 1 });
    }
    // A quay wall and a couple of cargo ships offshore.
    const quay = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x6d7276 }));
    quay.scale.set(150, 3, 8); quay.position.set(px, 1.5, pz + 100); this.scene.add(quay);
    for (const [ox, oz] of [[-40, 150], [30, 175]]) {
      const hull = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x24384a }));
      hull.scale.set(14, 4, 42); hull.position.set(px + ox, 0.5, pz + oz); this.scene.add(hull);
      const deck = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x8a9298 }));
      deck.scale.set(12, 5, 8); deck.position.set(px + ox, 5.5, pz + oz - 14); this.scene.add(deck);
    }
  }

  // ---- the highway bridge --------------------------------------------------
  _bridge() {
    // A causeway from the west edge of the grid out over the water, with
    // street lamps and a slight arch, so there is somewhere to drive to.
    const bx = -CITY_HALF - 150, bz = COAST_Z - 40;
    const deckMat = new THREE.MeshLambertMaterial({ map: this.texAsphalt });
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(260, 16), deckMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(bx, 4, bz);
    deck.receiveShadow = true;
    this.scene.add(deck);
    // Piers.
    const pierMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a4 });
    for (let i = 0; i < 8; i++) {
      const pier = new THREE.Mesh(BOX, pierMat);
      pier.scale.set(5, 8, 14);
      pier.position.set(bx - 120 + i * 34, 0, bz);
      this.scene.add(pier);
    }
    // Railings.
    const railMat = new THREE.MeshLambertMaterial({ color: 0xd8dde2 });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(BOX, railMat);
      rail.scale.set(260, 1.1, 0.4);
      rail.position.set(bx, 5.1, bz + s * 7.8);
      this.scene.add(rail);
    }
    this.bridge = { x: bx, z: bz, halfX: 130, halfZ: 8 };
  }

  // ---- the boardwalk and Ferris wheel -------------------------------------
  _ferrisWheel() {
    const px = 30, pz = COAST_Z + 20;
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x9a7b52 });
    const deck = new THREE.Mesh(BOX, deckMat);
    deck.scale.set(50, 1.2, 32); deck.position.set(px, 0.6, pz); deck.receiveShadow = true;
    this.scene.add(deck);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x6b5233 });
    for (let dx = -20; dx <= 20; dx += 10) {
      for (const dz of [-13, 13]) {
        const post = new THREE.Mesh(CYL, postMat);
        post.scale.set(0.5, 3, 0.5); post.position.set(px + dx, -0.8, pz + dz);
        this.scene.add(post);
      }
    }
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xff5d8f, emissive: 0x881133, emissiveIntensity: 0.25 });
    const innerMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0x7a5a00, emissiveIntensity: 0.25 });
    const spokeMat = new THREE.MeshLambertMaterial({ color: 0xfdf6ec });
    const hubMat = new THREE.MeshLambertMaterial({ color: 0xff5d8f });
    const legGeo = new THREE.CylinderGeometry(0.35, 0.5, 32, 8);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, spokeMat);
      leg.position.set(px + side * 5.5, 16, pz); leg.rotation.z = side * 0.32; leg.castShadow = true;
      this.scene.add(leg);
    }
    const wheel = new THREE.Group();
    wheel.position.set(px, 28, pz);
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(17, 0.55, 10, 48), rimMat));
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(11, 0.35, 8, 40), innerMat));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 16), hubMat);
    hub.rotation.x = Math.PI / 2; wheel.add(hub);
    const spokeGeo = new THREE.CylinderGeometry(0.16, 0.16, 17, 6);
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Mesh(spokeGeo, spokeMat);
      sp.rotation.z = (i / 8) * Math.PI; wheel.add(sp);
    }
    const cabinColors = [0xff5d8f, 0xffd23f, 0x2ec4b6, 0x4d96ff, 0xff7b2f, 0x9b5de5];
    const cabinGeo = new THREE.BoxGeometry(2.6, 2.2, 2.2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const cabin = new THREE.Mesh(cabinGeo,
        new THREE.MeshLambertMaterial({ color: cabinColors[i % cabinColors.length] }));
      cabin.position.set(Math.cos(a) * 17, Math.sin(a) * 17, 0);
      cabin.castShadow = true;
      wheel.add(cabin);
      this.gondolas.push(cabin);
    }
    this.scene.add(wheel);
    this.wheel = wheel;
    // A ticket booth and a neon sign so the wheel reads as an attraction.
    const booth = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xfdf6ec }));
    booth.scale.set(5, 3.2, 4); booth.position.set(px - 17, 2.8, pz - 12); booth.castShadow = true;
    this.scene.add(booth);
    const boothRoof = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xff5d8f }));
    boothRoof.scale.set(5.6, 0.4, 4.6); boothRoof.position.set(px - 17, 4.6, pz - 12);
    this.scene.add(boothRoof);
    this.colliders.push({ x: px - 17, z: pz - 12, halfX: 2.5, halfZ: 2 });
    const signMat = new THREE.MeshBasicMaterial({ map: signTexture('BOARDWALK', '#0d1220', '#5ff2ff', 'FERRIS WHEEL') });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 5), signMat);
    sign.position.set(px + 17, 6, pz - 12); this.scene.add(sign);
    this.signs.push({ mesh: sign, mat: signMat, night: false, base: '#5ff2ff', sign: true });
  }

  // ---- beach, sea, distant skyline -----------------------------------------
  _seaAndSkyline() {
    // A star dome and a moon disc. Both live on the sky sphere's radius, are
    // unlit, and are faded in only when the sky is dark — that is what makes
    // the night scene read as night instead of a dim day.
    this.nightSky = new THREE.Group();
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    const srnd = mulberry32(1234);
    for (let i = 0; i < 900; i++) {
      // Upper hemisphere, spread over the dome.
      const a = srnd() * Math.PI * 2;
      const el = Math.asin(srnd() * 0.98);
      const r = 1340;
      starPos.push(Math.cos(a) * Math.cos(el) * r, Math.sin(el) * r + 20, Math.sin(a) * Math.cos(el) * r);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xe8f0ff, size: 3.4, sizeAttenuation: false, transparent: true, opacity: 0,
      fog: false, depthWrite: false, depthTest: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.frustumCulled = false;
    // The sky dome is BackSide at radius 1400; the stars sit just inside it and
    // ignore depth, so a tall tower can never punch a hole in the sky.
    this.stars.renderOrder = -9;
    this.nightSky.add(this.stars);
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(46, 32),
      new THREE.MeshBasicMaterial({ color: 0xf6f2de, fog: false, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    this.moon.position.set(-600, 700, -920);
    this.moon.lookAt(30, 40, 40);
    this.moon.renderOrder = -8;
    // The night-sky group follows the camera's focus each frame, so the moon
    // is re-aimed at the viewer then too — a fixed world disc would turn edge-on.
    this.moonFocused = false;
    this.nightSky.add(this.moon);
    this.scene.add(this.nightSky);

    const sand = new THREE.Mesh(new THREE.PlaneGeometry(CITY_HALF * 2 + 260, 90),
      new THREE.MeshLambertMaterial({ map: this.texSand }));
    sand.rotation.x = -Math.PI / 2; sand.position.set(0, 0.02, COAST_Z + 26);
    sand.receiveShadow = true; this.scene.add(sand);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(CITY_HALF * 2 + 900, 700),
      new THREE.MeshPhongMaterial({
        map: this.texWater,
        normalMap: this.texWaterNormal,
        normalScale: new THREE.Vector2(0.75, 0.75),
        shininess: 140,
        specular: 0xbfe0ff,
      }));
    sea.rotation.x = -Math.PI / 2; sea.position.set(0, -0.35, COAST_Z + 260);
    this.scene.add(sea);
    this.sea = sea;
    // Surf lines: a few thin white strips that drift with the waves.
    this.waves = [];
    const waveMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    for (let i = 0; i < 5; i++) {
      const wave = new THREE.Mesh(new THREE.PlaneGeometry(CITY_HALF * 2 + 200, 1.6), waveMat);
      wave.rotation.x = -Math.PI / 2;
      wave.position.set(0, 0.03, COAST_Z + 18 + i * 9);
      this.scene.add(wave);
      this.waves.push(wave);
    }
    // A distant skyline across the bay: silhouettes that give the horizon depth.
    const towerMat = new THREE.MeshLambertMaterial({ color: 0x8fa8bd });
    const towerMat2 = new THREE.MeshLambertMaterial({ color: 0x7d99b0 });
    const rnd = mulberry32(99);
    for (let i = 0; i < 18; i++) {
      const w = 20 + rnd() * 26, h = 40 + rnd() * 100;
      const t = new THREE.Mesh(BOX, i % 2 ? towerMat : towerMat2);
      t.scale.set(w, h, w);
      const a = (i / 18) * Math.PI * 2, r = 420 + rnd() * 90;
      t.position.set(Math.cos(a) * r, h / 2 - 3, Math.sin(a) * r + COAST_Z);
      this.scene.add(t);
    }
  }

  // ---- a small park ---------------------------------------------------------
  _park() {
    // Grass, paths, benches and a pond between two downtown blocks.
    const px = 90, pz = 30;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(44, 44),
      new THREE.MeshLambertMaterial({ map: this.texGrass }));
    grass.rotation.x = -Math.PI / 2; grass.position.set(px, 0.04, pz); grass.receiveShadow = true;
    this.scene.add(grass);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(9, 28),
      new THREE.MeshLambertMaterial({ color: 0x2f7fb0 }));
    pond.rotation.x = -Math.PI / 2; pond.position.set(px + 6, 0.06, pz + 4);
    this.scene.add(pond);
    this.colliders.push({ x: px + 6, z: pz + 4, halfX: 8, halfZ: 8 });
    const benchMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
    for (const [ox, oz] of [[-12, -10], [12, -12], [-14, 12], [14, 14]]) {
      const bench = new THREE.Mesh(BOX, benchMat);
      bench.scale.set(2.4, 0.5, 0.7); bench.position.set(px + ox, 0.35, pz + oz);
      bench.castShadow = true; this.scene.add(bench);
    }
  }

  // ---- pier, lighthouse and beach furniture --------------------------------
  _pierAndBeach() {
    const postMat = new THREE.MeshLambertMaterial({ color: 0x5d452b });
    const pierMat = new THREE.MeshLambertMaterial({ color: 0x8a6a45 });
    // A fishing pier reaching into the surf south of the boardwalk.
    const px = 56, pz = COAST_Z + 60;
    const deck = new THREE.Mesh(BOX, pierMat);
    deck.scale.set(10, 0.7, 74); deck.position.set(px, 0.9, pz);
    deck.castShadow = true; deck.receiveShadow = true; this.scene.add(deck);
    for (let i = 0; i < 10; i++) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(CYL, postMat);
        post.scale.set(0.32, 2.6, 0.32);
        post.position.set(px + s * 4.6, -0.3, pz - 34 + i * 7.6);
        this.scene.add(post);
      }
    }
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(BOX, pierMat);
      rail.scale.set(0.22, 0.9, 74); rail.position.set(px + s * 4.9, 2.0, pz);
      this.scene.add(rail);
    }
    this.colliders.push({ x: px, z: pz + 34, halfX: 5, halfZ: 3 });

    // A lighthouse on the point with a slowly sweeping beam.
    const lx = 150, lz = COAST_Z + 6;
    const towerMat = new THREE.MeshLambertMaterial({ color: 0xf2f2ea });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0xd23b2e });
    const tower = new THREE.Mesh(CYL, towerMat);
    tower.scale.set(4.2, 22, 4.2); tower.position.set(lx, 11, lz); tower.castShadow = true;
    this.scene.add(tower);
    for (const [y, r] of [[5.5, 4.4], [11.5, 4.15]]) {
      const band = new THREE.Mesh(CYL, bandMat);
      band.scale.set(r, 1.4, r); band.position.set(lx, y, lz);
      this.scene.add(band);
    }
    const lampRoom = new THREE.Mesh(CYL, new THREE.MeshLambertMaterial({ color: 0x2b3440 }));
    lampRoom.scale.set(3.0, 3.0, 3.0); lampRoom.position.set(lx, 23.4, lz); this.scene.add(lampRoom);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(3.4, 3.2, 12), bandMat);
    cap.position.set(lx, 26.4, lz); this.scene.add(cap);
    this.colliders.push({ x: lx, z: lz, halfX: 4.4, halfZ: 4.4 });
    const beamGroup = new THREE.Group();
    beamGroup.position.set(lx, 23.4, lz);
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(4.5, 70, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff3b0, transparent: true, opacity: 0.055, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.rotation.z = Math.PI / 2;
    beam.position.set(35, 0, 0);
    beamGroup.add(beam);
    this.scene.add(beamGroup);
    this.lighthouseBeam = beamGroup;

    // Beach umbrellas scattered along the sand.
    const umbColors = [0xff5d8f, 0xffd23f, 0x2ec4b6, 0x4d96ff];
    for (let i = 0; i < 10; i++) {
      const ux = -190 + i * 42 + (i % 2) * 9;
      const uz = COAST_Z + 8 + (i % 3) * 7;
      const pole = new THREE.Mesh(CYL, postMat);
      pole.scale.set(0.09, 2.6, 0.09); pole.position.set(ux, 1.3, uz);
      this.scene.add(pole);
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.0, 8),
        new THREE.MeshLambertMaterial({ color: umbColors[i % umbColors.length], side: THREE.DoubleSide }));
      canopy.position.set(ux, 2.7, uz); canopy.castShadow = true;
      this.scene.add(canopy);
    }

    // A lifeguard tower on the sand.
    const lg = new THREE.Group();
    const lgMat = new THREE.MeshLambertMaterial({ color: 0xf2f2ea });
    const lgTrim = new THREE.MeshLambertMaterial({ color: 0xd23b2e });
    for (const [ox, oz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
      const leg = new THREE.Mesh(CYL, lgTrim);
      leg.scale.set(0.14, 4.2, 0.14); leg.position.set(ox, 2.1, oz);
      lg.add(leg);
    }
    const cab = new THREE.Mesh(BOX, lgMat); cab.scale.set(3.2, 2.0, 3.2); cab.position.y = 5.2; lg.add(cab);
    const roof = new THREE.Mesh(BOX, lgTrim); roof.scale.set(3.8, 0.24, 3.8); roof.position.y = 6.4; lg.add(roof);
    lg.position.set(-60, 0, COAST_Z + 12);
    lg.rotation.y = 0.4;
    lg.traverse((m) => { m.castShadow = true; });
    this.scene.add(lg);
    this.colliders.push({ x: -60, z: COAST_Z + 12, halfX: 2.4, halfZ: 2.4 });

    // Two pleasure boats bobbing offshore.
    this.boats = [];
    for (const [ox, oz, ry] of [[-110, COAST_Z + 130, 0.3], [140, COAST_Z + 175, -0.5]]) {
      const boat = new THREE.Group();
      const hull = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0xf2f2ea }));
      hull.scale.set(3.2, 1.1, 8); hull.position.y = 0.2; boat.add(hull);
      const cabin = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x2b4a66 }));
      cabin.scale.set(2.2, 1.1, 2.6); cabin.position.set(0, 1.2, 0.6); boat.add(cabin);
      const mast = new THREE.Mesh(CYL, new THREE.MeshLambertMaterial({ color: 0x8a6a45 }));
      mast.scale.set(0.09, 4.2, 0.09); mast.position.set(0, 3.0, -1.2); boat.add(mast);
      boat.position.set(ox, 0.1, oz); boat.rotation.y = ry;
      this.scene.add(boat);
      this.boats.push({ mesh: boat, phase: ox });
    }
  }

  // ---- per-frame animation and the day/night pass ---------------------------
  update(dt, t, env) {
    const day = clamp(env.day, 0, 1);
    const dusk = clamp(env.dusk, 0, 1);
    if (this.wheel) {
      this.wheel.rotation.z -= dt * 0.1;
      for (const g of this.gondolas) g.rotation.z = -this.wheel.rotation.z;
    }
    // Traffic-light cycle.
    const CYCLE = 14;
    for (const tl of this.trafficLights) {
      const ph = (((t + tl.offset) % CYCLE) + CYCLE) % CYCLE;
      const on = (m, lit) => { m.material.emissiveIntensity = lit ? 1.8 : 0.12; };
      on(tl.green, ph < 6); on(tl.amber, ph >= 6 && ph < 7.5); on(tl.red, ph >= 7.5);
    }
    // Palm sway and the surf.
    for (const p of this.palms) {
      p.crown.rotation.z = Math.sin(t * 0.8 + p.phase) * 0.04;
      p.crown.rotation.x = Math.cos(t * 0.6 + p.phase) * 0.025;
    }
    if (this.waves) {
      for (let i = 0; i < this.waves.length; i++) {
        const w = this.waves[i];
        w.position.z = COAST_Z + 18 + i * 9 + Math.sin(t * 0.6 + i) * 1.6;
        w.material.opacity = 0.34 + Math.sin(t * 0.9 + i) * 0.16;
      }
    }
    // The sea's ripple normal map drifts, which is what makes the water move.
    if (this.sea) {
      this.texWaterNormal.offset.x = (t * 0.012) % 1;
      this.texWaterNormal.offset.y = (t * 0.02) % 1;
      // Night kills the specular sheen so the bay is not a mirror at 3 stars.
      this.sea.material.shininess = 40 + day * 120;
      this.sea.material.specular.setHex(day > 0.3 ? 0xbfe0ff : 0x1a2433);
    }
    if (this.lighthouseBeam) this.lighthouseBeam.rotation.y += dt * 0.45;
    if (this.boats) {
      for (const b of this.boats) {
        b.mesh.position.y = 0.1 + Math.sin(t * 0.7 + b.phase) * 0.22;
        b.mesh.rotation.z = Math.sin(t * 0.5 + b.phase) * 0.03;
      }
    }
    // Day/night: the sun arcs, the sky and fog follow, windows and signs glow.
    const night = day < 0.26;
    const top = mixColor('#050816', '#3f8fdd', day).lerp(new THREE.Color('#2a2f6b'), dusk * 0.6);
    const mid = mixColor('#0d1a30', '#8fcdf0', day).lerp(new THREE.Color('#b8548a'), dusk * 0.65);
    const horizon = mixColor('#1b2b4a', '#f7e3c0', day).lerp(new THREE.Color('#ff9a4d'), dusk * 0.8);
    this._paintSky('#' + top.getHexString(), '#' + mid.getHexString(), '#' + horizon.getHexString());
    this.scene.background.copy(horizon);
    this.scene.fog.color.copy(horizon);
    this.scene.fog.near = lerp(150, 340, day);
    this.scene.fog.far = lerp(950, 1500, day);

    const sd = env.sunDir;
    this.sun.position.copy(env.focus).addScaledVector(sd, 430);
    this.sun.target.position.copy(env.focus);
    this.sun.target.updateMatrixWorld();
    this.sun.intensity = lerp(0.55, 2.35, day) * (1 - dusk * 0.3);
    this.sun.color.copy(mixColor('#a8c4e8', '#ffe7b8', day).lerp(new THREE.Color('#ff9a4d'), dusk * 0.7));
    this.hemi.intensity = lerp(0.72, 0.95, day);
    this.hemi.color.copy(mixColor('#4a5f88', '#bfe3ff', day));
    this.hemi.groundColor.copy(mixColor('#3a4258', '#e8c9a0', day));
    this.ambient.intensity = lerp(0.55, 0.16, day);

    // The visible sun sits far along its arc and fades out below the horizon.
    const discPos = env.focus.clone().addScaledVector(sd, 1280);
    this.sunDisc.position.copy(discPos);
    this.sunDisc.lookAt(env.focus);
    this.sunGlow.position.copy(discPos).multiplyScalar(1.002);
    this.sunGlow.lookAt(env.focus);
    const sunUp = clamp(sd.y * 4 + 0.45, 0, 1);
    this.sunDisc.material.opacity = 0.95 * sunUp;
    this.sunGlow.material.opacity = 0.28 * sunUp;
    this.sky.position.copy(env.focus);
    // Stars and moon fade in with the darkness, and follow the camera so they
    // are always on the dome. (env.day is read through the closure `day`, so
    // the sky and the sea always agree.)
    const starOn = clamp((0.3 - day) / 0.3, 0, 1);
    this.nightSky.position.copy(env.focus);
    if (this.starMat) this.starMat.opacity = starOn * 0.95;
    if (this.moon) {
      this.moon.material.opacity = starOn * 0.9;
      this.moon.lookAt(env.focus);
    }

    if (night !== this._night) {
      this._night = night;
      for (const m of this.windowMats) m.emissiveIntensity = night ? 0.9 : 0;
      for (const lm of this.lampHeads) lm.emissiveIntensity = night ? 1.15 : 0;
      for (const lp of this.lampPools) lp.opacity = night ? 0.16 : 0;
      for (const b of this.carHeadlights) b.opacity = night ? 0.1 : 0.035;
      for (const s of this.signs) {
        if (s.night) s.mat.color.setHex(night ? 0xff5566 : 0x772222);
        else s.mat.opacity = night ? 1 : 0.82;
        s.mat.transparent = true;
        s.mat.needsUpdate = true;
      }
    }
  }

  /** Repaint the sky dome's gradient when its three colours change. */
  _paintSky(top, mid, horizon) {
    const key = top + mid + horizon;
    if (key === this._skyKey) return;
    this._skyKey = key;
    const g = this.skyCanvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(0.52, mid);
    grad.addColorStop(0.78, horizon);
    grad.addColorStop(1, horizon);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    this.skyTex.needsUpdate = true;
  }

  /** Building footprint test with a margin, used by cars and pedestrians. */
  hitsBuilding(x, z, margin = 0) {
    return this.buildingAt(x, z, margin) !== null;
  }

  /**
   * Bucket the building footprints into a coarse grid so a hit test touches a
   * handful of candidates instead of every building in the city. Footprints are
   * inserted inflated by the largest margin any caller uses, so a query near a
   * cell edge still finds the building in the next cell.
   */
  _buildColliderGrid() {
    this._gridCell = 30;
    this._grid = new Map();
    const INFLATE = 2;
    for (const c of this.colliders) {
      const x0 = Math.floor((c.x - c.halfX - INFLATE) / this._gridCell);
      const x1 = Math.floor((c.x + c.halfX + INFLATE) / this._gridCell);
      const z0 = Math.floor((c.z - c.halfZ - INFLATE) / this._gridCell);
      const z1 = Math.floor((c.z + c.halfZ + INFLATE) / this._gridCell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const k = gx + ',' + gz;
          let arr = this._grid.get(k);
          if (!arr) { arr = []; this._grid.set(k, arr); }
          arr.push(c);
        }
      }
    }
  }

  /** How many building footprints the city holds (shown on the pause screen). */
  countColliders() { return this.colliders.length; }

  /**
   * The building footprint under (x,z) — the one a car is about to hit, or null
   * when the point is clear. The collider grid keeps this to a couple of
   * lookups instead of a scan of every building.
   */
  buildingAt(x, z, margin = 0) {
    const cell = this._grid.get(Math.floor(x / this._gridCell) + ',' + Math.floor(z / this._gridCell));
    if (!cell) return null;
    for (const c of cell) {
      if (Math.abs(x - c.x) < c.halfX + margin && Math.abs(z - c.z) < c.halfZ + margin) return c;
    }
    return null;
  }

  /**
   * The raised deck under (x,z): 1.2 on the boardwalk, 1.25 on the fishing
   * pier, 0 elsewhere. The decks are boxes whose tops sit at those heights, so
   * this is the height a standing walker or a parked wheel rests on.
   */
  deckHeight(x, z) {
    if (x > 5 && x < 55 && z > COAST_Z + 4 && z < COAST_Z + 36) return 1.2;   // boardwalk
    if (x > 50 && x < 62 && z > COAST_Z + 4 && z < COAST_Z + 98) return 1.25; // pier
    return 0;
  }

  /** True on the boardwalk deck or the fishing pier, where the ground is raised. */
  isDryDeck(x, z) {
    return this.deckHeight(x, z) > 0;
  }

  /** True when (x,z) is open water: the sea south of the beach. */
  isWater(x, z) {
    return z > COAST_Z + 58 && !this.isDryDeck(x, z);
  }

  /** The walkable ground height (the decks are raised a little). */
  groundHeightAt(x, z) {
    return this.deckHeight(x, z);
  }

  /** The playable rectangle, in metres: the grid, the port and the beach. */
  worldLimit() {
    return { minX: -360, maxX: 320, minZ: -340, maxZ: COAST_Z + 58 };
  }

  /** Street name and district for the HUD, from a world position. */
  locationAt(x, z) {
    let street = null;
    let best = Infinity;
    for (let i = 0; i <= GRID; i++) {
      const dx = Math.abs(x - streetCoord(i));
      const dz = Math.abs(z - streetCoord(i));
      if (dx < STREET_W / 2 + 1 && dx < best) { best = dx; street = AVENUES[i]; }
      if (dz < STREET_W / 2 + 1 && dz < best) { best = dz; street = AVENUES[i]; }
    }
    let district;
    if (z > CITY_HALF - 10) district = 'THE BOARDWALK';
    else if (x < -CITY_HALF - 20) district = 'THE DOCKS';
    else if (Math.abs(x - 30) < 45) district = z > -30 ? 'THE STRIP' : 'DOWNTOWN';
    else {
      const ix = clamp(Math.floor((x + CITY_HALF) / PITCH), 0, GRID - 1);
      const iz = clamp(Math.floor((z + CITY_HALF) / PITCH), 0, GRID - 1);
      district = DISTRICTS[(ix * 3 + iz) % DISTRICTS.length];
    }
    return { street: street || 'Coral Way', district };
  }

  /** A street point a given distance from (x, z), for spawning traffic and police. */
  randomStreetPoint(x, z, minDist = 70) {
    let best = null;
    let bestD = -1;
    for (let tries = 0; tries < 14; tries++) {
      const i = 1 + Math.floor(Math.random() * (GRID - 1));
      const j = 1 + Math.floor(Math.random() * (GRID - 1));
      const along = (Math.random() - 0.5) * (PITCH - STREET_W);
      const p = Math.random() < 0.5
        ? { x: streetCoord(i), z: streetCoord(j) + along, axis: 'z' }
        : { x: streetCoord(i) + along, z: streetCoord(j), axis: 'x' };
      const d = Math.hypot(p.x - x, p.z - z);
      // The caller (the sidewalk refill) needs a pedestrian out of sight, not
      // one materialising at the player's feet: honour the requested distance,
      // and if no candidate clears it, fall back to the farthest one tried.
      if (d >= minDist) return p;
      if (d > bestD) { bestD = d; best = p; }
    }
    return best ?? { x: streetCoord(1), z: streetCoord(1), axis: 'z' };
  }
}
