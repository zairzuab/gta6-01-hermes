// HUD: every DOM overlay plus the circular minimap.
//
// One class owns the whole screen furniture. It stays deliberately dumb: the
// game pushes live values in through the setters below and this module decides
// what actually reaches the DOM. Two rules shape those setters:
//
//   * Write only on change. When an argument matches the last one seen, the
//     setter returns without touching innerHTML or a style, so a quiet street
//     does not pay for a rebuild every frame.
//   * Guard the optional elements. A few ids (#prompt, #toast, #arrestWrap,
//     #dmgFlash) can be absent or hidden depending on context, so every touch
//     of them is guarded and the HUD still works.
import { WEAPONS } from './weapons.js';
import { CITY_HALF, GRID, COAST_Z, streetCoord } from './city.js';
import { formatClock } from './util.js';

// Every element id this module writes to, resolved once at construction.
const IDS = [
  'mCount', 'mName', 'mStage', 'mBarFill', 'mObj', 'mReward', 'stars', 'sightLine',
  'money', 'clock', 'healthBar', 'healthVal', 'staminaBar', 'staminaVal', 'armourBar',
  'armourVal', 'weaponName', 'weaponAmmo', 'rankLine', 'slots', 'dispatchList', 'locName',
  'speedVal', 'carName', 'engineBar', 'engineVal', 'radioLine', 'tickerAvatar', 'tickerName',
  'tickerText', 'centerBig', 'centerSub', 'dmgFlash', 'crosshair', 'fpsTag',
  'prompt', 'arrestWrap', 'arrestFill', 'toast', 'clockTag', 'speedo',
];

// The minimap canvas is square and shows MAP_RANGE metres edge to edge, so the
// world-to-pixel factor is a constant rather than something recomputed per blip.
const MAP_SIZE = 202;
const MAP_RANGE = 200;
const MAP_SCALE = MAP_SIZE / MAP_RANGE;

/** The star row is always five cells, lit or dim. */
const STAR_COUNT = 5;

/** The rank ladder printed beside the rank number. */
function rankTitle(rank) {
  if (rank >= 9) return 'KINGPIN';
  if (rank >= 7) return 'CREW BOSS';
  if (rank >= 5) return 'ENFORCER';
  if (rank >= 3) return 'RUNNER';
  return 'STREET';
}

export class Hud {
  constructor() {
    this.el = {};
    for (const id of IDS) this.el[id] = document.getElementById(id);

    this.minimap = document.getElementById('minimap');
    this.mm = this.minimap.getContext('2d');

    // Cached weapon-slot nodes and the three message countdowns.
    this.slotEls = [];
    this.centerTimer = 0;
    this.tickerTimer = 0;
    this.toastTimer = 0;
    this.toastQueue = [];

    // Objective line state: the base text plus the live distance suffix.
    this._objText = '';
    this._markerDist = null;

    this.buildSlots();
  }

  // ---- weapon slots --------------------------------------------------------
  buildSlots() {
    this.el.slots.innerHTML = '';
    this.slotEls = [];
    WEAPONS.forEach((w, i) => {
      const d = document.createElement('div');
      d.className = 'slot';
      d.id = 'slot' + i;
      d.innerHTML = `<span class="ic">${w.icon}</span><span>${w.name.split(' ')[0]}</span><span class="key">${i + 1}</span>`;
      this.el.slots.appendChild(d);
      this.slotEls.push(d);
    });
  }

  // ---- mission card --------------------------------------------------------
  setMission(mission, stage, stageIndex, progress) {
    this.el.mCount.textContent = mission.count;
    this.el.mName.textContent = mission.name;
    this.el.mReward.textContent = '$' + mission.reward.toLocaleString('en-US');
    this.el.mStage.innerHTML = `STAGE ${stageIndex + 1} OF ${mission.stages.length} · <b>${stage.name}</b>`;
    this.el.mBarFill.style.width = `${Math.round(progress * 100)}%`;
    this._objText = stage.obj;
    this.el.mObj.textContent = this._objectiveText();
  }

  /** Live distance to the current objective, appended to the objective line. */
  setMarkerDist(d) {
    if (d === this._markerDist) return;
    this._markerDist = d;
    this.el.mObj.textContent = this._objectiveText();
  }

  _objectiveText() {
    if (this._markerDist == null || !Number.isFinite(this._markerDist)) return this._objText || '';
    return `${this._objText || ''}  ·  ${Math.round(this._markerDist)} m`;
  }

  // ---- wanted level --------------------------------------------------------
  setWanted(stars, inSight) {
    if (stars !== this._stars) {
      this._stars = stars;
      let html = '';
      for (let i = 0; i < STAR_COUNT; i++) html += `<span class="${i < stars ? 'on' : 'off'}">★</span>`;
      this.el.stars.innerHTML = html;
      this.el.stars.style.transform = stars >= 4 ? 'scale(1.1)' : 'scale(1)';
    }
    const sight = stars === 0 ? 'CLEAN' : (inSight ? 'IN SIGHT' : 'LOSING THEM…');
    if (sight !== this._sight) {
      this._sight = sight;
      this.el.sightLine.textContent = sight;
      this.el.sightLine.style.color = stars === 0 ? '#7dffa8' : '#ff5d5d';
    }
  }

  // ---- vitals and loadout --------------------------------------------------
  setStats(money, health, armour, stamina, weapon, ammo, rank, respect) {
    this.el.money.textContent = '$' + money.toLocaleString('en-US');
    this.el.healthBar.style.width = `${Math.max(0, health)}%`;
    this.el.healthVal.textContent = Math.round(health);
    this.el.staminaBar.style.width = `${Math.max(0, stamina)}%`;
    this.el.staminaVal.textContent = Math.round(stamina);
    this.el.armourBar.style.width = `${Math.max(0, armour)}%`;
    this.el.armourVal.textContent = Math.round(armour);
    this.el.weaponName.textContent = weapon.name;
    this.el.weaponAmmo.textContent = ammo.mag === Infinity ? '∞' : `${ammo.mag} / ${ammo.reserve}`;
    this.el.rankLine.textContent = `RANK ${rank} · ${rankTitle(rank)} · ${respect} REP`;
  }

  setSlots(activeIndex, owned) {
    WEAPONS.forEach((w, i) => {
      const s = this.slotEls[i];
      if (!s) return;
      s.classList.toggle('active', i === activeIndex);
      s.style.opacity = owned[i] ? '1' : '0.32';
    });
    this._activeIndex = activeIndex;
  }

  /** Flag the active weapon slot when its magazine and reserve are both empty. */
  setDryFire(on) {
    if (on === this._dry) return;
    // Clear the previous slot's flag before moving to the new one.
    const prev = this.slotEls[this._activeIndex];
    if (prev) prev.style.borderColor = '';
    this._dry = on;
    const s = this.slotEls[this._activeIndex];
    if (s) s.style.borderColor = on ? '#ff4d5e' : '';
  }

  // ---- dispatch list -------------------------------------------------------
  setDispatch(units) {
    const html = units.length === 0
      ? '<div class="unit"><span class="call">—</span><span class="kind">NO UNITS</span><span class="st">CLEAR</span></div>'
      : units.map((u) =>
        `<div class="unit"><span class="call">${u.call}</span><span class="kind">${u.kind}</span>` +
        `<span class="dist">${u.dist} m</span><span class="st ${u.cls}">${u.status}</span></div>`).join('');
    // A pursuit's distances change; a quiet street shows the same empty block
    // for hours, so compare before paying for innerHTML.
    if (html === this._dispatchHtml) return;
    this._dispatchHtml = html;
    this.el.dispatchList.innerHTML = html;
  }

  // ---- speedometer ---------------------------------------------------------
  setSpeed(kmh, carName, enginePct, radio) {
    const speedHtml = `${Math.round(kmh)} <small>KM/H</small>`;
    if (speedHtml !== this._speedHtml) {
      this._speedHtml = speedHtml;
      this.el.speedVal.innerHTML = speedHtml;
    }
    if (carName !== this._carName) {
      this._carName = carName;
      this.el.carName.textContent = carName;
    }
    const engine = Math.round(enginePct);
    if (engine !== this._enginePct) {
      this._enginePct = engine;
      this.el.engineBar.style.width = `${engine}%`;
      this.el.engineVal.textContent = `${engine}%`;
    }
    if (radio !== this._radio) {
      this._radio = radio;
      this.el.radioLine.textContent = radio;
    }
    // On foot the engine gauge is hidden by CSS and the panel is tagged so the
    // label colour changes — no dead "ENGINE 96%" readout.
    this.el.speedo.classList.toggle('onfoot', carName === 'ON FOOT');
  }

  // ---- place and clock -----------------------------------------------------
  setLocation(street, district) {
    const html = `${district}<small>${street}</small>`;
    if (html === this._locHtml) return;
    this._locHtml = html;
    this.el.locName.innerHTML = html;
  }

  setClock(minutes) {
    this.el.clock.textContent = formatClock(minutes);
  }

  // ---- transient messages --------------------------------------------------
  ticker(name, avatar, text, dur = 6) {
    this.el.tickerName.textContent = name;
    this.el.tickerAvatar.textContent = avatar;
    this.el.tickerText.textContent = text;
    this.tickerTimer = dur;
  }

  center(big, sub, tone = '', dur = 2.6) {
    this.el.centerBig.textContent = big;
    this.el.centerBig.className = 'big' + (tone ? ' ' + tone : '');
    this.el.centerSub.textContent = sub;
    this.centerTimer = dur;
  }

  toast(text, dur = 2.4) {
    if (!this.el.toast) return;
    this.el.toast.textContent = text;
    this.el.toast.style.opacity = '1';
    this.toastTimer = dur;
  }

  // ---- full-screen feedback ------------------------------------------------
  damageFlash(strength) {
    if (!this.el.dmgFlash) return;
    this.el.dmgFlash.style.boxShadow = `inset 0 0 130px rgba(255,0,0,${0.25 + strength * 0.5})`;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      this._flashTimer = 0;
      this.el.dmgFlash.style.boxShadow = 'inset 0 0 130px rgba(255,0,0,0)';
    }, 170);
  }

  /** The low-health vignette: a red edge that strengthens as health falls. */
  setHealthTone(health) {
    if (!this.el.dmgFlash) return;
    if (health > 35 || this._flashTimer) return;   // a hit flash wins
    const p = 1 - Math.max(0, health) / 35;
    this.el.dmgFlash.style.boxShadow = `inset 0 0 130px rgba(255,0,0,${(p * 0.22).toFixed(3)})`;
  }

  /** The small "E — ENTER CAR" line above the crosshair. */
  setPrompt(text) {
    if (!this.el.prompt) return;
    this.el.prompt.textContent = text || '';
    this.el.prompt.style.display = text ? 'block' : 'none';
  }

  /** The "BUSTED" arrest bar, shown while an officer has you boxed in. */
  setArrest(p) {
    if (!this.el.arrestWrap) return;
    this.el.arrestWrap.style.display = p > 0.01 ? 'block' : 'none';
    this.el.arrestFill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  }

  setCrosshair(on) { this.el.crosshair.style.display = on ? 'block' : 'none'; }
  setFps(n) { this.el.fpsTag.textContent = n ? `${n} FPS` : ''; }

  // ---- minimap -------------------------------------------------------------
  /** Streets, sea, player arrow, police blips, the marker and the roadblock. */
  drawMinimap(px, pz, heading, police, marker, heli, roadblock = null) {
    const g = this.mm;
    const C = MAP_SIZE / 2;
    g.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    g.save();
    g.beginPath();
    g.arc(C, C, C - 2, 0, Math.PI * 2);
    g.clip();

    // Land, then the rotated world layer on top of it.
    g.fillStyle = '#14304e';
    g.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    g.save();
    g.translate(C, C);
    g.rotate(heading);
    g.translate(-px * MAP_SCALE, -pz * MAP_SCALE);

    // The sea south of the coast road, with a sand strip above it.
    g.fillStyle = '#1d5c8c';
    g.fillRect((-CITY_HALF - 60) * MAP_SCALE, (COAST_Z + 6) * MAP_SCALE,
      (CITY_HALF * 2 + 120) * MAP_SCALE, 200 * MAP_SCALE);
    g.fillStyle = '#e8d9a8';
    g.fillRect((-CITY_HALF - 60) * MAP_SCALE, COAST_Z * MAP_SCALE,
      (CITY_HALF * 2 + 120) * MAP_SCALE, 7 * MAP_SCALE);
    // The cargo port yard, west of the grid, so the docks are on the map.
    g.fillStyle = '#3a4553';
    g.fillRect((-CITY_HALF - 150) * MAP_SCALE, -160 * MAP_SCALE, 150 * MAP_SCALE, 190 * MAP_SCALE);

    // Streets: a wide dark band plus a lighter centreline.
    for (const [width, color] of [[8, '#2c3d52'], [1.4, '#54687e']]) {
      g.strokeStyle = color;
      g.lineWidth = width;
      for (let i = 0; i <= GRID; i++) {
        const c = streetCoord(i);
        g.beginPath(); g.moveTo(c * MAP_SCALE, (-CITY_HALF - 40) * MAP_SCALE);
        g.lineTo(c * MAP_SCALE, (CITY_HALF + 60) * MAP_SCALE); g.stroke();
        g.beginPath(); g.moveTo((-CITY_HALF - 40) * MAP_SCALE, c * MAP_SCALE);
        g.lineTo((CITY_HALF + 40) * MAP_SCALE, c * MAP_SCALE); g.stroke();
      }
    }
    // The highway bridge west over the water, then the boardwalk deck.
    g.strokeStyle = '#54687e';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo((-CITY_HALF - 160) * MAP_SCALE, (COAST_Z - 40) * MAP_SCALE);
    g.lineTo((-CITY_HALF + 20) * MAP_SCALE, (COAST_Z - 40) * MAP_SCALE);
    g.stroke();
    g.fillStyle = '#9a7b52';
    g.fillRect(5 * MAP_SCALE, (COAST_Z + 4) * MAP_SCALE, 50 * MAP_SCALE, 32 * MAP_SCALE);

    // Mission marker: a pulsing diamond, coloured by objective type.
    if (marker) {
      const pulse = 1 + Math.sin(performance.now() / 190) * 0.28;
      g.fillStyle = marker.color === 0x4da3ff ? '#4da3ff'
        : marker.color === 0xff4d5e ? '#ff4d5e'
          : marker.color === 0x7dffa8 ? '#7dffa8' : '#ffd75e';
      g.save();
      g.translate(marker.x * MAP_SCALE, marker.z * MAP_SCALE);
      g.rotate(Math.PI / 4);
      const s = 6 * pulse;
      g.fillRect(-s, -s, s * 2, s * 2);
      g.restore();
    }
    // Police blips (red) and the helicopter (blue).
    for (const p of police) {
      g.fillStyle = '#ff3b30';
      g.beginPath(); g.arc(p.x * MAP_SCALE, p.z * MAP_SCALE, 4.6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.4; g.stroke();
    }
    if (heli) {
      g.fillStyle = '#4da3ff';
      g.beginPath(); g.arc(heli.x * MAP_SCALE, heli.z * MAP_SCALE, 5.2, 0, Math.PI * 2); g.fill();
    }
    // A roadblock is a hazard, not a unit: an orange chevron across the road.
    if (roadblock) {
      g.save();
      g.translate(roadblock.x * MAP_SCALE, roadblock.z * MAP_SCALE);
      g.rotate(roadblock.heading + Math.PI / 4);
      g.fillStyle = '#ff9f43';
      g.fillRect(-6, -6, 12, 12);
      g.restore();
    }
    g.restore();

    // Player arrow at the centre, pointing up.
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#1b2230';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(C, C - 11); g.lineTo(C + 7, C + 8); g.lineTo(C, C + 3); g.lineTo(C - 7, C + 8);
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 11px Arial';
    g.textAlign = 'center';
    g.fillText('N', C, 15);
    g.restore();
  }

  // ---- per-frame countdowns ------------------------------------------------
  update(dt) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0 && this.el.toast) this.el.toast.style.opacity = '0';
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) {
        this.el.centerBig.textContent = '';
        this.el.centerSub.textContent = '';
      }
    }
    if (this.tickerTimer > 0) {
      this.tickerTimer -= dt;
      if (this.tickerTimer <= 0) this.el.tickerText.textContent = '';
    }
  }
}
