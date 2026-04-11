import { SvgRenderer } from "./svg-renderer.js";

const notato = window.notato;

function generateId() {
  const ms = BigInt(Date.now());
  const xor = ms ^ (ms << 5n);
  const r = Number(BigInt.asUintN(64, xor) & 0xffffffffn);
  return ms.toString(16) + (r >>> 0).toString(16);
}

/** Cmd on macOS, Ctrl on Windows/Linux — matches platform edit shortcuts. */
function primaryModDown(e) {
  return e.metaKey || e.ctrlKey;
}

const container = document.getElementById("app");
const toolbar = document.getElementById("toolbar");
const status = document.getElementById("status");
const canvasPanel = document.getElementById("canvas-panel");
const toolbarDrag = document.getElementById("toolbar-drag");
const renderer = new SvgRenderer(container);

/** Saved pixel positions; null = use stylesheet default placement. */
let uiLayout = {
  /** @type {{ left: number; top: number } | null} */
  toolbar: null,
  /** @type {{ left: number; top: number } | null} */
  canvasPanel: null,
};

/** @type {{ el: HTMLElement; kind: 'toolbar' | 'canvasPanel'; offsetX: number; offsetY: number } | null} */
let panelDrag = null;

const selectionOverlay = document.getElementById("selection-overlay");
const selectionMarquee = document.getElementById("selection-marquee");
const resizeHandleBr = document.getElementById("resize-handle-br");
const selectionTransformBar = document.getElementById(
  "selection-transform-bar",
);
const flipHBtn = document.getElementById("flip-h-btn");
const flipVBtn = document.getElementById("flip-v-btn");
const rotateHandle = document.getElementById("rotate-handle");

/** @type {'move' | 'resize' | 'rotate' | null} */
let dragMode = null;
let lastPointer = { x: 0, y: 0 };
/** @type {{ cx: number; cy: number; d0: number; s0: number } | null} */
let resizeSession = null;
/** @type {{ cx: number; cy: number; angle0: number; r0: number } | null} */
let rotateSession = null;

let isDrawing = false;
let drawingEnabled = true;
let appVisible = true;
let currentColor = "#FF3B30";
let currentSize = 10;
let currentTool = "pen";
let currentBackground = "transparent";
let statusTimer = null;

let activeCanvasId = null;
let autoSaveTimer = null;

function clampPanelToViewport(el, left, top) {
  const margin = 8;
  const r = el.getBoundingClientRect();
  const w = r.width || el.offsetWidth || 40;
  const h = r.height || el.offsetHeight || 40;
  const maxL = Math.max(margin, window.innerWidth - w - margin);
  const maxT = Math.max(margin, window.innerHeight - h - margin);
  return {
    left: Math.min(Math.max(margin, left), maxL),
    top: Math.min(Math.max(margin, top), maxT),
  };
}

function applyToolbarPosition() {
  if (uiLayout.toolbar) {
    const c = clampPanelToViewport(
      toolbar,
      uiLayout.toolbar.left,
      uiLayout.toolbar.top,
    );
    uiLayout.toolbar = c;
    toolbar.style.left = `${c.left}px`;
    toolbar.style.top = `${c.top}px`;
    toolbar.style.transform = "none";
  } else {
    toolbar.style.left = "";
    toolbar.style.top = "";
    toolbar.style.transform = "";
  }
}

function applyCanvasPanelPosition() {
  if (uiLayout.canvasPanel) {
    const c = clampPanelToViewport(
      canvasPanel,
      uiLayout.canvasPanel.left,
      uiLayout.canvasPanel.top,
    );
    uiLayout.canvasPanel = c;
    canvasPanel.style.left = `${c.left}px`;
    canvasPanel.style.top = `${c.top}px`;
  } else {
    canvasPanel.style.left = "";
    canvasPanel.style.top = "";
  }
}

function onPanelDragMove(e) {
  if (!panelDrag) return;
  const { el, offsetX, offsetY } = panelDrag;
  const left = e.clientX - offsetX;
  const top = e.clientY - offsetY;
  const c = clampPanelToViewport(el, left, top);
  el.style.left = `${c.left}px`;
  el.style.top = `${c.top}px`;
  if (panelDrag.kind === "toolbar") {
    el.style.transform = "none";
  }
}

function onPanelDragEnd() {
  if (!panelDrag) return;
  const { el, kind } = panelDrag;
  const r = el.getBoundingClientRect();
  const pos = { left: r.left, top: r.top };
  if (kind === "toolbar") {
    uiLayout.toolbar = pos;
  } else {
    uiLayout.canvasPanel = pos;
  }
  panelDrag = null;
  window.removeEventListener("pointermove", onPanelDragMove);
  window.removeEventListener("pointerup", onPanelDragEnd);
  window.removeEventListener("pointercancel", onPanelDragEnd);
  void persistUiPrefs();
}

/**
 * @param {HTMLElement} panelEl
 * @param {'toolbar' | 'canvasPanel'} kind
 * @param {PointerEvent} e
 */
function startPanelDrag(panelEl, kind, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const r = panelEl.getBoundingClientRect();
  panelEl.style.left = `${r.left}px`;
  panelEl.style.top = `${r.top}px`;
  if (kind === "toolbar") {
    panelEl.style.transform = "none";
  }
  panelDrag = {
    el: panelEl,
    kind,
    offsetX: e.clientX - r.left,
    offsetY: e.clientY - r.top,
  };
  window.addEventListener("pointermove", onPanelDragMove);
  window.addEventListener("pointerup", onPanelDragEnd);
  window.addEventListener("pointercancel", onPanelDragEnd);
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function setupMovablePanels() {
  if (toolbarDrag) {
    toolbarDrag.addEventListener("pointerdown", (e) => {
      startPanelDrag(toolbar, "toolbar", e);
    });
  }
  const header = canvasPanel.querySelector(".panel-header");
  if (header) {
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      startPanelDrag(canvasPanel, "canvasPanel", e);
    });
  }
  window.addEventListener("resize", () => {
    applyToolbarPosition();
    applyCanvasPanelPosition();
  });
}

function showStatus(text, duration = 800) {
  status.textContent = text;
  status.style.opacity = "1";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.style.opacity = "0.5";
  }, duration);
}

function scheduleAutoSave() {
  if (!activeCanvasId) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveActiveCanvas, 1500);
}

async function saveActiveCanvas() {
  if (!activeCanvasId || !notato) return;
  const state = await notato.loadState();
  const index = state.index || [];
  const entry = index.find((c) => c.id === activeCanvasId);
  if (!entry) return;
  entry.updated_at = Date.now();
  await notato.saveState(state);
  await notato.saveCanvas(activeCanvasId, {
    document: renderer.getState(),
    background: currentBackground,
  });
}

/** Ensures at least one saved canvas exists so drawing is always associated with a file. */
async function ensureDefaultCanvas() {
  if (!notato) return;
  const state = await notato.loadState();
  const index = state.index || [];
  if (index.length > 0) return;

  const id = generateId();
  index.push({
    id,
    name: "Canvas 1",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  state.index = index;
  activeCanvasId = id;
  state.active_canvas_id = id;
  renderer.clear();
  currentBackground = "transparent";
  applyBackground();
  await notato.saveState(state);
  await notato.saveCanvas(id, {
    document: renderer.getState(),
    background: currentBackground,
  });
  await persistUiPrefs();
  renderPanel();
}

async function saveCanvas() {
  if (!notato) return;
  if (activeCanvasId) {
    await saveActiveCanvas();
    showStatus("Saved");
  } else {
    const id = generateId();
    const state = await notato.loadState();
    const index = state.index || [];
    index.push({
      id,
      name: `Canvas ${index.length + 1}`,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    state.index = index;
    activeCanvasId = id;
    state.active_canvas_id = id;
    await notato.saveState(state);
    await notato.saveCanvas(id, {
      document: renderer.getState(),
      background: currentBackground,
    });
    showStatus("Canvas saved");
  }
  await persistUiPrefs();
  renderPanel();
}

async function newBlankCanvas() {
  if (!activeCanvasId && !renderer.isEmpty()) {
    await saveCanvas();
  }
  if (activeCanvasId) await saveActiveCanvas();

  const id = generateId();
  const state = await notato.loadState();
  const index = state.index || [];
  index.push({
    id,
    name: `Canvas ${index.length + 1}`,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  state.index = index;
  activeCanvasId = id;
  state.active_canvas_id = id;
  await notato.saveState(state);

  renderer.clear();
  updateSelectionOverlay();
  currentBackground = "transparent";
  applyBackground();
  await notato.saveCanvas(id, {
    document: renderer.getState(),
    background: currentBackground,
  });
  await persistUiPrefs();
  renderPanel();
  showStatus("New canvas");
}

async function loadCanvas(id) {
  if (id === activeCanvasId || !notato) return;
  if (activeCanvasId) await saveActiveCanvas();

  const data = await notato.loadCanvas(id);
  renderer.setState(data.document || data);
  currentBackground = data.background || "transparent";
  applyBackground();

  activeCanvasId = id;
  const state = await notato.loadState();
  state.active_canvas_id = id;
  await notato.saveState(state);
  renderPanel();

  const index = state.index || [];
  const entry = index.find((c) => c.id === id);
  if (entry) showStatus(`Loaded "${entry.name}"`);
}

async function deleteCanvas(id) {
  if (!notato) return;
  let state = await notato.loadState();
  let index = state.index || [];
  index = index.filter((c) => c.id !== id);
  state.index = index;
  await notato.deleteCanvasFile(id);
  await notato.saveState(state);

  if (activeCanvasId !== id) {
    renderPanel();
    return;
  }

  if (index.length > 0) {
    const next = index[0];
    const data = await notato.loadCanvas(next.id);
    renderer.setState(data.document || data);
    currentBackground = data.background || "transparent";
    applyBackground();
    activeCanvasId = next.id;
    state.active_canvas_id = next.id;
    await notato.saveState(state);
    updateSelectionOverlay();
  } else {
    await ensureDefaultCanvas();
  }
  renderPanel();
}

async function renameCanvas(id, newName) {
  const trimmed = newName.trim();
  if (!trimmed || !notato) return;
  const state = await notato.loadState();
  const index = state.index || [];
  const entry = index.find((c) => c.id === id);
  if (entry) {
    entry.name = trimmed;
    await notato.saveState(state);
    renderPanel();
  }
}

function renderPanel() {
  const list = document.getElementById("canvas-list");
  if (!list) return;

  const run = async () => {
    if (!notato) return;
    const state = await notato.loadState();
    const index = state.index || [];
    list.innerHTML = "";

    if (index.length === 0) {
      list.innerHTML =
        '<div class="canvas-empty">No saved canvases.<br>Use Save in the toolbar to store a canvas.</div>';
      return;
    }

    for (const entry of index) {
      const item = document.createElement("div");
      item.className =
        "canvas-item" + (entry.id === activeCanvasId ? " active" : "");

      const name = document.createElement("span");
      name.className = "canvas-name";
      name.textContent = entry.name;
      name.title = "Double-click to rename";

      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(entry.id, name);
      });

      const del = document.createElement("button");
      del.className = "canvas-delete";
      del.title = "Delete";
      del.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"/></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCanvas(entry.id);
      });

      item.appendChild(name);
      item.appendChild(del);
      item.addEventListener("click", () => loadCanvas(entry.id));
      list.appendChild(item);
    }
  };
  void run();
}

function startRename(id, nameEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "canvas-rename-input";
  input.value = nameEl.textContent;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    input.removeEventListener("blur", commit);
    renameCanvas(id, input.value);
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") renderPanel();
  });
}

function setTool(tool) {
  if (tool !== "select") {
    renderer.setSelectedId(null);
    updateSelectionOverlay();
  }
  currentTool = tool;
  document.querySelectorAll(".toolbar-btn[data-tool]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  const labels = {
    pen: "Pen",
    eraser: "Eraser",
    line: "Line",
    arrow: "Arrow",
    rect: "Rectangle",
    rectFilled: "Filled Rect",
    circle: "Circle",
    circleFilled: "Filled Circle",
    select: "Select",
  };
  showStatus(`${labels[tool] ?? tool} tool`);
  updateDrawingCursor();
  void persistUiPrefs();
}

/**
 * @param {string} hex
 * @returns {{ r: number; g: number; b: number }}
 */
function parseHexRgb(hex) {
  if (typeof hex !== "string" || !hex.length) return { r: 0, g: 0, b: 0 };
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return { r: 0, g: 0, b: 0 };
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Transparent Electron windows on macOS often report `devicePixelRatio === 1` on Retina hardware;
 * use media queries so we still rasterize at 2× (or higher) when the display is HiDPI.
 */
function effectiveCursorDpr() {
  let d = window.devicePixelRatio || 1;
  try {
    const hiDpi =
      matchMedia("(min-resolution: 2dppx)").matches ||
      matchMedia("(-webkit-min-device-pixel-ratio: 2)").matches;
    if (hiDpi && d < 1.75) {
      d = 2;
    }
  } catch {
    /* ignore */
  }
  return Math.min(Math.max(d, 1), 4);
}

/**
 * PNG data URLs work as CSS cursors on Windows; SVG data URLs often do not.
 * Draw in device pixels (no canvas scale transform). macOS composites cursors aggressively;
 * use a higher internal scale there so the bitmap stays sharp after downscaling.
 * CSP must allow img-src data: (see index.html).
 *
 * @param {string} color
 * @param {number} strokeWidth
 * @returns {string}
 */
function brushDotCursorCss(color, strokeWidth) {
  const mac = document.documentElement.classList.contains("platform-darwin");
  const rCss = Math.min(Math.max(strokeWidth / 2, 2), 28);
  const padCss = 4;
  const baseDpr = effectiveCursorDpr();
  const dpr = mac
    ? Math.min(Math.max(Math.round(baseDpr * 2), 3), 6)
    : baseDpr;

  const rDev = Math.max(2, Math.round(rCss * dpr));
  const lwBlack = Math.max(1, Math.round(baseDpr));
  const padDev = Math.max(2, Math.round(padCss * baseDpr));
  const outerR = rDev + lwBlack * 0.5 + padDev;
  let bmp = Math.max(9, Math.ceil(outerR * 2));
  if (bmp % 2 === 1) bmp += 1;

  const cx = bmp / 2;
  const cy = bmp / 2;
  const hx = Math.floor(bmp / 2);
  const hy = Math.floor(bmp / 2);
  const { r: fr, g: fg, b: fb } = parseHexRgb(color);

  const canvas = document.createElement("canvas");
  canvas.width = bmp;
  canvas.height = bmp;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "default";

  if (mac) {
    ctx.imageSmoothingEnabled = false;
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  ctx.beginPath();
  ctx.arc(cx, cy, rDev, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = lwBlack;
  ctx.stroke();

  let url;
  try {
    url = canvas.toDataURL("image/png");
  } catch {
    return "default";
  }
  return `url("${url}") ${hx} ${hy}, default`;
}

function updateSelectionOverlay() {
  const id = renderer.getSelectedId();
  if (
    !id ||
    !selectionOverlay ||
    !selectionMarquee ||
    !resizeHandleBr ||
    !rotateHandle ||
    !selectionTransformBar ||
    !flipHBtn ||
    !flipVBtn
  ) {
    if (selectionOverlay) {
      selectionOverlay.classList.add("hidden");
      selectionOverlay.setAttribute("aria-hidden", "true");
    }
    return;
  }
  const r = renderer.getItemClientRect(id);
  if (!r || r.width < 1 || r.height < 1) {
    selectionOverlay.classList.add("hidden");
    selectionOverlay.setAttribute("aria-hidden", "true");
    return;
  }
  selectionOverlay.classList.remove("hidden");
  selectionOverlay.setAttribute("aria-hidden", "false");
  selectionMarquee.style.left = `${r.left}px`;
  selectionMarquee.style.top = `${r.top}px`;
  selectionMarquee.style.width = `${r.width}px`;
  selectionMarquee.style.height = `${r.height}px`;
  resizeHandleBr.style.left = `${r.right}px`;
  resizeHandleBr.style.top = `${r.bottom}px`;
  selectionTransformBar.style.left = `${r.left + r.width / 2}px`;
  selectionTransformBar.style.top = `${r.bottom + 8}px`;
  const t = renderer.getSelectedTransform();
  if (t) {
    flipHBtn.classList.toggle("is-active", t.flipX);
    flipVBtn.classList.toggle("is-active", t.flipY);
  }
}

function updateDrawingCursor() {
  const el = renderer.getElement();
  if (currentTool === "select") {
    el.style.cursor = "default";
    return;
  }
  if (currentTool === "eraser") {
    el.style.cursor = "not-allowed";
    return;
  }
  el.style.cursor = brushDotCursorCss(currentColor, currentSize);
}

/**
 * @param {boolean} [hardReset] If true, briefly set default cursor (fixes stuck WebKit cursor after
 *   display / activation changes). Soft path only reapplies the brush — avoids arrow flashing while drawing.
 */
function forceRefreshDrawingCursor(hardReset = false) {
  if (!drawingEnabled) {
    updateDrawingCursor();
    return;
  }
  const el = renderer.getElement();
  if (currentTool === "select" || currentTool === "eraser") {
    updateDrawingCursor();
    return;
  }
  if (hardReset) {
    el.style.cursor = "default";
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      updateDrawingCursor();
    });
  });
}

window.addEventListener("resize", () => {
  renderer.resize();
  updateSelectionOverlay();
  updateDrawingCursor();
});

window.addEventListener("focus", () => {
  if (isDrawing) return;
  forceRefreshDrawingCursor(false);
});

document.addEventListener(
  "pointerenter",
  (e) => {
    if (isDrawing) return;
    const rt = e.relatedTarget;
    if (rt && document.documentElement.contains(rt)) return;
    forceRefreshDrawingCursor(false);
  },
  true,
);

function getPoint(e) {
  return {
    x: e.clientX,
    y: e.clientY,
    pressure: e.pressure || 0.5,
    time: performance.now(),
  };
}

const svgEl = renderer.getElement();

/** While drawing a stroke/shape; window listeners keep receiving events over the toolbar (Linux). */
let drawingPointerId = null;
/** @type {(() => void) | null} */
let detachDrawingStrokeListeners = null;

function endDrawingStrokeFromPointer(e) {
  if (!isDrawing || e.pointerId !== drawingPointerId) return;
  if (detachDrawingStrokeListeners) {
    detachDrawingStrokeListeners();
  }
  isDrawing = false;
  drawingPointerId = null;
  try {
    svgEl.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (currentTool === "pen" || currentTool === "eraser") {
    renderer.endStroke();
    if (currentTool === "eraser") {
      updateSelectionOverlay();
    }
  } else {
    renderer.endShape();
  }
  scheduleAutoSave();
}

function attachDrawingStrokeListeners() {
  if (detachDrawingStrokeListeners) return;
  const move = (e) => {
    if (!isDrawing || e.pointerId !== drawingPointerId) return;
    const point = getPoint(e);
    if (currentTool === "pen" || currentTool === "eraser") {
      renderer.addPoint(point);
      if (currentTool === "eraser") {
        updateSelectionOverlay();
      }
    } else {
      renderer.updateShape(point);
    }
  };
  const end = (e) => {
    endDrawingStrokeFromPointer(e);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  detachDrawingStrokeListeners = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    detachDrawingStrokeListeners = null;
  };
}

resizeHandleBr.addEventListener("pointerdown", (e) => {
  if (!drawingEnabled || currentTool !== "select") return;
  if (!renderer.getSelectedId()) return;
  e.stopPropagation();
  resizeSession = renderer.beginResize(e.clientX, e.clientY);
  if (!resizeSession) return;
  dragMode = "resize";
  resizeHandleBr.setPointerCapture(e.pointerId);
  e.preventDefault();
});

resizeHandleBr.addEventListener("pointermove", (e) => {
  if (dragMode !== "resize" || !resizeSession) return;
  renderer.updateResize(e.clientX, e.clientY, resizeSession);
  updateSelectionOverlay();
});

resizeHandleBr.addEventListener("pointerup", (e) => {
  if (dragMode === "resize") {
    dragMode = null;
    resizeSession = null;
    try {
      resizeHandleBr.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    scheduleAutoSave();
  }
});

resizeHandleBr.addEventListener("lostpointercapture", () => {
  if (dragMode === "resize") {
    dragMode = null;
    resizeSession = null;
  }
});

flipHBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!drawingEnabled || currentTool !== "select") return;
  renderer.toggleFlipHorizontal();
  updateSelectionOverlay();
  scheduleAutoSave();
});

flipVBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!drawingEnabled || currentTool !== "select") return;
  renderer.toggleFlipVertical();
  updateSelectionOverlay();
  scheduleAutoSave();
});

flipHBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
flipVBtn.addEventListener("pointerdown", (e) => e.stopPropagation());

rotateHandle.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (!drawingEnabled || currentTool !== "select") return;
  if (!renderer.getSelectedId()) return;
  e.stopPropagation();
  rotateSession = renderer.beginRotate(e.clientX, e.clientY);
  if (!rotateSession) return;
  dragMode = "rotate";
  rotateHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

rotateHandle.addEventListener("pointermove", (e) => {
  if (dragMode !== "rotate" || !rotateSession) return;
  renderer.updateRotate(e.clientX, e.clientY, rotateSession);
  updateSelectionOverlay();
});

rotateHandle.addEventListener("pointerup", (e) => {
  if (dragMode === "rotate") {
    dragMode = null;
    rotateSession = null;
    try {
      rotateHandle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    scheduleAutoSave();
  }
});

rotateHandle.addEventListener("lostpointercapture", () => {
  if (dragMode === "rotate") {
    dragMode = null;
    rotateSession = null;
  }
});

rotateHandle.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!drawingEnabled || currentTool !== "select") return;
  if (!renderer.getSelectedId()) return;
  renderer.resetRotation();
  updateSelectionOverlay();
  scheduleAutoSave();
});

svgEl.addEventListener("lostpointercapture", (e) => {
  if (dragMode === "move") {
    dragMode = null;
    return;
  }
  if (isDrawing && e.pointerId === drawingPointerId) {
    endDrawingStrokeFromPointer(e);
  }
});

svgEl.addEventListener("pointerdown", (e) => {
  if (!drawingEnabled) return;
  if (e.button !== 0) return;

  if (currentTool === "select") {
    const item = e.target.closest && e.target.closest(".draw-item");
    const id =
      item && svgEl.contains(item) ? item.getAttribute("data-id") : null;
    renderer.setSelectedId(id);
    updateSelectionOverlay();
    if (id) {
      dragMode = "move";
      lastPointer = { x: e.clientX, y: e.clientY };
      svgEl.setPointerCapture(e.pointerId);
    } else {
      dragMode = null;
    }
    e.preventDefault();
    return;
  }

  isDrawing = true;
  drawingPointerId = e.pointerId;
  svgEl.setPointerCapture(e.pointerId);
  attachDrawingStrokeListeners();
  const point = getPoint(e);

  if (currentTool === "pen" || currentTool === "eraser") {
    renderer.beginStroke(
      point,
      currentColor,
      currentSize,
      currentTool === "eraser",
    );
  } else {
    renderer.beginShape(currentTool, point, currentColor, currentSize);
  }
});

svgEl.addEventListener("pointermove", (e) => {
  if (dragMode === "rotate") return;
  if (dragMode === "move" && currentTool === "select") {
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    renderer.translateSelected(dx, dy);
    updateSelectionOverlay();
    return;
  }
});

svgEl.addEventListener("pointerup", (e) => {
  if (dragMode === "rotate") return;
  if (dragMode === "move") {
    dragMode = null;
    try {
      svgEl.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    scheduleAutoSave();
    return;
  }
  if (isDrawing && e.pointerId === drawingPointerId) {
    endDrawingStrokeFromPointer(e);
  }
});

document.querySelectorAll(".toolbar-btn[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

const swatches = document.querySelectorAll(".color-swatch");
swatches.forEach((swatch) => {
  swatch.addEventListener("click", () => {
    swatches.forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    currentColor = swatch.dataset.color;
    updateDrawingCursor();
    void persistUiPrefs();
  });
});

const sizeSlider = document.getElementById("size-slider");
const sizeDisplay = document.getElementById("size-display");

sizeSlider.addEventListener("input", () => {
  currentSize = parseInt(sizeSlider.value, 10);
  sizeDisplay.textContent = String(currentSize);
  updateDrawingCursor();
  void persistUiPrefs();
});

document.getElementById("btn-undo").addEventListener("click", () => {
  renderer.undo();
  updateSelectionOverlay();
  scheduleAutoSave();
});

document.getElementById("btn-redo").addEventListener("click", () => {
  renderer.redo();
  updateSelectionOverlay();
  scheduleAutoSave();
});

document.getElementById("btn-clear").addEventListener("click", () => {
  renderer.clear({ undoable: true });
  updateSelectionOverlay();
  scheduleAutoSave();
});

document.getElementById("btn-save").addEventListener("click", () => {
  void saveCanvas();
});

document.getElementById("btn-panel").addEventListener("click", () => {
  canvasPanel.classList.toggle("hidden");
});

document.getElementById("btn-new-canvas").addEventListener("click", () => {
  void newBlankCanvas();
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;

  if (primaryModDown(e) && e.key === "s") {
    e.preventDefault();
    void saveCanvas();
    return;
  }

  if (primaryModDown(e) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    renderer.redo();
    updateSelectionOverlay();
    scheduleAutoSave();
    return;
  }

  if (primaryModDown(e) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) {
      renderer.redo();
    } else {
      renderer.undo();
    }
    updateSelectionOverlay();
    scheduleAutoSave();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    canvasPanel.classList.toggle("hidden");
    return;
  }

  if (e.shiftKey && e.key === "L") {
    e.preventDefault();
    setTool("arrow");
    return;
  }

  if (e.key === "l" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    setTool("line");
    return;
  }

  if (e.shiftKey && e.key === "R") {
    e.preventDefault();
    setTool("rectFilled");
    return;
  }

  if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    setTool("rect");
    return;
  }

  if (e.shiftKey && e.key === "O") {
    e.preventDefault();
    setTool("circleFilled");
    return;
  }

  if (e.key === "o" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    setTool("circle");
    return;
  }

  if (e.key === "p" && !e.ctrlKey && !e.metaKey) {
    setTool("pen");
    return;
  }

  if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
    setTool("eraser");
    return;
  }

  if (e.key === "v" && !e.ctrlKey && !e.metaKey) {
    setTool("select");
    return;
  }

  if (e.key === "Escape") {
    if (currentTool === "select" && renderer.getSelectedId()) {
      renderer.setSelectedId(null);
      updateSelectionOverlay();
    }
    return;
  }

  if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
    renderer.clear({ undoable: true });
    updateSelectionOverlay();
    scheduleAutoSave();
    return;
  }

  if (e.key === "t" && !e.ctrlKey && !e.metaKey) {
    toolbar.classList.toggle("hidden");
    return;
  }

  const colorKeys = ["1", "2", "3", "4", "5", "6"];
  const idx = colorKeys.indexOf(e.key);
  if (idx !== -1) {
    swatches.forEach((s) => s.classList.remove("active"));
    swatches[idx].classList.add("active");
    currentColor = swatches[idx].dataset.color;
    updateDrawingCursor();
    void persistUiPrefs();
    return;
  }

  if (e.key === "[") {
    currentSize = Math.max(1, currentSize - 1);
    sizeSlider.value = String(currentSize);
    sizeDisplay.textContent = String(currentSize);
    updateDrawingCursor();
    void persistUiPrefs();
    return;
  }
  if (e.key === "]") {
    currentSize = Math.min(20, currentSize + 1);
    sizeSlider.value = String(currentSize);
    sizeDisplay.textContent = String(currentSize);
    updateDrawingCursor();
    void persistUiPrefs();
  }
});

function applyBackground() {
  const appEl = document.getElementById("app");
  const linux = document.documentElement.classList.contains("platform-linux");
  switch (currentBackground) {
    case "blackboard":
      appEl.style.background = "#1e1e1e";
      break;
    case "whiteboard":
      appEl.style.background = "#ffffff";
      break;
    default:
      // Linux: faint alpha only while drawing — keeps the buffer fully transparent in passthrough
      // so click-through (setIgnoreMouseEvents) works; same for compositor hit regions.
      if (linux && drawingEnabled) {
        appEl.style.background = "rgba(0, 0, 0, 0.015)";
      } else {
        appEl.style.background = "transparent";
      }
      break;
  }
}

function setBackground(mode) {
  if (currentBackground === mode) {
    currentBackground = "transparent";
  } else {
    currentBackground = mode;
  }
  applyBackground();
  scheduleAutoSave();

  if (currentBackground !== "transparent") {
    showStatus(
      `${currentBackground.charAt(0).toUpperCase() + currentBackground.slice(1)} mode`,
      1500,
    );
  }
}

function applyOverlayUi() {
  const el = renderer.getElement();
  el.style.pointerEvents = drawingEnabled ? "auto" : "none";
  toolbar.style.pointerEvents = drawingEnabled ? "auto" : "none";
  toolbar.style.opacity = drawingEnabled ? "1" : "0.3";
  canvasPanel.style.pointerEvents = drawingEnabled ? "auto" : "none";
  canvasPanel.style.opacity = drawingEnabled ? "1" : "0.3";

  const appEl = document.getElementById("app");
  if (appVisible) {
    appEl.style.visibility = "visible";
  } else {
    appEl.style.visibility = "hidden";
  }

  status.textContent = drawingEnabled
    ? "Drawing ON"
    : "Passthrough — annotations visible, clicks go through";
  status.style.opacity = "1";
  setTimeout(() => {
    status.style.opacity = drawingEnabled ? "0.5" : "0";
  }, 1500);

  renderer.setHitLayerPointerEvents(drawingEnabled);
  applyBackground();

  forceRefreshDrawingCursor(false);
}

async function persistUiPrefs() {
  if (!notato) return;
  const state = await notato.loadState();
  state.ui = {
    current_color: currentColor,
    current_size: currentSize,
    current_tool: currentTool,
    toolbar_position: uiLayout.toolbar,
    canvas_panel_position: uiLayout.canvasPanel,
  };
  await notato.saveState(state);
}

async function bootstrap() {
  if (!notato) {
    console.error("notato preload API missing");
    return;
  }

  const mac = document.documentElement.classList.contains("platform-darwin");
  document.getElementById("btn-undo").title = mac ? "Undo (⌘Z)" : "Undo (Ctrl+Z)";
  document.getElementById("btn-redo").title = mac
    ? "Redo (⌘⇧Z or Ctrl+Y)"
    : "Redo (Ctrl+Y or Ctrl+Shift+Z)";
  document.getElementById("btn-save").title = mac ? "Save (⌘S)" : "Save (Ctrl+S)";

  notato.onOverlayState((s) => {
    drawingEnabled = s.drawingEnabled;
    appVisible = s.overlayVisible;
    applyOverlayUi();
  });

  notato.onRefreshCursor((hard) => {
    if (isDrawing) return;
    forceRefreshDrawingCursor(hard);
  });

  notato.onShortcutAction((action) => {
    if (action === "clearCanvas") {
      renderer.clear({ undoable: true });
      updateSelectionOverlay();
      scheduleAutoSave();
      return;
    }
    if (action === "setBackgroundBlackboard") {
      setBackground("blackboard");
      return;
    }
    if (action === "setBackgroundWhiteboard") {
      setBackground("whiteboard");
    }
  });

  let state = await notato.loadState();
  const index = state.index || [];
  if (index.length === 0) {
    await ensureDefaultCanvas();
    state = await notato.loadState();
  } else {
    const aid = state.active_canvas_id;
    const valid =
      aid && index.some((c) => c.id === aid) ? aid : index[0].id;
    if (valid !== aid) {
      state.active_canvas_id = valid;
      await notato.saveState(state);
    }
    activeCanvasId = valid;
  }

  if (state.ui) {
    if (state.ui.current_color) {
      currentColor = state.ui.current_color;
      swatches.forEach((s) => {
        s.classList.toggle("active", s.dataset.color === currentColor);
      });
    }
    if (typeof state.ui.current_size === "number") {
      currentSize = state.ui.current_size;
      sizeSlider.value = String(currentSize);
      sizeDisplay.textContent = String(currentSize);
    }
    if (state.ui.current_tool) {
      currentTool = state.ui.current_tool;
      setTool(currentTool);
    }
    const tp = state.ui.toolbar_position;
    if (
      tp &&
      typeof tp.left === "number" &&
      typeof tp.top === "number" &&
      Number.isFinite(tp.left) &&
      Number.isFinite(tp.top)
    ) {
      uiLayout.toolbar = { left: tp.left, top: tp.top };
    }
    const cp = state.ui.canvas_panel_position;
    if (
      cp &&
      typeof cp.left === "number" &&
      typeof cp.top === "number" &&
      Number.isFinite(cp.left) &&
      Number.isFinite(cp.top)
    ) {
      uiLayout.canvasPanel = { left: cp.left, top: cp.top };
    }
  }

  const initial = await notato.getOverlayState();
  drawingEnabled = initial.drawingEnabled;
  appVisible = initial.overlayVisible;
  applyOverlayUi();

  if (activeCanvasId) {
    try {
      const data = await notato.loadCanvas(activeCanvasId);
      renderer.setState(data.document || data);
      currentBackground = data.background || "transparent";
      applyBackground();
    } catch {
      activeCanvasId = null;
    }
  }

  renderPanel();

  applyToolbarPosition();
  applyCanvasPanelPosition();
  setupMovablePanels();

  updateDrawingCursor();
  updateSelectionOverlay();

  status.innerHTML = mac
    ? "Press <b>⌘⇧A</b> to toggle drawing | <b>Tab</b> for canvases"
    : "Press <b>Ctrl+Shift+A</b> to toggle drawing | <b>Tab</b> for canvases";
  setTimeout(() => {
    status.style.opacity = "0.5";
  }, 3000);
}

void bootstrap();
