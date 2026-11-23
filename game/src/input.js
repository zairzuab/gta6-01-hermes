// Input: keyboard, mouse and pointer state for the game.
//
// The whole layer is event-driven and frameless by design: DOM listeners only
// record what happened; every consumer reads through this class at its own
// rhythm, and the loop brackets each frame with beginFrame()/endFrame().
//
// Three views over the same data:
//   down(code)      level       - is the key held right now?
//   pressed(code)   edge        - did it go down since the last poll?
//   released(code)  edge        - did it come back up since last frame?
//
// Keys are matched by KeyboardEvent.code ("KeyW", "Space", ...), so the player
// can use any layout and the physical position of a key never matters.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    // Held keys, plus the previous frame's snapshot for release edges.
    this.keys = new Set();
    this._prev = new Set();

    // A tap shorter than one frame can fall between two polls, so every
    // non-repeat keydown lands here until someone calls pressed().
    this._queue = new Set();

    // Pointer state. `mouseDX/DY` accumulate movement between frames; X/Y are
    // the last known client position.
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseDown = false;
    this.mouseClicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;

    // Wheel steps accumulated for the frame (-1/0/+1 after takeWheel()).
    this.wheel = 0;

    // One-shot flags the menu layer drains each frame.
    this.muteToggle = false;
    this.anyKey = false;

    this.locked = false;

    const onKeyDown = (e) => {
      // Space/Tab would scroll or focus a button, the arrows are the alternate
      // driving controls - none of them belong to the browser while playing.
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
      this.anyKey = true;
      if (e.code === 'KeyM') this.muteToggle = true;
      if (!e.repeat) {
        this.keys.add(e.code);
        this._queue.add(e.code);
      }
    };
    const onKeyUp = (e) => this.keys.delete(e.code);

    const onMouseMove = (e) => {
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    };
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      this.keys.add('MouseLeft');
      this.mouseDown = true;
      this.mouseClicked = true;
    };
    const onMouseUp = (e) => {
      if (e.button !== 0) return;
      this.keys.delete('MouseLeft');
      this.mouseDown = false;
    };
    const onWheel = (e) => { this.wheel += Math.sign(e.deltaY); };

    // A blur must drop the whole snapshot, not just the held keys: leaving
    // `_prev` behind let the next frame report a release edge for a key that
    // was never actually let go.
    const onBlur = () => {
      this.keys.clear();
      this._prev.clear();
      this._queue.clear();
      this.mouseDown = false;
      this.mouseClicked = false;
    };

    // Pointer lock is read through `locked`; who reacts to it (the pause path)
    // is main.js's policy, not the input layer's.
    const onLockChange = () => { this.locked = document.pointerLockElement === canvas; };
    const onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onWheel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLockChange);
    canvas.addEventListener('contextmenu', onContextMenu);
  }

  // ---- pointer lock --------------------------------------------------------
  /** Capture the mouse so the camera can be steered (ESC releases it). */
  lock() {
    try {
      // Current browsers return a promise; an unhandled rejection (denied or
      // headless tab) would surface as a console error during normal play.
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* denied or unsupported: the game still runs */ }
  }

  unlock() {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch { /* already unlocked */ }
  }

  // ---- queries -------------------------------------------------------------
  /** Level: the key is down right now. */
  down(code) { return this.keys.has(code); }

  /** Edge: the key went down since the last poll, and is consumed by it. */
  pressed(code) {
    if (!this._queue.has(code)) return false;
    this._queue.delete(code);
    return true;
  }

  /**
   * Edge: the key came back up. Uses the previous-frame snapshot rather than
   * the queue, because a slow frame can drain the queue before a caller polls
   * it, which would swallow the release entirely.
   */
  released(code) { return !this.keys.has(code) && this._prev.has(code); }

  /** True while the pointer is captured, i.e. the mouse steers the view. */
  get looking() { return this.locked; }

  /** Take the single click of this frame (true once). */
  takeClick() {
    const c = this.mouseClicked;
    this.mouseClicked = false;
    return c;
  }

  /** Take the accumulated wheel steps of this frame (-1, 0, +1). */
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  // ---- frame bookkeeping ---------------------------------------------------
  /** Clear the per-frame accumulators; call at the end of a frame. */
  beginFrame() {
    this.mouseClicked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.muteToggle = false;
    this.anyKey = false;
  }

  /** Snapshot held keys so next frame can detect releases. */
  endFrame() { this._prev = new Set(this.keys); }
}
