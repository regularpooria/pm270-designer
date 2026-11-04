"use strict";

/* ------------------------------------------------------------------ setup */
const DPI = 203;
const DOTS_PER_MM = 8;   // PM270 firmware's nominal 203 dpi = 8 dots/mm
const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _uid = 0;
const uid = () => `o${++_uid}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const els = {
  editor: $("editor"),
  stage: $("stage"),
  props: $("props"),
  layers: $("layers"),
  sizeReadout: $("sizeReadout"),
  connState: $("connState"),
  connect: $("connect"),
  disconnect: $("disconnect"),
  print: $("print"),
  undo: $("undo"),
  redo: $("redo"),
  imageFile: $("imageFile"),
  wsHint: $("wsHint"),
};

const state = {
  widthDots: 384,
  widthMm: 54,
  lengthMm: 50,
  lengthDots: 400,
  marginMm: 0,
  density: 15,
  dither: false,
  repeat: 1,
  gapMm: 2,
  objects: [],
  selectedId: null,
  history: [],
  future: [],
  replaceImageId: null,
  transport: null,
};

/* ------------------------------------------------------------- utilities */
let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function byId(id) { return state.objects.find((o) => o.id === id) || null; }
function selected() { return byId(state.selectedId); }
function fontString(o) {
  return `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${o.fontSize || 24}px ${o.fontFamily || "sans-serif"}`;
}
function layerName(o) {
  if (o.type === "text") return (o.text || "").replace(/\s+/g, " ").slice(0, 28) || "Text";
  if (o.type === "barcode") return o.value || "Barcode";
  if (o.type === "qr") return o.value || "QR";
  if (o.type === "image") return "Image";
  if (o.type === "rect") return "Box";
  return "Line";
}

/* ------------------------------------------------------------ object model */
function contentBottom() {
  let b = 0;
  for (const o of state.objects) {
    const r = bbox(o);
    b = Math.max(b, r.y + r.h);
  }
  return b;
}

function defaults(type) {
  const w = state.widthDots;
  const y = contentBottom() + 12;
  switch (type) {
    case "text":
      return { id: uid(), type, x: 16, y, w: w - 32, h: 40, minH: 0,
               text: "Your text", fontSize: 32, bold: false, italic: false,
               align: "left", fontFamily: "sans-serif", color: "#000000" };
    case "rect":
      return { id: uid(), type, x: 32, y, w: 160, h: 90,
               stroke: "#000000", fill: "transparent", strokeWidth: 2 };
    case "line":
      return { id: uid(), type, x: 16, y: y + 16, w: w - 32, h: 0,
               stroke: "#000000", strokeWidth: 2 };
    case "barcode":
      return { id: uid(), type, x: 16, y, w: w - 32, h: 90,
               value: "123456789012", format: "CODE128", showText: true };
    case "qr":
      return { id: uid(), type, x: Math.round((w - 160) / 2), y,
               w: 160, h: 160, value: "https://nelko.com", ecc: "M" };
    case "image":
      return { id: uid(), type, x: 16, y, w: 160, h: 160, src: "", img: null };
    default:
      return null;
  }
}

function bbox(o) {
  if (o.type === "line") {
    const x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2),
             w: Math.abs(o.w), h: Math.abs(o.h) };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function layoutText(o) {
  const ctx = measureCtx || (measureCtx = document.createElement("canvas").getContext("2d"));
  ctx.save();
  ctx.font = fontString(o);
  const lines = [];
  for (const para of String(o.text || "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (!line || ctx.measureText(test).width <= Math.max(8, o.w)) line = test;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  o._lines = lines.length ? lines : [""];
  o.h = Math.max(o.minH || 0, o._lines.length * (o.fontSize || 24) * 1.25 + 4);
  ctx.restore();
}
let measureCtx = null;
function layoutAll() {
  for (const o of state.objects) if (o.type === "text") layoutText(o);
}

/* ------------------------------------------------------------------ render */
function computeLengthDots(designDots) {
  const gapDots = Math.round(state.gapMm * DOTS_PER_MM);
  const marginDots = Math.round(state.marginMm * DOTS_PER_MM);
  const copies = Math.max(1, Math.floor(state.repeat || 1));
  const needed = copies * designDots + (copies - 1) * gapDots + marginDots;
  // Round up to a whole millimetre (8 dots) so SIZE is an integer mm and the
  // bitmap height always matches the firmware's 8 dots/mm conversion.
  // 13 mm is the firmware minimum; below it the printer burns a bar.
  const floor = 104;
  const rounded = Math.ceil(needed / DOTS_PER_MM) * DOTS_PER_MM;
  return Math.max(floor, rounded);
}
function dotsToMm(dots) {
  // Floor to 4 decimals so the printer's ceil/round conversion cannot land on
  // the next dot row, which would make it eat the trailing PRINT bytes.
  return dots / DOTS_PER_MM;
}

function render() {
  layoutAll();
  const designDots = Math.max(1, Math.ceil(contentBottom()));
  const gapDots = Math.round(state.gapMm * DOTS_PER_MM);
  const copies = Math.max(1, Math.floor(state.repeat || 1));
  state.lengthDots = computeLengthDots(designDots);
  state.lengthMm = dotsToMm(state.lengthDots);
  const h = state.lengthDots;
  const c = els.editor;
  if (c.width !== state.widthDots || c.height !== h) {
    c.width = state.widthDots;
    c.height = h;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  drawGuides(ctx);
  for (let i = 0; i < copies; i++) {
    ctx.save();
    ctx.translate(0, i * (designDots + gapDots));
    for (const o of state.objects) drawObject(ctx, o);
    ctx.restore();
  }
  drawSelection(ctx);
  updateReadout();
  renderLayers();
  syncInspector();
}

function drawGuides(ctx) {
  const w = els.editor.width, h = els.editor.height;
  ctx.save();
  ctx.strokeStyle = "#eef2f7";
  ctx.lineWidth = 1;
  for (let mm = 10; mm < state.lengthMm; mm += 10) {
    const y = Math.round(mm * DOTS_PER_MM) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const marginPx = Math.round(state.marginMm * DOTS_PER_MM);
  const y = h - marginPx + 0.5;
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "#f0a0a0";
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#d07070";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText("bottom margin", 6, Math.max(12, y - 4));
  ctx.restore();
}

function drawObject(ctx, o) {
  ctx.save();
  if (o.type === "text") {
    layoutText(o);
    ctx.font = fontString(o);
    ctx.fillStyle = o.color || "#000000";
    ctx.textBaseline = "top";
    const align = o.align || "left";
    ctx.textAlign = align;
    const x = align === "center" ? o.x + o.w / 2 : align === "right" ? o.x + o.w : o.x;
    const lh = (o.fontSize || 24) * 1.25;
    (o._lines || []).forEach((line, i) => ctx.fillText(line, x, o.y + 2 + i * lh));
  } else if (o.type === "rect") {
    if (o.fill && o.fill !== "transparent") {
      ctx.fillStyle = o.fill;
      ctx.fillRect(o.x, o.y, o.w, o.h);
    }
    if (o.stroke && o.stroke !== "transparent") {
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.strokeWidth || 1;
      ctx.strokeRect(o.x + 0.5, o.y + 0.5, Math.max(1, o.w - 1), Math.max(1, o.h - 1));
    }
  } else if (o.type === "line") {
    ctx.strokeStyle = o.stroke || "#000000";
    ctx.lineWidth = o.strokeWidth || 1;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(o.x + o.w, o.y + o.h);
    ctx.stroke();
  } else if (o.type === "image") {
    if (o.img && o.img.complete && o.img.naturalWidth) {
      ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
    } else {
      ctx.strokeStyle = "#bbbbbb";
      ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    }
  } else if (o.type === "barcode") {
    const c = barcodeCanvas(o);
    if (c) ctx.drawImage(c, o.x, o.y, o.w, o.h);
  } else if (o.type === "qr") {
    drawQR(ctx, o);
  }
  ctx.restore();
}

function barcodeCanvas(o) {
  if (typeof JsBarcode !== "function") return null;
  const key = [o.value, o.format, Math.round(o.w), Math.round(o.h), o.showText].join("|");
  if (o._barcodeKey === key && o._barcodeCanvas) return o._barcodeCanvas;
  try {
    const c = document.createElement("canvas");
    JsBarcode(c, String(o.value || "0"), {
      format: o.format || "CODE128",
      width: 2,
      height: Math.max(24, Math.round(o.h * 0.65)),
      displayValue: !!o.showText,
      fontSize: 16,
      margin: 0,
      background: "#ffffff",
      lineColor: "#000000",
    });
    o._barcodeKey = key;
    o._barcodeCanvas = c;
    return c;
  } catch (e) {
    o._barcodeKey = key;
    o._barcodeCanvas = null;
    return null;
  }
}

function drawQR(ctx, o) {
  if (typeof qrcode !== "function") return;
  const key = [o.value, o.ecc, Math.round(o.w), Math.round(o.h)].join("|");
  let qr = o._qr;
  if (o._qrKey !== key || !qr) {
    try {
      qr = qrcode(0, o.ecc || "M");
      qr.addData(String(o.value || " "));
      qr.make();
      o._qr = qr;
      o._qrKey = key;
    } catch (e) {
      qr = null;
    }
  }
  if (!qr) return;
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const size = Math.min(o.w, o.h);
  const scale = size / total;
  const ox = o.x + (o.w - size) / 2;
  const oy = o.y + (o.h - size) / 2;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(o.x, o.y, o.w, o.h);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(Math.floor(ox + (c + quiet) * scale),
                     Math.floor(oy + (r + quiet) * scale),
                     Math.ceil(scale), Math.ceil(scale));
      }
    }
  }
}

/* --------------------------------------------------------------- selection */
const HS = 10;
function handlePositions(o) {
  if (o.type === "line") {
    return [
      { name: "p1", x: o.x, y: o.y },
      { name: "p2", x: o.x + o.w, y: o.y + o.h },
    ];
  }
  const r = bbox(o), mx = r.x + r.w / 2, my = r.y + r.h / 2;
  return [
    { name: "nw", x: r.x, y: r.y },
    { name: "n", x: mx, y: r.y },
    { name: "ne", x: r.x + r.w, y: r.y },
    { name: "e", x: r.x + r.w, y: my },
    { name: "se", x: r.x + r.w, y: r.y + r.h },
    { name: "s", x: mx, y: r.y + r.h },
    { name: "sw", x: r.x, y: r.y + r.h },
    { name: "w", x: r.x, y: my },
  ];
}

function drawSelection(ctx) {
  const o = selected();
  if (!o) return;
  const r = bbox(o);
  ctx.save();
  ctx.strokeStyle = "#4da3ff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  ctx.setLineDash([]);
  for (const h of handlePositions(o)) {
    ctx.fillStyle = "#4da3ff";
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.rect(h.x - HS / 2, h.y - HS / 2, HS, HS);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function handleAt(x, y, o) {
  for (const h of handlePositions(o)) {
    if (Math.abs(x - h.x) <= HS && Math.abs(y - h.y) <= HS) return h.name;
  }
  return null;
}

function hitTest(x, y) {
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    if (o.type === "line") {
      if (distToSegment(x, y, o.x, o.y, o.x + o.w, o.y + o.h) <= 7 + (o.strokeWidth || 1)) return o;
    } else {
      const r = bbox(o);
      if (x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y - 3 && y <= r.y + r.h + 3) return o;
    }
  }
  return null;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* --------------------------------------------------------------- pointers */
let drag = null;
function toCanvas(ev) {
  const r = els.editor.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) * els.editor.width / r.width,
    y: (ev.clientY - r.top) * els.editor.height / r.height,
  };
}

els.editor.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  const p = toCanvas(ev);
  const sel = selected();
  if (sel) {
    const h = handleAt(p.x, p.y, sel);
    if (h) {
      drag = { mode: "resize", id: sel.id, handle: h, start: p, orig: { ...sel } };
      els.editor.setPointerCapture(ev.pointerId);
      return;
    }
  }
  const hit = hitTest(p.x, p.y);
  if (hit) {
    select(hit.id);
    drag = { mode: "move", id: hit.id, start: p, orig: { x: hit.x, y: hit.y } };
    els.editor.setPointerCapture(ev.pointerId);
  } else {
    select(null);
  }
});

els.editor.addEventListener("pointermove", (ev) => {
  if (!drag) {
    const p = toCanvas(ev);
    const sel = selected();
    if (sel && handleAt(p.x, p.y, sel)) els.editor.style.cursor = "nwse-resize";
    else els.editor.style.cursor = hitTest(p.x, p.y) ? "move" : "default";
    return;
  }
  const p = toCanvas(ev);
  const o = byId(drag.id);
  if (!o) return;
  const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
  if (drag.mode === "move") {
    o.x = Math.round(drag.orig.x + dx);
    o.y = Math.round(drag.orig.y + dy);
  } else {
    resizeObject(o, drag.handle, drag.orig, dx, dy);
  }
  render();
});

function endDrag(ev) {
  if (!drag) return;
  drag = null;
  els.editor.style.cursor = "default";
  try { els.editor.releasePointerCapture(ev.pointerId); } catch {}
  commit();
}
els.editor.addEventListener("pointerup", endDrag);
els.editor.addEventListener("pointercancel", endDrag);

function resizeObject(o, handle, start, dx, dy) {
  if (o.type === "line") {
    let x = start.x, y = start.y, w = start.w, h = start.h;
    if (handle === "p1") { x += dx; y += dy; w -= dx; h -= dy; }
    else { w += dx; h += dy; }
    o.x = Math.round(x); o.y = Math.round(y); o.w = Math.round(w); o.h = Math.round(h);
    return;
  }
  let x = start.x, y = start.y, w = start.w, h = start.h;
  if (handle.includes("w")) { x += dx; w -= dx; }
  if (handle.includes("e")) { w += dx; }
  if (handle.includes("n")) { y += dy; h -= dy; }
  if (handle.includes("s")) { h += dy; }
  const min = o.type === "qr" ? 40 : 12;
  if (w < min) { if (handle.includes("w")) x = start.x + start.w - min; w = min; }
  if (h < min) { if (handle.includes("n")) y = start.y + start.h - min; h = min; }
  o.x = Math.round(x); o.y = Math.round(y);
  o.w = Math.round(w); o.h = Math.round(h);
  if (o.type === "qr") { const s = Math.max(o.w, o.h); o.w = s; o.h = s; }
  if (o.type === "text") o.minH = o.h;
}

/* --------------------------------------------------------------- inspector */
function select(id) {
  state.selectedId = id;
  renderInspector(true);
  render();
}

function renderInspector(force) {
  const o = selected();
  if (!o) {
    els.props.innerHTML = '<div class="empty">Select an object on the canvas.</div>';
    return;
  }
  if (!force && els.props.dataset.id === o.id) { syncInspector(); return; }
  els.props.dataset.id = o.id;
  const rows = [];
  const num = (prop, label, min, max, step = 1) =>
    `<div class="field"><label>${label}</label><input type="number" data-prop="${prop}" value="${o[prop]}" min="${min}" max="${max}" step="${step}"></div>`;
  rows.push(`<div class="field"><label>Type</label><input value="${o.type}" disabled></div>`);
  rows.push(num("x", "X (dots)", -2000, 4000));
  rows.push(num("y", "Y (dots)", -2000, 20000));
  if (o.type !== "line") {
    rows.push(num("w", "Width (dots)", 8, 2000));
    rows.push(num("h", o.type === "text" ? "Min height (dots)" : "Height (dots)", 8, 20000));
  }

  if (o.type === "text") {
    rows.push(`<div class="field"><label>Text</label><textarea data-prop="text">${esc(o.text)}</textarea></div>`);
    rows.push(num("fontSize", "Font size", 6, 200));
    rows.push(`<div class="field"><label>Font</label><select data-prop="fontFamily">
      ${["sans-serif", "serif", "monospace", "system-ui", "Arial", "Georgia", "Courier New"].map(f => `<option ${o.fontFamily === f ? "selected" : ""}>${f}</option>`).join("")}
    </select></div>`);
    rows.push(`<div class="field"><label>Align</label><select data-prop="align">
      ${["left", "center", "right"].map(a => `<option ${o.align === a ? "selected" : ""}>${a}</option>`).join("")}
    </select></div>`);
    rows.push(`<div class="field row"><label>Bold</label><input type="checkbox" data-prop="bold" ${o.bold ? "checked" : ""}></div>`);
    rows.push(`<div class="field row"><label>Italic</label><input type="checkbox" data-prop="italic" ${o.italic ? "checked" : ""}></div>`);
    rows.push(`<div class="field"><label>Colour</label><input type="color" data-prop="color" value="${o.color || "#000000"}"></div>`);
  } else if (o.type === "rect") {
    rows.push(num("strokeWidth", "Stroke width", 1, 40));
    rows.push(`<div class="field"><label>Fill</label><select data-prop="fill">
      <option value="transparent" ${o.fill === "transparent" ? "selected" : ""}>transparent</option>
      <option value="#000000" ${o.fill === "#000000" ? "selected" : ""}>black</option>
      <option value="#ffffff" ${o.fill === "#ffffff" ? "selected" : ""}>white</option>
    </select></div>`);
  } else if (o.type === "line") {
    rows.push(num("strokeWidth", "Thickness", 1, 40));
  } else if (o.type === "barcode") {
    rows.push(`<div class="field"><label>Value</label><input type="text" data-prop="value" value="${esc(o.value)}"></div>`);
    rows.push(`<div class="field"><label>Format</label><select data-prop="format">
      ${["CODE128", "CODE39", "EAN13", "UPC", "ITF14"].map(f => `<option ${o.format === f ? "selected" : ""}>${f}</option>`).join("")}
    </select></div>`);
    rows.push(`<div class="field row"><label>Show text</label><input type="checkbox" data-prop="showText" ${o.showText ? "checked" : ""}></div>`);
  } else if (o.type === "qr") {
    rows.push(`<div class="field"><label>Value</label><textarea data-prop="value">${esc(o.value)}</textarea></div>`);
    rows.push(`<div class="field"><label>Error correction</label><select data-prop="ecc">
      ${["L", "M", "Q", "H"].map(e => `<option ${o.ecc === e ? "selected" : ""}>${e}</option>`).join("")}
    </select></div>`);
  } else if (o.type === "image") {
    rows.push(`<button data-act="replace-image">Replace image…</button>`);
  }

  rows.push(`<div class="btnRow">
    <button data-act="duplicate">Duplicate</button>
    <button data-act="forward">Forward</button>
    <button data-act="back">Back</button>
    <button data-act="delete" class="danger">Delete</button>
  </div>`);
  els.props.innerHTML = rows.join("");

  els.props.querySelectorAll("[data-prop]").forEach((el) => {
    el.addEventListener("input", () => { applyProp(el); render(); });
    el.addEventListener("change", () => { applyProp(el); commit(); render(); });
  });
  els.props.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => doAction(btn.dataset.act));
  });
  syncInspector();
}

function applyProp(el) {
  const o = selected();
  if (!o) return;
  const p = el.dataset.prop;
  if (el.type === "checkbox") o[p] = el.checked;
  else if (el.type === "number") o[p] = Number(el.value);
  else o[p] = el.value;
  if (o.type === "text" && p === "h") o.minH = Number(el.value) || 0;
  if (p === "value" || p === "format") { o._barcodeKey = null; o._qrKey = null; }
}

function syncInspector() {
  const o = selected();
  if (!o) return;
  els.props.querySelectorAll("[data-prop]").forEach((el) => {
    if (document.activeElement === el) return;
    const v = o[el.dataset.prop];
    if (el.type === "checkbox") el.checked = !!v;
    else if (v !== undefined) el.value = v;
  });
}

function doAction(act) {
  const o = selected();
  if (!o) return;
  if (act === "duplicate") {
    const copy = JSON.parse(JSON.stringify({ ...o, _lines: undefined, _barcodeCanvas: undefined, _qr: undefined }));
    copy.id = uid();
    copy.x += 10; copy.y += 10;
    if (o.type === "image" && o.img) copy.img = o.img;
    state.objects.push(copy);
    state.selectedId = copy.id;
    commit(); renderInspector(true); render();
  } else if (act === "forward" || act === "back") {
    const i = state.objects.findIndex((x) => x.id === o.id);
    const j = act === "forward" ? i + 1 : i - 1;
    if (j >= 0 && j < state.objects.length) {
      [state.objects[i], state.objects[j]] = [state.objects[j], state.objects[i]];
      commit(); render();
    }
  } else if (act === "delete") {
    state.objects = state.objects.filter((x) => x.id !== o.id);
    state.selectedId = null;
    commit(); renderInspector(true); render();
  } else if (act === "replace-image") {
    state.replaceImageId = o.id;
    els.imageFile.click();
  }
}

/* ------------------------------------------------------------------ layers */
function renderLayers() {
  els.layers.innerHTML = "";
  for (const o of state.objects.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "layer" + (o.id === state.selectedId ? " sel" : "");
    row.innerHTML = `<span class="ltype">${o.type}</span><span class="lname">${esc(layerName(o))}</span>
      <span class="lbtns">
        <button data-act="forward" title="Forward">↑</button>
        <button data-act="back" title="Back">↓</button>
        <button data-act="delete" title="Delete">✕</button>
      </span>`;
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      select(o.id);
    });
    row.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        select(o.id);
        doAction(b.dataset.act);
      });
    });
    els.layers.appendChild(row);
  }
}

/* ------------------------------------------------------------- add objects */
function addType(type) {
  if (type === "image") {
    state.replaceImageId = null;
    els.imageFile.click();
    return;
  }
  const o = defaults(type);
  if (!o) return;
  state.objects.push(o);
  state.selectedId = o.id;
  commit();
  renderInspector(true);
  render();
  setTimeout(() => { els.stage.scrollTop = els.stage.scrollHeight; }, 0);
}

els.imageFile.addEventListener("change", () => {
  const file = els.imageFile.files && els.imageFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      if (state.replaceImageId) {
        const o = byId(state.replaceImageId);
        if (o) { o.src = reader.result; o.img = img; }
        state.replaceImageId = null;
      } else {
        const maxW = state.widthDots - 32, maxH = 240;
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const o = defaults("image");
        o.src = reader.result;
        o.img = img;
        o.w = Math.max(8, Math.round(img.width * scale));
        o.h = Math.max(8, Math.round(img.height * scale));
        o.x = Math.round((state.widthDots - o.w) / 2);
        state.objects.push(o);
        state.selectedId = o.id;
      }
      commit();
      renderInspector(true);
      render();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  els.imageFile.value = "";
});

/* -------------------------------------------------------------- undo/redo */
function serialize() {
  return JSON.stringify({
    v: 1,
    widthMm: state.widthMm,
    widthDots: state.widthDots,
    marginMm: state.marginMm,
    density: state.density,
    dither: state.dither,
    repeat: state.repeat,
    gapMm: state.gapMm,
    objects: state.objects.map((o) => {
      const c = { ...o };
      delete c._lines;
      delete c._barcodeCanvas;
      delete c._barcodeKey;
      delete c._qr;
      delete c._qrKey;
      delete c.img;
      return c;
    }),
  });
}

function commit() {
  const snap = serialize();
  if (state.history.length && state.history[state.history.length - 1] === snap) return;
  state.history.push(snap);
  if (state.history.length > 60) state.history.shift();
  state.future = [];
  updateUndoButtons();
}

function restore(json, addHistory = false) {
  const d = JSON.parse(json);
  state.widthMm = d.widthMm ?? 54;
  state.widthDots = clamp(Math.round((d.widthDots ?? 384) / 8) * 8, 8, 384);
  state.marginMm = d.marginMm ?? 0;
  state.density = d.density ?? 15;
  state.dither = !!d.dither;
  state.repeat = d.repeat ?? 1;
  state.gapMm = d.gapMm ?? 2;
  state.objects = (d.objects || []).map((o) => ({ ...o }));
  state.selectedId = null;
  $("widthMm").value = state.widthMm;
  $("headDots").value = state.widthDots;
  $("marginMm").value = state.marginMm;
  $("density").value = state.density;
  $("dither").checked = state.dither;
  $("repeat").value = state.repeat;
  $("gapMm").value = state.gapMm;

  let pending = 0;
  for (const o of state.objects) {
    if (o.type === "image" && o.src) {
      pending++;
      const img = new Image();
      img.onload = () => { o.img = img; if (--pending === 0) render(); };
      img.onerror = () => { if (--pending === 0) render(); };
      img.src = o.src;
    }
  }
  if (!pending) render();
  renderInspector(true);
  updateUndoButtons();
  if (addHistory) commit();
}

function undo() {
  if (state.history.length < 2) return;
  state.future.push(state.history.pop());
  restore(state.history[state.history.length - 1]);
}
function redo() {
  if (!state.future.length) return;
  const snap = state.future.pop();
  state.history.push(snap);
  restore(snap);
}
function updateUndoButtons() {
  els.undo.disabled = state.history.length < 2;
  els.redo.disabled = !state.future.length;
}

/* --------------------------------------------------------------- templates */
function saveTemplate() {
  const name = prompt("Template name:");
  if (!name) return;
  const all = JSON.parse(localStorage.getItem("pm270.templates") || "{}");
  all[name] = serialize();
  localStorage.setItem("pm270.templates", JSON.stringify(all));
  toast(`Saved “${name}”`);
}
function loadTemplate() {
  const all = JSON.parse(localStorage.getItem("pm270.templates") || "{}");
  const names = Object.keys(all);
  if (!names.length) return toast("No saved templates");
  const name = prompt("Load which template?\n\n" + names.join("\n"));
  if (!name || !all[name]) return;
  restore(all[name], true);
  toast(`Loaded “${name}”`);
}

/* ------------------------------------------------------------- readout/UI */
function updateReadout() {
  const designMm = contentBottom() / DOTS_PER_MM;
  const copies = Math.max(1, Math.floor(state.repeat || 1));
  const mode = state.lengthDots <= 424 ? "exact mode 8 / 4bpp" : "classic 1bpp";
  els.sizeReadout.innerHTML =
    `<b>${state.widthMm} × ${state.lengthMm.toFixed(2)} mm</b> · ${state.lengthDots} dots<br>` +
    `design ${designMm.toFixed(1)} mm × ${copies} · gap ${state.gapMm} mm · extra ${state.marginMm} mm<br>` +
    `<span style="color:#3fb950">${mode} · one job · ${state.lengthMm.toFixed(2)} mm.</span>`;
  $("undo").disabled = state.history.length < 2;
  $("redo").disabled = !state.future.length;
}

function setConnected(on, info) {
  const canConnect = SerialTransport.available() && window.isSecureContext;
  els.connect.disabled = on || !canConnect;
  els.disconnect.disabled = !on;
  els.print.disabled = !on;
  els.connState.classList.toggle("on", on);
  if (!on) {
    els.connState.textContent = "not connected";
  } else {
    const id = info && (info.bluetoothServiceClassId || info.usbVendorId);
    els.connState.textContent = id ? `connected · ${id}` : "connected";
  }
}

/* ------------------------------------------------------------- Web Serial */
class SerialTransport {
  constructor() {
    this.port = null;
    this.reader = null;
    this.buffer = new Uint8Array(0);
    this.pending = null;
    this.queryLock = Promise.resolve();
  }

  static available() {
    return typeof navigator !== "undefined" && !!navigator.serial;
  }

  async connect({ allPorts = false } = {}) {
    if (!SerialTransport.available()) {
      throw new Error("Web Serial is not available. Use Chrome/Edge 117+ or Chrome Android 138+.");
    }
    if (!window.isSecureContext) {
      throw new Error("Web Serial needs HTTPS or localhost. Open this page from localhost or an HTTPS host.");
    }
    const opts = allPorts
      ? {}
      : {
          allowedBluetoothServiceClassIds: [SPP_UUID],
          filters: [{ bluetoothServiceClassId: SPP_UUID }],
        };
    this.port = await navigator.serial.requestPort(opts);
    await this.port.open({ baudRate: 9600 });
    this.info = this.port.getInfo ? this.port.getInfo() : {};
    this._readLoop();
    return this.info;
  }

  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this._append(value);
      }
    } catch (e) {
      /* closed */
    } finally {
      try { this.reader && this.reader.releaseLock(); } catch {}
      this.reader = null;
    }
  }

  _append(value) {
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
    if (this.buffer.length > 65536) this.buffer = this.buffer.slice(-32768);
    if (this.pending) this._tryResolve();
  }

  _tryResolve() {
    const p = this.pending;
    if (!p) return;
    if (p.mode === "line") {
      const i = this.buffer.indexOf(0x0a);
      if (i >= 0) {
        const out = this.buffer.slice(0, i + 1);
        this.buffer = this.buffer.slice(i + 1);
        this._finish(out);
      }
    } else if (this.buffer.length >= p.len) {
      const out = this.buffer.slice(0, p.len);
      this.buffer = this.buffer.slice(p.len);
      this._finish(out);
    }
  }

  _finish(out, clear = false) {
    const p = this.pending;
    this.pending = null;
    if (p && p.timer) clearTimeout(p.timer);
    if (clear) this.buffer = new Uint8Array(0);
    if (p) p.resolve(out);
  }

  async query(bytes, { mode = "line", len = 0, timeout = 1000 } = {}) {
    const run = async () => {
      this.buffer = new Uint8Array(0);
      const p = new Promise((resolve) => {
        this.pending = {
          resolve, mode, len,
          timer: setTimeout(() => this._finish(this.buffer.slice(), true), timeout),
        };
      });
      await this.write(bytes);
      return p;
    };
    const next = this.queryLock.then(run, run);
    this.queryLock = next.catch(() => {});
    return next;
  }

  async write(bytes, { chunk = 512, delay = 5 } = {}) {
    if (!this.port || !this.port.writable) throw new Error("Serial port is not writable");
    const writer = this.port.writable.getWriter();
    try {
      for (let off = 0; off < bytes.length; off += chunk) {
        await writer.write(bytes.slice(off, off + chunk));
        if (delay) await sleep(delay);
      }
    } finally {
      try { writer.releaseLock(); } catch {}
    }
  }

  async print(job, lengthMm) {
    await this.write(job, { chunk: 512, delay: 5 });
    await sleep(Math.max(5, lengthMm / 20 + 2) * 1000);
  }

  async status() {
    const d = await this.query(new Uint8Array([0x1b, 0x21, 0x3f]), { mode: "bytes", len: 1, timeout: 800 });
    return d.length ? d[0] : -1;
  }
  async battery() {
    return this.query(new TextEncoder().encode("BATTERY?\r\n"), { timeout: 800 });
  }
  async config() {
    return this.query(new TextEncoder().encode("CONFIG?\r\n"), { timeout: 800 });
  }
  async tag() {
    return this.query(new Uint8Array([0x1b, 0x21, 0x6f]), { mode: "bytes", len: 16, timeout: 800 });
  }

  async disconnect() {
    try { this.reader && await this.reader.cancel(); } catch {}
    try { this.port && await this.port.close(); } catch {}
    this.port = null;
    this.reader = null;
    this.buffer = new Uint8Array(0);
    this.pending = null;
  }
}

async function connectPrinter({ allPorts = false } = {}) {
  try {
    const t = new SerialTransport();
    const info = await t.connect({ allPorts });
    state.transport = t;
    setConnected(true, info);
    toast("Printer connected");
  } catch (e) {
    if (e && e.name === "NotFoundError") {
      toast("No matching SPP port. Pair PM270 in OS Bluetooth first, or use “Show all ports”.", 5000);
    } else {
      toast(e.message || String(e), 5000);
    }
    setConnected(false);
  }
}

async function disconnectPrinter() {
  if (state.transport) await state.transport.disconnect();
  state.transport = null;
  setConnected(false);
}

/* --------------------------------------------------------------- printing */
function renderPrintCanvas() {
  layoutAll();
  const designDots = Math.max(1, Math.ceil(contentBottom()));
  const gapDots = Math.round(state.gapMm * DOTS_PER_MM);
  const copies = Math.max(1, Math.floor(state.repeat || 1));
  const h = computeLengthDots(designDots);
  state.lengthDots = h;
  state.lengthMm = dotsToMm(h);
  const c = document.createElement("canvas");
  c.width = state.widthDots;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < copies; i++) {
    ctx.save();
    ctx.translate(0, i * (designDots + gapDots));
    for (const o of state.objects) drawObject(ctx, o);
    ctx.restore();
  }
  return c;
}

function canvasGray(canvas) {
  const { data, width, height } = canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }

  if (state.dither) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const old = gray[i];
        const nv = old < 128 ? 0 : 255;
        const err = old - nv;
        gray[i] = nv;
        const add = (xx, yy, k) => {
          if (xx >= 0 && xx < width && yy >= 0 && yy < height) gray[yy * width + xx] += err * k;
        };
        add(x + 1, y, 7 / 16);
        add(x - 1, y + 1, 3 / 16);
        add(x, y + 1, 5 / 16);
        add(x + 1, y + 1, 1 / 16);
      }
    }
  }
  return { gray, width, height };
}

function packCanvas(canvas) {
  const { gray, width, height } = canvasGray(canvas);
  const wbytes = Math.ceil(width / 8);
  const raw = new Uint8Array(wbytes * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      const white = v >= 128;
      if (white) raw[y * wbytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  // The printer can burn the bottom edge during feed-out; keep it white.
  raw.fill(0xff, Math.max(0, height - 2) * wbytes);
  return { raw, wbytes, h: height };
}

// Nelko app short-label format: BITMAP mode 8 = 4 bpp, two dots per byte,
// left dot in the high nibble. 0x0 is black, 0xF is white. This is what the
// iOS app sends, and it is what lets a <50 mm SIZE print exactly once.
function packCanvas4(canvas) {
  const { gray, width, height } = canvasGray(canvas);
  const wbytes = Math.ceil(width / 8);
  const raw = new Uint8Array(wbytes * height * 4);
  const nib = (v) => Math.max(0, Math.min(15, Math.round(v * 15 / 255)));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 2) {
      const hi = nib(gray[y * width + x]);
      const lo = x + 1 < width ? nib(gray[y * width + x + 1]) : 15;
      raw[y * wbytes * 4 + (x >> 1)] = (hi << 4) | lo;
    }
  }
  // The printer can burn the bottom edge during feed-out; keep it white.
  raw.fill(0xff, Math.max(0, height - 2) * wbytes * 4);
  return { raw, wbytes, h: height };
}

function buildExactJob(canvas) {
  const enc = new TextEncoder();
  const { raw, wbytes, h } = packCanvas4(canvas);
  const head = enc.encode(
    `SIZE ${state.widthMm} mm,${h / 8} mm\r\n` +
    `GAP 0,0\r\n` +
    `DIRECTION 0,0\r\n` +
    `DENSITY ${state.density}\r\n` +
    `CLS\r\n` +
    `PRINT 1,1\r\n` +
    `BITMAP 0,0,${wbytes},${h},8,`
  );
  const tail = enc.encode(`\r\n`);
  const out = new Uint8Array(head.length + raw.length + tail.length);
  out.set(head, 0);
  out.set(raw, head.length);
  out.set(tail, head.length + raw.length);
  return out;
}

function buildClassicJob(canvas) {
  const enc = new TextEncoder();
  const { raw, wbytes, h } = packCanvas(canvas);
  const head = enc.encode(
    `\r\nSIZE ${state.widthMm} mm,${state.lengthMm.toFixed(4)} mm\r\n` +
    `GAP 0 mm,0 mm\r\n` +
    `DIRECTION 0,0\r\n` +
    `DENSITY ${state.density}\r\n` +
    `CLS\r\n` +
    `BITMAP 0,0,${wbytes},${h},0,`
  );
  const tail = enc.encode(`\r\nPRINT 1,1\r\n`);
  const out = new Uint8Array(head.length + raw.length + tail.length);
  out.set(head, 0);
  out.set(raw, head.length);
  out.set(tail, head.length + raw.length);
  return out;
}

// The app's captured 52 mm mode-8 job works, but the original 1 bpp path is
// what printed long labels reliably. Use exact mode 8 up to 53 mm (424 dots)
// and fall back to the classic 1 bpp job above that. No length cap, no split.
const EXACT_MAX_ROWS = 424;

function buildJob(canvas) {
  return canvas.height <= EXACT_MAX_ROWS ? buildExactJob(canvas) : buildClassicJob(canvas);
}

async function printLabel() {
  if (!state.transport) return toast("Connect the printer first");
  render();
  if (state.widthDots > 384) {
    return toast("The print head is 384 dots (48 mm). Reduce “Head dots”.", 5000);
  }
  const canvas = renderPrintCanvas();
  const job = buildJob(canvas);
  els.print.disabled = true;
  toast("Printing…", 60000);
  try {
    await state.transport.print(job, canvas.height / 8);
    toast("Printed");
  } catch (e) {
    toast("Print failed: " + (e.message || e), 5000);
  } finally {
    els.print.disabled = false;
  }
}

function showPreview() {
  render();
  const c = renderPrintCanvas();
  const pv = $("previewCanvas");
  pv.width = c.width;
  pv.height = c.height;
  pv.getContext("2d").drawImage(c, 0, 0);
  const copies = Math.max(1, Math.floor(state.repeat || 1));
  const job = buildJob(c);
  const raw = new TextDecoder("ascii").decode(job.slice(0, 240));
  const bitmapAt = raw.indexOf("BITMAP");
  const head = bitmapAt >= 0 ? raw.slice(0, bitmapAt + 24) : raw;
  const path = c.height <= EXACT_MAX_ROWS ? "exact mode 8 / 4bpp" : "classic 1bpp / mode 0";
  $("previewInfo").textContent =
    `${c.width}×${c.height} dots · SIZE ${state.widthMm} × ${state.lengthMm.toFixed(2)} mm · ` +
    `${copies} cop${copies === 1 ? "y" : "ies"}\n` +
    `path: ${path} · ${job.length} bytes\n` +
    head.replace(/[^\x20-\x7e\r\n]/g, "·");
  $("previewModal").classList.remove("hidden");
}

/* ------------------------------------------------------------------ wiring */
document.querySelectorAll("[data-add]").forEach((b) => {
  b.addEventListener("click", () => addType(b.dataset.add));
});

$("widthMm").addEventListener("change", (e) => {
  state.widthMm = clamp(Number(e.target.value) || 54, 10, 54);
  e.target.value = state.widthMm;
  commit(); render();
});
$("headDots").addEventListener("change", (e) => {
  state.widthDots = clamp(Math.round((Number(e.target.value) || 384) / 8) * 8, 8, 384);
  e.target.value = state.widthDots;
  commit(); render();
});
$("marginMm").addEventListener("change", (e) => {
  state.marginMm = clamp(Number(e.target.value) || 0, 0, 80);
  e.target.value = state.marginMm;
  commit(); render();
});
$("density").addEventListener("change", (e) => {
  state.density = clamp(Number(e.target.value) || 15, 1, 15);
  e.target.value = state.density;
  commit();
});
$("dither").addEventListener("change", (e) => {
  state.dither = e.target.checked;
  commit();
});
$("repeat").addEventListener("change", (e) => {
  state.repeat = clamp(Math.floor(Number(e.target.value) || 1), 1, 50);
  e.target.value = state.repeat;
  commit(); render();
});
$("gapMm").addEventListener("change", (e) => {
  state.gapMm = clamp(Number(e.target.value) || 0, 0, 50);
  e.target.value = state.gapMm;
  commit(); render();
});
$("fit50").addEventListener("click", fit50);

function fit50() {
  layoutAll();
  const designMm = Math.max(0.1, contentBottom() / DOTS_PER_MM);
  const gap = state.gapMm;
  const n = Math.max(1, Math.min(50, Math.floor(50 / (designMm + gap))));
  state.repeat = n;
  $("repeat").value = n;
  commit();
  render();
  toast(`${n} cop${n === 1 ? "y" : "ies"} in a 50 mm strip`);
}

els.connect.addEventListener("click", () => connectPrinter());
els.disconnect.addEventListener("click", disconnectPrinter);
els.print.addEventListener("click", printLabel);
$("previewBtn").addEventListener("click", showPreview);
$("closePreview").addEventListener("click", () => $("previewModal").classList.add("hidden"));
$("previewModal").addEventListener("click", (e) => {
  if (e.target === $("previewModal")) $("previewModal").classList.add("hidden");
});
els.undo.addEventListener("click", undo);
els.redo.addEventListener("click", redo);
$("showAll").addEventListener("click", () => connectPrinter({ allPorts: true }));

$("clear").addEventListener("click", () => {
  if (!state.objects.length || confirm("Clear the canvas?")) {
    state.objects = [];
    state.selectedId = null;
    commit(); renderInspector(true); render();
  }
});
$("saveTpl").addEventListener("click", saveTemplate);
$("loadTpl").addEventListener("click", loadTemplate);

document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault(); doAction("duplicate");
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selectedId) { e.preventDefault(); doAction("delete"); }
  } else if (e.key === "Escape") {
    select(null);
  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    const o = selected();
    if (!o) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") o.x -= step;
    if (e.key === "ArrowRight") o.x += step;
    if (e.key === "ArrowUp") o.y -= step;
    if (e.key === "ArrowDown") o.y += step;
    render();
  }
});
document.addEventListener("keyup", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  if (state.selectedId) commit();
});

/* --------------------------------------------------------------------- init */
(function init() {
  if (!SerialTransport.available()) {
    els.wsHint.className = "hint err";
    els.wsHint.textContent = "Web Serial is not available. Use Chrome/Edge 117+ desktop or Chrome Android 138+. Safari/Firefox are not supported.";
    els.connect.disabled = true;
  } else if (!window.isSecureContext) {
    els.wsHint.className = "hint err";
    els.wsHint.textContent = "This page is not a secure context. Open it via https:// or http://localhost. LAN HTTP addresses cannot use Web Serial.";
  } else {
    els.wsHint.className = "hint";
    els.wsHint.textContent = "Ready. Pair the PM270 in OS Bluetooth first, then click Connect.";
  }

  const t = defaults("text");
  t.text = "PM270";
  t.fontSize = 44;
  t.bold = true;
  t.y = 20;
  state.objects.push(t);
  state.selectedId = t.id;
  state.history = [serialize()];
  renderInspector(true);
  render();
  setConnected(false);

  if (navigator.serial) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (state.transport && e.target === state.transport.port) {
        state.transport = null;
        setConnected(false);
        toast("Printer disconnected");
      }
    });
  }

  // Debug/test hook.
  window.__pm270 = { state, addType, render, buildJob, buildExactJob, renderPrintCanvas, serialize, restore, select, showPreview };
})();
