// Input: keyboard, mouse and pointer state. Keys are read by code (KeyW,
// Space, ...) so the layout does not matter, and `pressed()` is an edge
// trigger (true only on the frame a key goes down).
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this._prev = new Set();
    // Keys that went down since the last poll. A tap shorter than one frame
    // would otherwise be missed entirely at a low frame rate.
    this._queue = new Set();
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDown = false;
    this.mouseClicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.muteToggle = false;
    this.anyKey = false;

    this._onKeyDown = (e) => {
      // Space and Tab would scroll or focus a button, and the arrow keys are
      // the game's alternate driving controls; keep all of them for the game.
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) { this.keys.add(e.code); this._queue.add(e.code); }
      this.anyKey = true;
      if (e.code === 'KeyM') this.muteToggle = true;
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => {
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) { this.keys.add('MouseLeft'); this.mouseDown = true; this.mouseClicked = true; }
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) { this.keys.delete('MouseLeft'); this.mouseDown = false; }
    };
    this._onWheel = (e) => { this.wheel += Math.sign(e.deltaY); };
    this._onBlur = () => {
      // Drop the whole snapshot, not just the held keys: a blur used to leave
      // `_prev` and the mouse button behind, so the next frame could report a
      // release edge for a key that was never let go.
      this.keys.clear();
      this._prev.clear();
      this._queue.clear();
      this.mouseDown = false;
      this.mouseClicked = false;
    };
    this._onLockChange = () => { this.locked = document.pointerLockElement === canvas; };
    // Releasing the pointer lock is how the player leaves the pause menu's
    // "ESC" path; the game reads that in main.js rather than here, so the input
    // layer stays free of game-state policy.
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', this._onContextMenu);
    this.locked = false;
  }

  /** Capture the mouse so the camera can be steered (ESC releases it). */
  lock() {
    try {
      // requestPointerLock returns a promise in current browsers; an unhandled
      // rejection (a denied lock, a headless tab) would otherwise surface as a
      // console error during normal play.
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => { /* denied: the game still runs, just without mouse look */ });
    } catch { /* headless or denied */ }
  }
  unlock() {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
  }

  down(code) { return this.keys.has(code); }
  /** True once per key-down, even if the tap was shorter than a frame. */
  pressed(code) {
    if (this._queue.has(code)) { this._queue.delete(code); return true; }
    return false;
  }
  /**
   * True on the frame a held key comes back up. `pressed()` is edge-triggered
   * off the queue, which a slow frame can drain before the caller polls it, so
   * the release path uses the previous-frame snapshot instead.
   */
  released(code) { return !this.keys.has(code) && this._prev.has(code); }
  /**
   * True while the pointer is captured. The camera only turns with the mouse
   * when it is, so a click on a menu button never spins the view.
   */
  get looking() { return this.locked; }
  /** Take the single click of this frame (true once). */
  takeClick() { const c = this.mouseClicked; this.mouseClicked = false; return c; }
  /** Take the accumulated wheel steps of this frame (-1, 0, +1). */
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }
  beginFrame() {
    this.mouseClicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.muteToggle = false;
    this.anyKey = false;
  }
  endFrame() { this._prev = new Set(this.keys); }
}
