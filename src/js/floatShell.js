import { currentWindow, invoke } from "./tauri.js";

const dpi = window.__TAURI__?.dpi;
const ICON_SIZE = 62;
const EDGE_SLIVER = 14;
const EDGE_THRESHOLD = 26;
const MAX_W = 900;
const MAX_H = 1100;

export function createFloatShell({ label }) {
  const win = currentWindow();
  const card = document.getElementById("card");
  const grip = document.getElementById("resizeGrip");
  let collapsed = false;
  let expanded = { w: null, h: null };
  let expandedPos = null;
  let collapsedPos = null;
  let uiRef = {};
  let persistTimer = null;
  let dock = null;
  let dockHidden = false;
  let ignoreMoved = false;
  let moveTimer = null;

  const persistNow = () =>
    invoke("set_float_ui", {
      label,
      patch: {
        collapsed,
        dock,
        w: expanded.w,
        h: expanded.h,
        ...(expandedPos ? { x: expandedPos.x, y: expandedPos.y } : {}),
        ...(collapsedPos ? { cx: collapsedPos.x, cy: collapsedPos.y } : {}),
      },
    }).catch(() => {});

  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 400);
  };

  const scale = async () => (await win.scaleFactor()) || 1;

  async function setLogicalSize(w, h) {
    const k = await scale();
    await win.setSize(new dpi.PhysicalSize(Math.round(w * k), Math.round(h * k)));
  }

  async function setPhysicalPos(x, y) {
    await win.setPosition(new dpi.PhysicalPosition(Math.round(x), Math.round(y)));
  }

  async function capturePos() {
    const pos = await win.outerPosition();
    return { x: pos.x, y: pos.y };
  }

  async function monitorBounds() {
    const k = await scale();
    const s = window.screen;
    return {
      x: s.availLeft * k,
      y: s.availTop * k,
      w: s.availWidth * k,
      h: s.availHeight * k,
    };
  }

  async function monitorInfo() {
    const mon = await monitorBounds();
    const size = await win.outerSize();
    const pos = await win.outerPosition();
    const k = await scale();
    return { mon, size, pos, k };
  }

  function clampY(mon, size, y) {
    const margin = 4;
    const minY = mon.y + margin;
    const maxY = mon.y + mon.h - size.height - margin;
    return Math.min(Math.max(y, minY), Math.max(minY, maxY));
  }

  async function evaluateDock() {
    if (!collapsed) {
      dock = null;
      return;
    }
    const { mon, size, pos, k } = await monitorInfo();
    const threshold = EDGE_THRESHOLD * k;
    const leftDist = pos.x - mon.x;
    const rightDist = mon.x + mon.w - (pos.x + size.width);
    if (leftDist <= threshold) {
      dock = "left";
      await slideOut();
    } else if (rightDist <= threshold) {
      dock = "right";
      await slideOut();
    } else {
      dock = null;
      dockHidden = false;
      persist();
    }
  }

  async function slideOut() {
    if (!dock) return;
    const { mon, size, pos, k } = await monitorInfo();
    const threshold = EDGE_THRESHOLD * k;
    const leftDist = pos.x - mon.x;
    const rightDist = mon.x + mon.w - (pos.x + size.width);
    if (leftDist > threshold && rightDist > threshold) {
      dock = null;
      dockHidden = false;
      persist();
      return;
    }
    dock = leftDist <= rightDist ? "left" : "right";
    const sliver = Math.round(EDGE_SLIVER * k);
    const y = clampY(mon, size, pos.y);
    const x =
      dock === "left" ? mon.x - (size.width - sliver) : mon.x + mon.w - sliver;
    ignoreMoved = true;
    await setPhysicalPos(x, y);
    dockHidden = true;
    setTimeout(() => {
      ignoreMoved = false;
    }, 300);
    persist();
  }

  async function slideIn() {
    if (!dock) return;
    const { mon, size, pos } = await monitorInfo();
    const y = clampY(mon, size, pos.y);
    const x = dock === "left" ? mon.x : mon.x + mon.w - size.width;
    ignoreMoved = true;
    await setPhysicalPos(x, y);
    dockHidden = false;
    setTimeout(() => {
      ignoreMoved = false;
    }, 300);
  }

  async function collapse() {
    if (collapsed) return;
    const k = await scale();
    const size = await win.outerSize();
    expanded = { w: Math.round(size.width / k), h: Math.round(size.height / k) };
    expandedPos = await capturePos();
    collapsed = true;
    document.body.classList.add("collapsed");
    await persistNow();
    await setLogicalSize(ICON_SIZE, ICON_SIZE);
    const target =
      collapsedPos ||
      (uiRef.cx != null && uiRef.cy != null ? { x: uiRef.cx, y: uiRef.cy } : null) ||
      expandedPos;
    if (target) await setPhysicalPos(target.x, target.y);
    persist();
  }

  async function expand() {
    if (!collapsed) return;
    dock = null;
    dockHidden = false;
    collapsedPos = await capturePos();
    collapsed = false;
    document.body.classList.remove("collapsed");
    await persistNow();
    if (expanded.w && expanded.h) await setLogicalSize(expanded.w, expanded.h);
    if (expandedPos) await setPhysicalPos(expandedPos.x, expandedPos.y);
    persist();
  }

  async function applyInitial(ui) {
    uiRef = ui || {};
    expanded = uiRef.w && uiRef.h ? { w: uiRef.w, h: uiRef.h } : { w: null, h: null };
    expandedPos = uiRef.x != null && uiRef.y != null ? { x: uiRef.x, y: uiRef.y } : null;
    collapsedPos = uiRef.cx != null && uiRef.cy != null ? { x: uiRef.cx, y: uiRef.cy } : null;
    if (uiRef.collapsed) {
      collapsed = true;
      document.body.classList.add("collapsed");
      await setLogicalSize(ICON_SIZE, ICON_SIZE);
      if (collapsedPos) await setPhysicalPos(collapsedPos.x, collapsedPos.y);
      if (uiRef.dock === "left" || uiRef.dock === "right") {
        dock = uiRef.dock;
        await slideOut();
      }
    } else if (expanded.w && expanded.h) {
      await setLogicalSize(expanded.w, expanded.h);
      if (expandedPos) await setPhysicalPos(expandedPos.x, expandedPos.y);
    }
  }

  if (grip) {
    grip.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (collapsed) return;
      try {
        await win.startResizeDragging("SouthEast");
      } catch {
        /* ignore */
      }
    });
  }

  if (card) {
    card.addEventListener("mousedown", (e) => {
      if (!collapsed || e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;

      const onMove = async (ev) => {
        if (dragging) return;
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
          dragging = true;
          cleanup();
          dock = null;
          dockHidden = false;
          try {
            await win.startDragging();
          } catch {
            /* ignore */
          }
        }
      };
      const onUp = (ev) => {
        cleanup();
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) {
          expand();
        }
      };
      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  win
    .onResized(async () => {
      const k = await scale();
      const size = await win.outerSize();
      const w = size.width / k;
      const h = size.height / k;
      if (collapsed) {
        if (Math.abs(w - ICON_SIZE) > 3 || Math.abs(h - ICON_SIZE) > 3) {
          await setLogicalSize(ICON_SIZE, ICON_SIZE);
        }
        return;
      }
      if (w > MAX_W || h > MAX_H) {
        if (expanded.w && expanded.h) await setLogicalSize(expanded.w, expanded.h);
        return;
      }
      expanded.w = Math.round(w);
      expanded.h = Math.round(h);
      persist();
    })
    .catch(() => {});

  if (card) {
    card.addEventListener("mouseenter", () => {
      if (collapsed && dock && dockHidden) slideIn();
    });
    card.addEventListener("mouseleave", () => {
      if (collapsed && dock && !dockHidden) slideOut();
    });
  }

  win
    .onMoved(async () => {
      if (ignoreMoved) return;
      const pos = await capturePos();
      if (collapsed) collapsedPos = pos;
      else expandedPos = pos;
      if (collapsed) {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(() => {
          evaluateDock();
        }, 600);
      }
    })
    .catch(() => {});

  return {
    collapse,
    expand,
    applyInitial,
    isCollapsed: () => collapsed,
    noteSize: (w, h) => {
      expanded.w = w;
      expanded.h = h;
      persist();
    },
    setUi: (patch) => {
      uiRef = { ...uiRef, ...patch };
      return invoke("set_float_ui", { label, patch }).catch(() => {});
    },
  };
}
