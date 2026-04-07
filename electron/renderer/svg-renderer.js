// SVG vector renderer — strokes/shapes as DOM; eraser removes items when the pointer hits painted ink (not selection bounds).

const NS = "http://www.w3.org/2000/svg";

function newId() {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function ensureItemMeta(obj) {
  if (!obj.id) obj.id = newId();
  if (!obj.transform) {
    obj.transform = { tx: 0, ty: 0, s: 1, r: 0, flipX: false, flipY: false };
  } else {
    if (obj.transform.tx === undefined) obj.transform.tx = 0;
    if (obj.transform.ty === undefined) obj.transform.ty = 0;
    if (obj.transform.s === undefined) obj.transform.s = 1;
    if (obj.transform.r === undefined) obj.transform.r = 0;
    if (obj.transform.flipX === undefined) obj.transform.flipX = false;
    if (obj.transform.flipY === undefined) obj.transform.flipY = false;
  }
}

/** Quadratic path through points (same curve structure as canvas), single stroke width. */
function buildStrokePathD(points, size) {
  if (points.length < 2) return "";
  const w = size * 0.5;
  let d = `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    d += ` L ${points[1].x} ${points[1].y}`;
    return d;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    d += ` Q ${p1.x} ${p1.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function bboxCenterFromPoints(points) {
  if (points.length === 0) return { cx: 0, cy: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function bboxCenterShape(shape) {
  const { start, end, type } = shape;
  if (type === "line" || type === "arrow") {
    return { cx: (start.x + end.x) / 2, cy: (start.y + end.y) / 2 };
  }
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  return { cx: x + w / 2, cy: y + h / 2 };
}

function transformAttr(t, cx, cy) {
  const { tx, ty, s, r = 0, flipX = false, flipY = false } = t;
  const sx = s * (flipX ? -1 : 1);
  const sy = s * (flipY ? -1 : 1);
  return `translate(${tx} ${ty}) translate(${cx} ${cy}) rotate(${r}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`;
}

function eraserPad(size) {
  return Math.max(6, size * 0.6);
}

/** Client-space samples for a tap / click (no drag). */
function eraserSamplePointsPoint(p, size) {
  const pad = eraserPad(size);
  const pts = [{ x: p.x, y: p.y }];
  const rings = [0.35, 0.65, 0.95];
  for (const r of rings) {
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      pts.push({ x: p.x + Math.cos(ang) * pad * r, y: p.y + Math.sin(ang) * pad * r });
    }
  }
  return pts;
}

/** Client-space samples along a drag segment and across eraser width. */
function eraserSamplePointsSegment(p0, p1, size) {
  const pad = eraserPad(size);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) {
    return eraserSamplePointsPoint(p0, size);
  }
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const step = Math.max(2.5, pad / 5);
  const nSteps = Math.max(1, Math.ceil(len / step));
  const points = [];
  for (let i = 0; i <= nSteps; i++) {
    const t = i / nSteps;
    const cx = p0.x + t * dx;
    const cy = p0.y + t * dy;
    points.push({ x: cx, y: cy });
    points.push({ x: cx + px * pad * 0.5, y: cy + py * pad * 0.5 });
    points.push({ x: cx - px * pad * 0.5, y: cy - py * pad * 0.5 });
  }
  return points;
}

/** True if (clientX, clientY) hits the element's fill or stroke in screen space. */
function svgGeometryHitAtClient(el, clientX, clientY) {
  if (typeof SVGGeometryElement === "undefined" || !(el instanceof SVGGeometryElement)) {
    return false;
  }
  const svg = el.ownerSVGElement;
  if (!svg || !el.getScreenCTM) return false;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  let ctm;
  try {
    ctm = el.getScreenCTM();
  } catch {
    return false;
  }
  if (!ctm) return false;
  let local;
  try {
    local = pt.matrixTransform(ctm.inverse());
  } catch {
    return false;
  }
  try {
    const fill = el.getAttribute && el.getAttribute("fill");
    if (fill && fill !== "none" && el.isPointInFill && el.isPointInFill(local)) {
      return true;
    }
    if (el.isPointInStroke && el.isPointInStroke(local)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Drop legacy bitmap-eraser strokes from saved files while keeping order. */
function sanitizeLoadedDocument(strokes, shapes, history) {
  const newStrokes = [];
  const newShapes = [];
  const newHistory = [];
  let si = 0;
  let shi = 0;
  for (const h of history) {
    if (h === "stroke" && si < strokes.length) {
      const s = strokes[si++];
      if (s.eraser) continue;
      newStrokes.push(s);
      newHistory.push("stroke");
    } else if (h === "shape" && shi < shapes.length) {
      const sh = shapes[shi++];
      newShapes.push(sh);
      newHistory.push("shape");
    }
  }
  return { strokes: newStrokes, shapes: newShapes, history: newHistory };
}

function deepClone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

export class SvgRenderer {
  constructor(container) {
    this.container = container;
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "notato-svg");
    this.svg.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;overflow:visible;";
    this.layer = document.createElementNS(NS, "g");
    this.layer.setAttribute("class", "notato-layer");
    this.layer.setAttribute("style", "isolation:isolate");
    this.preview = document.createElementNS(NS, "g");
    this.preview.setAttribute("class", "notato-preview");
    this.svg.appendChild(this.layer);
    this.svg.appendChild(this.preview);
    container.prepend(this.svg);

    this.strokes = [];
    this.shapes = [];
    this.history = [];
    /** @type {Array<{ kind: 'append'; type: 'stroke' | 'shape' } | { kind: 'eraser'; snapshot: { strokes: unknown[]; shapes: unknown[]; history: string[]; selectedId: string | null } }>} */
    this.undoStack = [];
    /** @type {Array<{ kind: 'redo_append'; type: 'stroke' | 'shape'; item: unknown } | { kind: 'redo_eraser'; snapshot: { strokes: unknown[]; shapes: unknown[]; history: string[]; selectedId: string | null } }>} */
    this.redoStack = [];
    this.currentStroke = null;
    this.currentShape = null;
    this.selectedId = null;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.redraw();
  }

  getElement() {
    return this.svg;
  }

  setSelectedId(id) {
    this.selectedId = id || null;
    this.layer.querySelectorAll(".draw-item").forEach((el) => {
      el.classList.toggle("is-selected", el.getAttribute("data-id") === this.selectedId);
    });
  }

  getSelectedId() {
    return this.selectedId;
  }

  _snapshotDocument() {
    return {
      strokes: deepClone(this.strokes),
      shapes: deepClone(this.shapes),
      history: deepClone(this.history),
      selectedId: this.selectedId,
    };
  }

  /** For transform bar UI (flip button pressed state). */
  getSelectedTransform() {
    if (!this.selectedId) return null;
    const found = this.findItem(this.selectedId);
    if (!found) return null;
    ensureItemMeta(found.obj);
    const t = found.obj.transform;
    return { flipX: !!t.flipX, flipY: !!t.flipY };
  }

  findItem(id) {
    for (const s of this.strokes) {
      if (s.id === id) return { kind: "stroke", obj: s };
    }
    for (const sh of this.shapes) {
      if (sh.id === id) return { kind: "shape", obj: sh };
    }
    return null;
  }

  hitTest(clientX, clientY) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const g = el.closest && el.closest(".draw-item");
      if (g && this.svg.contains(g)) {
        return g.getAttribute("data-id");
      }
    }
    return null;
  }

  getItemClientRect(id) {
    const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const g = this.layer.querySelector(`.draw-item[data-id="${safe}"]`);
    if (!g) return null;
    return g.getBoundingClientRect();
  }

  translateSelected(dx, dy) {
    if (!this.selectedId) return;
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.tx += dx;
    found.obj.transform.ty += dy;
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  /** @returns {{ cx: number; cy: number; d0: number; s0: number } | null} */
  beginResize(clientX, clientY) {
    if (!this.selectedId) return null;
    const r = this.getItemClientRect(this.selectedId);
    if (!r || r.width < 1 || r.height < 1) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d0 = Math.hypot(clientX - cx, clientY - cy);
    if (d0 < 1e-6) return null;
    const found = this.findItem(this.selectedId);
    if (!found) return null;
    ensureItemMeta(found.obj);
    return { cx, cy, d0, s0: found.obj.transform.s };
  }

  updateResize(clientX, clientY, session) {
    if (!this.selectedId || !session) return;
    const d = Math.hypot(clientX - session.cx, clientY - session.cy);
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.s = Math.max(0.05, Math.min(40, session.s0 * (d / session.d0)));
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  /** @returns {{ cx: number; cy: number; angle0: number; r0: number } | null} */
  beginRotate(clientX, clientY) {
    if (!this.selectedId) return null;
    const r = this.getItemClientRect(this.selectedId);
    if (!r || r.width < 1 || r.height < 1) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const found = this.findItem(this.selectedId);
    if (!found) return null;
    ensureItemMeta(found.obj);
    const angle0 = Math.atan2(clientY - cy, clientX - cx);
    const r0 = found.obj.transform.r ?? 0;
    return { cx, cy, angle0, r0 };
  }

  /** @param {{ cx: number; cy: number; angle0: number; r0: number }} session */
  updateRotate(clientX, clientY, session) {
    if (!this.selectedId || !session) return;
    const angle1 = Math.atan2(clientY - session.cy, clientX - session.cx);
    let delta = angle1 - session.angle0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const deltaDeg = (delta * 180) / Math.PI;
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.r = session.r0 + deltaDeg;
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  resetRotation() {
    if (!this.selectedId) return;
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.r = 0;
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  toggleFlipHorizontal() {
    if (!this.selectedId) return;
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.flipX = !found.obj.transform.flipX;
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  toggleFlipVertical() {
    if (!this.selectedId) return;
    const found = this.findItem(this.selectedId);
    if (!found) return;
    ensureItemMeta(found.obj);
    found.obj.transform.flipY = !found.obj.transform.flipY;
    this.redraw();
    this.setSelectedId(this.selectedId);
  }

  beginStroke(point, color, size, eraser = false) {
    this.currentStroke = { points: [point], color, size, eraser };
    this.preview.innerHTML = "";
    if (eraser) {
      this._eraserUndoCommitted = false;
    }
  }

  addPoint(point) {
    if (!this.currentStroke) return;
    this.currentStroke.points.push(point);
    const pts = this.currentStroke.points;
    if (this.currentStroke.eraser) {
      if (pts.length >= 2) {
        const p0 = pts[pts.length - 2];
        const p1 = pts[pts.length - 1];
        const samples = eraserSamplePointsSegment(p0, p1, this.currentStroke.size);
        this._eraserApplyRemovalFromInkSamples(samples);
      }
      return;
    }
    const d = buildStrokePathD(pts, this.currentStroke.size);
    const w = this.currentStroke.size * 0.5;
    let path = this.preview.querySelector("path");
    if (!path) {
      path = document.createElementNS(NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      this.preview.appendChild(path);
    }
    path.setAttribute("d", d);
    path.setAttribute("stroke", this.currentStroke.color);
    path.setAttribute("stroke-width", String(w * 2));
    path.removeAttribute("style");
    path.removeAttribute("stroke-dasharray");
  }

  /** Collect `.draw-item` ids whose painted geometry is hit by any sample point (client pixels). */
  _collectIdsHitByInkSamples(samplePoints) {
    const ids = new Set();
    for (const g of this.layer.querySelectorAll(".draw-item")) {
      const id = g.getAttribute("data-id");
      if (!id) continue;
      const geoms = g.querySelectorAll("path, line, rect, ellipse, circle, polyline, polygon");
      outer: for (const el of geoms) {
        for (const sp of samplePoints) {
          if (svgGeometryHitAtClient(el, sp.x, sp.y)) {
            ids.add(id);
            break outer;
          }
        }
      }
    }
    return ids;
  }

  /** Remove items hit by ink sampling; first removal in a gesture records undo. */
  _eraserApplyRemovalFromInkSamples(samplePoints) {
    const ids = this._collectIdsHitByInkSamples(samplePoints);
    if (ids.size === 0) return;
    if (!this._eraserUndoCommitted) {
      this.undoStack.push({ kind: "eraser", snapshot: this._snapshotDocument() });
      this._eraserUndoCommitted = true;
      this.redoStack = [];
    }
    this.rebuildWithoutIds(ids);
  }

  rebuildWithoutIds(ids) {
    const newStrokes = [];
    const newShapes = [];
    const newHistory = [];
    let si = 0;
    let shi = 0;
    for (const h of this.history) {
      if (h === "stroke" && si < this.strokes.length) {
        const s = this.strokes[si++];
        if (ids.has(s.id)) continue;
        newStrokes.push(s);
        newHistory.push("stroke");
      } else if (h === "shape" && shi < this.shapes.length) {
        const sh = this.shapes[shi++];
        if (ids.has(sh.id)) continue;
        newShapes.push(sh);
        newHistory.push("shape");
      }
    }
    this.strokes = newStrokes;
    this.shapes = newShapes;
    this.history = newHistory;
    if (this.selectedId && ids.has(this.selectedId)) {
      this.selectedId = null;
    }
    this.redraw();
  }

  endStroke() {
    if (!this.currentStroke) return;
    const cs = this.currentStroke;
    this.currentStroke = null;
    this.preview.innerHTML = "";
    if (cs.eraser) {
      if (cs.points.length === 1) {
        this._eraserApplyRemovalFromInkSamples(eraserSamplePointsPoint(cs.points[0], cs.size));
      }
      return;
    }
    if (cs.points.length > 0) {
      ensureItemMeta(cs);
      this.strokes.push(cs);
      this.history.push("stroke");
      this.undoStack.push({ kind: "append", type: "stroke" });
      this.redoStack = [];
    }
    this.redraw();
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.kind === "eraser") {
      this.redoStack.push({ kind: "redo_eraser", snapshot: this._snapshotDocument() });
      const snap = op.snapshot;
      this.strokes = deepClone(snap.strokes);
      this.shapes = deepClone(snap.shapes);
      this.history = deepClone(snap.history);
      this.selectedId = snap.selectedId ?? null;
      for (const s of this.strokes) {
        ensureItemMeta(s);
      }
      for (const sh of this.shapes) {
        ensureItemMeta(sh);
      }
      this.redraw();
      return;
    }
    const last = this.history[this.history.length - 1];
    if (op.type === "stroke" && last === "stroke") {
      this.history.pop();
      const item = this.strokes.pop();
      this.redoStack.push({ kind: "redo_append", type: "stroke", item: deepClone(item) });
    } else if (op.type === "shape" && last === "shape") {
      this.history.pop();
      const item = this.shapes.pop();
      this.redoStack.push({ kind: "redo_append", type: "shape", item: deepClone(item) });
    } else {
      this.undoStack.push(op);
      return;
    }
    this.selectedId = null;
    this.redraw();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    if (op.kind === "redo_eraser") {
      const undoSnap = this._snapshotDocument();
      const snap = op.snapshot;
      this.strokes = deepClone(snap.strokes);
      this.shapes = deepClone(snap.shapes);
      this.history = deepClone(snap.history);
      this.selectedId = snap.selectedId ?? null;
      for (const s of this.strokes) {
        ensureItemMeta(s);
      }
      for (const sh of this.shapes) {
        ensureItemMeta(sh);
      }
      this.undoStack.push({ kind: "eraser", snapshot: undoSnap });
      this.redraw();
      return;
    }
    if (op.kind === "redo_append") {
      if (op.type === "stroke") {
        this.strokes.push(deepClone(op.item));
        this.history.push("stroke");
        this.undoStack.push({ kind: "append", type: "stroke" });
      } else {
        this.shapes.push(deepClone(op.item));
        this.history.push("shape");
        this.undoStack.push({ kind: "append", type: "shape" });
      }
      this.selectedId = null;
      this.redraw();
    }
  }

  clear() {
    this.strokes = [];
    this.shapes = [];
    this.history = [];
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.preview.innerHTML = "";
    this.redraw();
  }

  beginShape(type, point, color, size) {
    this.currentShape = { type, start: point, end: point, color, size };
    this.preview.innerHTML = "";
  }

  updateShape(point) {
    if (!this.currentShape) return;
    this.currentShape.end = point;
    this.preview.innerHTML = "";
    ensureItemMeta(this.currentShape);
    this._renderShapeToGroup(this.preview, this.currentShape, true);
  }

  endShape() {
    if (!this.currentShape) return;
    const dx = this.currentShape.end.x - this.currentShape.start.x;
    const dy = this.currentShape.end.y - this.currentShape.start.y;
    if (Math.sqrt(dx * dx + dy * dy) > 3) {
      ensureItemMeta(this.currentShape);
      this.shapes.push(this.currentShape);
      this.history.push("shape");
      this.undoStack.push({ kind: "append", type: "shape" });
      this.redoStack = [];
    }
    this.currentShape = null;
    this.preview.innerHTML = "";
    this.redraw();
  }

  _renderShapeToGroup(parent, shape, preview) {
    const { start, end, color, size, type } = shape;
    const lineSize = size * 0.5;
    const g = document.createElementNS(NS, "g");
    if (!preview) {
      g.setAttribute("class", "draw-item");
      g.setAttribute("data-id", shape.id);
      g.setAttribute("data-kind", "shape");
      g.setAttribute("pointer-events", "visiblePainted");
      const { cx, cy } = bboxCenterShape(shape);
      ensureItemMeta(shape);
      g.setAttribute("transform", transformAttr(shape.transform, cx, cy));
    }

    if (type === "line" || type === "arrow") {
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const headLen = Math.max(lineSize * 4, 18);
      let lineEndX = end.x;
      let lineEndY = end.y;
      if (type === "arrow") {
        lineEndX = end.x - headLen * 0.7 * Math.cos(angle);
        lineEndY = end.y - headLen * 0.7 * Math.sin(angle);
      }
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(start.x));
      line.setAttribute("y1", String(start.y));
      line.setAttribute("x2", String(lineEndX));
      line.setAttribute("y2", String(lineEndY));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", String(lineSize));
      line.setAttribute("stroke-linecap", "round");
      g.appendChild(line);
      if (type === "arrow") {
        const path = document.createElementNS(NS, "path");
        const d = `M ${end.x} ${end.y} L ${end.x - headLen * Math.cos(angle - Math.PI / 7)} ${end.y - headLen * Math.sin(angle - Math.PI / 7)} L ${end.x - headLen * Math.cos(angle + Math.PI / 7)} ${end.y - headLen * Math.sin(angle + Math.PI / 7)} Z`;
        path.setAttribute("d", d);
        path.setAttribute("fill", color);
        g.appendChild(path);
      }
    } else if (type === "rect" || type === "rectFilled") {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(h));
      if (type === "rectFilled") {
        rect.setAttribute("fill", color);
      } else {
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", color);
        rect.setAttribute("stroke-width", String(lineSize));
      }
      g.appendChild(rect);
    } else if (type === "circle" || type === "circleFilled") {
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      const ell = document.createElementNS(NS, "ellipse");
      ell.setAttribute("cx", String(cx));
      ell.setAttribute("cy", String(cy));
      ell.setAttribute("rx", String(rx));
      ell.setAttribute("ry", String(ry));
      if (type === "circleFilled") {
        ell.setAttribute("fill", color);
      } else {
        ell.setAttribute("fill", "none");
        ell.setAttribute("stroke", color);
        ell.setAttribute("stroke-width", String(lineSize));
      }
      g.appendChild(ell);
    }
    parent.appendChild(g);
  }

  _appendStroke(parent, stroke) {
    const d = buildStrokePathD(stroke.points, stroke.size);
    if (!d) return;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "draw-item");
    g.setAttribute("data-id", stroke.id);
    g.setAttribute("data-kind", "stroke");
    g.setAttribute("pointer-events", "visiblePainted");
    const { cx, cy } = bboxCenterFromPoints(stroke.points);
    ensureItemMeta(stroke);
    g.setAttribute("transform", transformAttr(stroke.transform, cx, cy));

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    const w = stroke.size * 0.5;
    if (stroke.eraser) {
      return;
    }
    path.setAttribute("stroke", stroke.color);
    path.setAttribute("stroke-width", String(w * 2));
    g.appendChild(path);
    parent.appendChild(g);
  }

  redraw() {
    this.layer.innerHTML = "";
    let si = 0;
    let shi = 0;
    for (const type of this.history) {
      if (type === "stroke" && si < this.strokes.length) {
        this._appendStroke(this.layer, this.strokes[si++]);
      } else if (type === "shape" && shi < this.shapes.length) {
        this._renderShapeToGroup(this.layer, this.shapes[shi++], false);
      }
    }
    this.setSelectedId(this.selectedId);
  }

  getState() {
    return {
      strokes: this.strokes,
      shapes: this.shapes,
      history: this.history,
    };
  }

  setState(state) {
    const clone = (v) => {
      try {
        return structuredClone(v);
      } catch {
        return JSON.parse(JSON.stringify(v));
      }
    };
    const rawStrokes = clone(state.strokes || []);
    const rawShapes = clone(state.shapes || []);
    const rawHistory = clone(state.history || []);
    const sanitized = sanitizeLoadedDocument(rawStrokes, rawShapes, rawHistory);
    this.strokes = sanitized.strokes;
    this.shapes = sanitized.shapes;
    this.history = sanitized.history;
    this.undoStack = [];
    this.redoStack = [];
    this.currentStroke = null;
    this.currentShape = null;
    this.selectedId = null;
    for (const s of this.strokes) {
      ensureItemMeta(s);
    }
    for (const sh of this.shapes) {
      ensureItemMeta(sh);
    }
    this.redraw();
  }
}
