/* dreamsheet frontend.
 *
 * A virtualized, zero-framework spreadsheet. Two modes:
 *   - Embedded: talks to the calc plugin over the postMessage bridge.
 *   - Demo (local): runs an in-memory engine backed by the same formula
 *     module (`./web/formula.js`) that the plugin uses server-side.
 */
import {
  CYCLE_ERROR,
  ERROR_ERROR,
  REF_ERROR,
  coordToLabel,
  evaluateExpression,
  isAIFormula,
  isErrorValue,
  makeRefMutator,
  makeShifts,
  parseCoord,
  parseExpression,
  parseRange,
  rangeCells,
  rewriteRefs,
  shiftCoord,
  stringifyExpression,
} from "./web/formula.js";

/* ------------------------------------------------------------------ */
/* Constants & state                                                    */
/* ------------------------------------------------------------------ */

const EMBEDDED = window.parent !== window;
const SHELL_SOURCE = "p2p-hub-shell";
const PLUGIN_SOURCE = "p2p-hub-plugin";
const BRIDGE_TIMEOUT_MS = 15000;

const ROWS = 1000;
const COLS = 100;
const ROW_HEIGHT = 24;
const COL_HEADER_H = 24;
const ROW_HEADER_W = 46;
const DEFAULT_COL_W = 92;
const MIN_COL_W = 36;
const MAX_COL_W = 420;
const OVERSCAN = 3;

const STORAGE_KEY = "dreamsheet:data:v1";

const state = {
  sheetId: null,
  cells: new Map(), // coord -> { value, formula, format, embedded }
  sel: { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } },
  editing: null, // coord string | null
  colWidths: new Map(), // col index -> px
  history: [], // array of serialized snapshots
  historyIndex: -1,
  theme: "dark",
  clipboard: null, // { mode, rows, cols, cells: Map }
  suppressCommit: false,
};

let pending = {};
let seq = 0;
let refAnchor = null; // { r, c } | null — anchor for shift+click ref extension

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function $(id) {
  return document.getElementById(id);
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 2600);
}

/* ------------------------------------------------------------------ */
/* Bridge (embedded mode)                                               */
/* ------------------------------------------------------------------ */

function callShell(method, args) {
  return new Promise((resolve, reject) => {
    const requestId = "calc-" + ++seq + "-" + Date.now();
    pending[requestId] = { resolve, reject };
    window.parent.postMessage(
      {
        source: PLUGIN_SOURCE,
        pluginId: "calc",
        requestId,
        serviceId: "calc",
        method,
        arguments: args,
      },
      "*",
    );
    setTimeout(() => {
      if (pending[requestId]) {
        delete pending[requestId];
        reject(new Error("bridge timeout"));
      }
    }, BRIDGE_TIMEOUT_MS);
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== SHELL_SOURCE || !data.requestId || !pending[data.requestId]) {
    return;
  }
  const entry = pending[data.requestId];
  delete pending[data.requestId];
  if (data.status === "ok") entry.resolve(data.result);
  else entry.reject(new Error(data.error || "bridge error"));
});

function parseSheet(doc) {
  const rootId = doc.$top.root.$ref;
  const root = doc.$objects[rootId];
  const sheetRef = root.sheets[0].$ref;
  const sheet = doc.$objects[sheetRef];
  const out = new Map();
  const sheetCells = sheet.cells || {};
  for (const coord of Object.keys(sheetCells)) {
    const cell = doc.$objects[sheetCells[coord].$ref];
    out.set(coord, {
      value: cell.value,
      formula: cell.formula,
      format: cell.format || null,
      embedded: cell.embeddedObject ? doc.$objects[cell.embeddedObject.$ref] : null,
    });
  }
  return { sheetId: sheetRef, cells: out };
}

function reloadSheet() {
  return callShell("getSheet", { sheetId: state.sheetId })
    .then(parseSheet)
    .then((sheet) => {
      state.cells = sheet.cells;
      render();
    });
}

/* ------------------------------------------------------------------ */
/* Demo engine (local, in-memory)                                       */
/* ------------------------------------------------------------------ */

function demoRecalc() {
  const memo = new Map();
  const visiting = new Set();
  const resolve = (coord) => {
    const key = coord.toUpperCase();
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return CYCLE_ERROR;
    const cell = state.cells.get(key);
    if (!cell) {
      memo.set(key, null);
      return null;
    }
    if (cell.formula) {
      let ast = null;
      try {
        ast = parseExpression(cell.formula);
      } catch {
        ast = null;
      }
      if (ast && !isAIFormula(ast)) {
        visiting.add(key);
        let v;
        try {
          v = evaluateExpression(ast, resolve);
        } catch {
          v = ERROR_ERROR;
        }
        visiting.delete(key);
        memo.set(key, v);
        return v;
      }
      memo.set(key, null);
      return null;
    }
    const v = cell.value ?? null;
    memo.set(key, v);
    return v;
  };

  for (const [key, cell] of state.cells) {
    if (!cell.formula) continue;
    let ast = null;
    try {
      ast = parseExpression(cell.formula);
    } catch {
      ast = null;
    }
    if (ast && !isAIFormula(ast)) {
      try {
        cell.value = evaluateExpression(ast, resolve);
      } catch {
        cell.value = ERROR_ERROR;
      }
    }
  }
}

function demoSetCell(coord, { value, formula, format }) {
  const key = coord.toUpperCase();
  const existing = state.cells.get(key) || { value: null, formula: null, format: null, embedded: null };
  if (formula !== undefined) existing.formula = formula;
  else if (value !== undefined) {
    existing.formula = null;
    existing.value = value;
  }
  if (format !== undefined) existing.format = format;
  state.cells.set(key, existing);
  demoRecalc();
}

function demoSetBulk(updates) {
  for (const u of updates) {
    const key = u.coord.toUpperCase();
    const existing = state.cells.get(key) || { value: null, formula: null, format: null, embedded: null };
    if (u.formula !== undefined) existing.formula = u.formula;
    else if (u.value !== undefined) {
      existing.formula = null;
      existing.value = u.value;
    }
    if (u.format !== undefined) existing.format = u.format;
    state.cells.set(key, existing);
  }
  demoRecalc();
}

function demoStructuralEdit(kind, at, count) {
  const { shiftRow, shiftCol } = makeShifts(kind, at, count);
  const mutate = makeRefMutator(shiftRow, shiftCol);
  const next = new Map();
  for (const [coord, cell] of state.cells) {
    const newCoord = shiftCoord(coord, shiftRow, shiftCol);
    if (!newCoord) continue;
    if (cell.formula) {
      let ast = null;
      try {
        ast = parseExpression(cell.formula);
      } catch {
        ast = null;
      }
      if (ast) cell.formula = "=" + stringifyExpression(rewriteRefs(ast, mutate));
    }
    next.set(newCoord, cell);
  }
  state.cells = next;
  demoRecalc();
}

/* ------------------------------------------------------------------ */
/* Value & display formatting                                           */
/* ------------------------------------------------------------------ */

function isNumeric(s) {
  return s !== "" && s !== null && !Number.isNaN(Number(s));
}

function formatNumber(value, format) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value ?? "");
  const numFmt = format?.numFmt || "general";
  const decimals = format?.decimals ?? 2;
  if (numFmt === "percent") {
    return (value * 100).toLocaleString("en-US", { maximumFractionDigits: decimals }) + "%";
  }
  if (numFmt === "number" || numFmt === "currency") {
    const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    const s = value.toLocaleString("en-US", opts);
    return numFmt === "currency" ? "$" + s : s;
  }
  return String(value);
}

function displayValue(cell) {
  if (!cell) return "";
  if (cell.embedded) return "OBJ";
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value === "number" && cell.format?.numFmt && cell.format.numFmt !== "general") {
    return formatNumber(cell.value, cell.format);
  }
  return String(cell.value);
}

function isErrorCell(cell) {
  return !!cell && typeof cell.value === "string" && isErrorValue(cell.value);
}

function currentText(cell) {
  if (!cell || cell.embedded) return "";
  return cell.formula || (cell.value == null ? "" : String(cell.value));
}

/* ------------------------------------------------------------------ */
/* Selection helpers                                                    */
/* ------------------------------------------------------------------ */

function selBox() {
  const { anchor, focus } = state.sel;
  return {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  };
}

function selCoords() {
  const b = selBox();
  const out = [];
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      out.push(coordToLabel(c, r));
    }
  }
  return out;
}

function setSelection(r, c, { extend = false } = {}) {
  if (extend) {
    state.sel.focus = { r, c };
  } else {
    state.sel.anchor = { r, c };
    state.sel.focus = { r, c };
  }
  state.editing = null;
  syncFormulaBar();
}

function anchorCoord() {
  return coordToLabel(state.sel.anchor.c, state.sel.anchor.r);
}

/* ------------------------------------------------------------------ */
/* Column geometry                                                      */
/* ------------------------------------------------------------------ */

let colOffsets = [];

function colWidth(c) {
  return state.colWidths.get(c) ?? DEFAULT_COL_W;
}

function rebuildColOffsets() {
  colOffsets = new Array(COLS + 1);
  colOffsets[0] = 0;
  for (let c = 0; c < COLS; c++) {
    colOffsets[c + 1] = colOffsets[c] + colWidth(c);
  }
}

function totalWidth() {
  return colOffsets[COLS];
}

function totalHeight() {
  return ROWS * ROW_HEIGHT;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderHeaders() {
  const colHeaders = $("col-headers");
  colHeaders.innerHTML = "";
  const strip = el("div");
  strip.style.position = "relative";
  strip.style.width = totalWidth() + "px";
  strip.style.height = COL_HEADER_H + "px";
  for (let c = 0; c < COLS; c++) {
    const h = el("div", "header-cell col");
    h.textContent = coordToLabel(c, 0).replace(/\d+$/, "");
    h.style.left = colOffsets[c] + "px";
    h.style.width = colWidth(c) + "px";
    const resizer = el("div", "col-resizer");
    resizer.dataset.col = c;
    h.appendChild(resizer);
    strip.appendChild(h);
  }
  colHeaders.appendChild(strip);

  const rowHeaders = $("row-headers");
  rowHeaders.innerHTML = "";
  const rowStrip = el("div");
  rowStrip.style.position = "relative";
  rowStrip.style.width = ROW_HEADER_W + "px";
  rowStrip.style.height = totalHeight() + "px";
  for (let r = 0; r < ROWS; r++) {
    const h = el("div", "row-header");
    h.textContent = r + 1;
    h.style.top = r * ROW_HEIGHT + "px";
    rowStrip.appendChild(h);
  }
  rowHeaders.appendChild(rowStrip);
}

function renderCells() {
  const viewport = $("viewport");
  const layer = $("cell-layer");
  layer.style.width = totalWidth() + "px";
  layer.style.height = totalHeight() + "px";

  const scrollLeft = viewport.scrollLeft;
  const scrollTop = viewport.scrollTop;
  const viewW = viewport.clientWidth;
  const viewH = viewport.clientHeight;

  // Visible column range (binary search over colOffsets).
  let c0 = 0;
  let c1 = COLS - 1;
  for (let c = 0; c < COLS; c++) {
    if (colOffsets[c + 1] > scrollLeft) {
      c0 = c;
      break;
    }
  }
  for (let c = COLS - 1; c >= 0; c--) {
    if (colOffsets[c] < scrollLeft + viewW) {
      c1 = c;
      break;
    }
  }
  c0 = Math.max(0, c0 - OVERSCAN);
  c1 = Math.min(COLS - 1, c1 + OVERSCAN);

  const r0 = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const r1 = Math.min(ROWS - 1, Math.floor((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN);

  const frag = document.createDocumentFragment();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const coord = coordToLabel(c, r);
      const cell = state.cells.get(coord);
      if (coord === state.editing) continue; // editor renders separately
      const node = el("div", "cell");
      node.dataset.coord = coord;
      node.style.left = colOffsets[c] + "px";
      node.style.top = r * ROW_HEIGHT + "px";
      node.style.width = colWidth(c) + "px";
      node.style.height = ROW_HEIGHT + "px";
      if (cell) {
        node.textContent = displayValue(cell);
        if (isErrorCell(cell)) node.classList.add("error");
        if (cell.embedded) {
          node.classList.add("embed");
          node.title = (cell.embedded.targetClass || "embedded") + " · " + (cell.embedded.targetId || "");
        }
        if (cell.format?.bold) node.classList.add("bold");
        if (cell.format?.italic) node.classList.add("italic");
        if (cell.format?.underline) node.classList.add("underline");
        if (cell.format?.align === "center") node.classList.add("align-center");
        if (cell.format?.align === "right") node.classList.add("align-right");
      }
      frag.appendChild(node);
    }
  }
  layer.innerHTML = "";
  layer.appendChild(frag);
}

function renderSelection() {
  const b = selBox();
  const selEl = $("selection");
  const left = colOffsets[b.c0];
  const top = b.r0 * ROW_HEIGHT;
  let width = 0;
  for (let c = b.c0; c <= b.c1; c++) width += colWidth(c);
  const height = (b.r1 - b.r0 + 1) * ROW_HEIGHT;
  selEl.style.left = left + "px";
  selEl.style.top = top + "px";
  selEl.style.width = width + "px";
  selEl.style.height = height + "px";

  const handle = $("fill-handle");
  handle.style.left = left + width - 4 + "px";
  handle.style.top = top + height - 4 + "px";

  // Keep selection visible on scroll.
  const viewport = $("viewport");
  $("col-headers").firstChild.style.transform = `translateX(${-viewport.scrollLeft}px)`;
  $("row-headers").firstChild.style.transform = `translateY(${-viewport.scrollTop}px)`;
}

function renderEditor() {
  const existing = document.querySelector(".cell-editor");
  if (existing) existing.remove();
  if (!state.editing) return;

  const coord = state.editing;
  const p = parseCoord(coord);
  if (!p) return;
  const cell = state.cells.get(coord);
  const input = el("input", "cell-editor");
  input.dataset.editing = "1";
  input.value = currentText(cell);
  input.style.left = colOffsets[p.col] - 1 + "px";
  input.style.top = p.row * ROW_HEIGHT - 1 + "px";
  input.style.width = colWidth(p.col) + 2 + "px";
  input.style.height = ROW_HEIGHT + 2 + "px";
  $("cell-layer").appendChild(input);

  input.addEventListener("input", () => {
    $("formula-input").value = input.value;
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  });
  input.addEventListener("blur", () => commitEdit());
  input.focus();
  input.select();
}

function render() {
  rebuildColOffsets();
  renderHeaders();
  renderCells();
  renderSelection();
  renderEditor();
  updateStatusBar();
}

function syncFormulaBar() {
  const coord = anchorCoord();
  $("name-box").textContent = coord;
  $("formula-input").value = currentText(state.cells.get(coord));
}

/* ------------------------------------------------------------------ */
/* Status bar                                                           */
/* ------------------------------------------------------------------ */

function updateStatusBar() {
  const coords = selCoords();
  const values = coords.map((c) => state.cells.get(c)?.value ?? null);
  const nums = values.filter((v) => typeof v === "number");
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== "");
  let stats = "";
  if (coords.length > 1) {
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = nums.length ? sum / nums.length : 0;
    stats = `Sum: ${sum}   Avg: ${avg}   Count: ${nums.length}`;
  }
  $("status-left").textContent = `${coords.length} cell${coords.length === 1 ? "" : "s"} selected`;
  $("status-stats").textContent = stats;
}

/* ------------------------------------------------------------------ */
/* Editing                                                              */
/* ------------------------------------------------------------------ */

function startEdit(coord, initialText) {
  if (!state.sheetId && EMBEDDED) return;
  if (state.editing === coord) return;
  if (state.editing != null) commitEdit();
  const p = parseCoord(coord);
  if (!p) return;
  setSelection(p.row, p.col);
  state.editing = coord;
  refAnchor = null;
  render();
  const input = document.querySelector(".cell-editor");
  if (input) {
    if (initialText !== undefined) {
      input.value = initialText;
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }
}

function commitEdit() {
  if (state.editing == null || state.suppressCommit) return;
  const coord = state.editing;
  const input = document.querySelector("input[data-editing]");
  const raw = input ? input.value : "";
  state.suppressCommit = true;
  state.editing = null;
  refAnchor = null;
  $("formula-input").value = raw;
  commitCell(coord, raw);
  state.suppressCommit = false;
}

function cancelEdit() {
  if (state.editing == null) return;
  state.suppressCommit = true;
  state.editing = null;
  refAnchor = null;
  render();
  state.suppressCommit = false;
}

function commitCell(coord, raw) {
  raw = (raw == null ? "" : raw).trim();
  if (!coord) return;
  snapshot();

  if (raw.charAt(0) === "=") {
    if (EMBEDDED) {
      callShell("updateCell", { sheetId: state.sheetId, coord, formula: raw })
        .then(() => {
          if (/^=AI\(/i.test(raw)) {
            return callShell("evaluateAIFormula", { sheetId: state.sheetId, coord });
          }
          return null;
        })
        .then(reloadSheet)
        .catch((err) => showToast("Update failed: " + err.message));
    } else {
      demoSetCell(coord, { formula: raw });
      render();
    }
  } else {
    const value = raw === "" ? null : isNumeric(raw) ? Number(raw) : raw;
    if (EMBEDDED) {
      callShell("updateCell", { sheetId: state.sheetId, coord, value })
        .then(reloadSheet)
        .catch((err) => showToast("Update failed: " + err.message));
    } else {
      demoSetCell(coord, { value });
      render();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Undo / redo                                                          */
/* ------------------------------------------------------------------ */

function snapshot() {
  const data = serializeCells();
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(data);
  if (state.history.length > 100) state.history.shift();
  state.historyIndex = state.history.length - 1;
  save();
}

function serializeCells() {
  const out = [];
  for (const [coord, cell] of state.cells) {
    out.push([coord, { value: cell.value, formula: cell.formula, format: cell.format, embedded: cell.embedded }]);
  }
  return out;
}

function restoreCells(serialized) {
  const map = new Map();
  for (const [coord, cell] of serialized) {
    map.set(coord, { ...cell });
  }
  state.cells = map;
  if (!EMBEDDED) demoRecalc();
  render();
  save();
}

function undo() {
  if (EMBEDDED) {
    showToast("Undo is available in local mode");
    return;
  }
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  restoreCells(state.history[state.historyIndex]);
}

function redo() {
  if (EMBEDDED) {
    showToast("Redo is available in local mode");
    return;
  }
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  restoreCells(state.history[state.historyIndex]);
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                            */
/* ------------------------------------------------------------------ */

function selectionTSV() {
  const b = selBox();
  const lines = [];
  for (let r = b.r0; r <= b.r1; r++) {
    const row = [];
    for (let c = b.c0; c <= b.c1; c++) {
      const cell = state.cells.get(coordToLabel(c, r));
      row.push(cell ? currentText(cell) : "");
    }
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

function copySelection() {
  const b = selBox();
  const copied = new Map();
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const coord = coordToLabel(c, r);
      const cell = state.cells.get(coord);
      if (cell) copied.set(coord, { ...cell });
    }
  }
  state.clipboard = { mode: "copy", r0: b.r0, c0: b.c0, cells: copied };
  const tsv = selectionTSV();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(tsv).catch(() => {});
  }
}

function cutSelection() {
  copySelection();
  state.clipboard.mode = "cut";
  clearSelection();
}

function shiftFormula(formula, dr, dc) {
  let ast = null;
  try {
    ast = parseExpression(formula);
  } catch {
    return formula;
  }
  if (!ast) return formula;
  const mutated = rewriteRefs(ast, makeRefMutator((r) => r + dr, (c) => c + dc));
  return "=" + stringifyExpression(mutated);
}

function pasteAt() {
  const clip = state.clipboard;
  if (!clip) return;
  snapshot();
  const { r: ar, c: ac } = state.sel.anchor;
  const updates = [];
  for (const [coord, cell] of clip.cells) {
    const p = parseCoord(coord);
    if (!p) continue;
    const dr = ar - clip.r0;
    const dc = ac - clip.c0;
    const target = coordToLabel(p.col + dc, p.row + dr);
    if (cell.formula) {
      updates.push({ coord: target, formula: shiftFormula(cell.formula, dr, dc), format: cell.format });
    } else {
      updates.push({ coord: target, value: cell.value, format: cell.format });
    }
  }
  if (EMBEDDED) {
    callShell("updateCells", { sheetId: state.sheetId, updates })
      .then(reloadSheet)
      .catch((err) => showToast("Paste failed: " + err.message));
  } else {
    demoSetBulk(updates);
    render();
  }
  if (clip.mode === "cut") state.clipboard = null;
}

function clearSelection() {
  snapshot();
  const coords = selCoords();
  const updates = coords.map((coord) => ({ coord, value: null }));
  if (EMBEDDED) {
    callShell("updateCells", { sheetId: state.sheetId, updates })
      .then(reloadSheet)
      .catch((err) => showToast("Clear failed: " + err.message));
  } else {
    demoSetBulk(updates);
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Fill handle                                                          */
/* ------------------------------------------------------------------ */

function computeFill(b, fillTo) {
  // fillTo: { r0, r1, c0, c1 } target range (extends the source selection).
  const srcH = b.r1 - b.r0 + 1;
  const srcW = b.c1 - b.c0 + 1;
  const updates = [];

  for (let r = fillTo.r0; r <= fillTo.r1; r++) {
    for (let c = fillTo.c0; c <= fillTo.c1; c++) {
      const srcR = b.r0 + ((r - b.r0) % srcH);
      const srcC = b.c0 + ((c - b.c0) % srcW);
      const srcCoord = coordToLabel(srcC, srcR);
      const src = state.cells.get(srcCoord);
      const target = coordToLabel(c, r);
      if (!src) {
        updates.push({ coord: target, value: null });
        continue;
      }
      const dr = r - srcR;
      const dc = c - srcC;
      if (src.formula) {
        updates.push({ coord: target, formula: shiftFormula(src.formula, dr, dc), format: src.format });
      } else {
        updates.push({ coord: target, value: fillValue(src.value, dr, dc), format: src.format });
      }
    }
  }
  return updates;
}

function fillValue(value, dr, dc) {
  if (typeof value === "number") {
    // A single number: copy; a series is handled by the caller selecting 2+.
    return value;
  }
  if (typeof value === "string") {
    const m = /^(.*?)(\d+)$/.exec(value);
    if (m && (dr !== 0 || dc !== 0)) {
      const step = dr !== 0 ? dr : dc;
      return m[1] + (Number(m[2]) + step);
    }
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Formatting actions                                                   */
/* ------------------------------------------------------------------ */

function applyFormat(patch) {
  const coords = selCoords();
  snapshot();
  const updates = coords.map((coord) => {
    const cell = state.cells.get(coord);
    const format = { ...(cell?.format || {}), ...patch };
    return { coord, format };
  });
  if (EMBEDDED) {
    callShell("updateCells", { sheetId: state.sheetId, updates })
      .then(reloadSheet)
      .catch((err) => showToast("Format failed: " + err.message));
  } else {
    demoSetBulk(updates);
    render();
  }
}

function toggleFormat(key) {
  const cell = state.cells.get(anchorCoord());
  const current = cell?.format?.[key] || false;
  applyFormat({ [key]: !current });
}

/* ------------------------------------------------------------------ */
/* Structural actions                                                   */
/* ------------------------------------------------------------------ */

function structural(kind) {
  const { r, c } = state.sel.anchor;
  snapshot();
  if (EMBEDDED) {
    const at = kind.endsWith("Rows") ? r : c;
    callShell(kind === "insertRows" || kind === "insertCols" ? "insert" + (kind.endsWith("Rows") ? "Rows" : "Cols") : "delete" + (kind.endsWith("Rows") ? "Rows" : "Cols"), {
      sheetId: state.sheetId,
      at,
      count: 1,
    })
      .then(reloadSheet)
      .catch((err) => showToast("Failed: " + err.message));
  } else {
    const at = kind.endsWith("Rows") ? r : c;
    demoStructuralEdit(kind, at, 1);
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                             */
/* ------------------------------------------------------------------ */

function handleKeydown(e) {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const mod = e.ctrlKey || e.metaKey;

  // Formula bar / editor handled separately; only intercept when not typing
  // in an input (unless it's a shortcut).
  if (inInput && !mod) return;

  const { anchor, focus } = state.sel;
  const b = selBox();

  if (mod) {
    switch (e.key.toLowerCase()) {
      case "z":
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      case "y":
        e.preventDefault();
        redo();
        return;
      case "c":
        e.preventDefault();
        copySelection();
        return;
      case "x":
        e.preventDefault();
        cutSelection();
        return;
      case "v":
        e.preventDefault();
        pasteAt();
        return;
      case "b":
        e.preventDefault();
        toggleFormat("bold");
        return;
      case "i":
        e.preventDefault();
        toggleFormat("italic");
        return;
      case "u":
        e.preventDefault();
        toggleFormat("underline");
        return;
      case "a":
        e.preventDefault();
        state.sel = { anchor: { r: 0, c: 0 }, focus: { r: ROWS - 1, c: COLS - 1 } };
        render();
        return;
      case " ":
        e.preventDefault();
        state.sel = { anchor: { r: 0, c: anchor.c }, focus: { r: ROWS - 1, c: anchor.c } };
        render();
        return;
    }
    return;
  }

  if (inInput) return;

  const move = (dr, dc, extend) => {
    const r = Math.min(ROWS - 1, Math.max(0, focus.r + dr));
    const c = Math.min(COLS - 1, Math.max(0, focus.c + dc));
    setSelection(r, c, { extend });
    if (!extend) state.sel.anchor = { r, c };
    render();
    scrollToCell(r, c);
  };

  switch (e.key) {
    case "ArrowUp":
      e.preventDefault();
      move(-1, 0, e.shiftKey);
      return;
    case "ArrowDown":
      e.preventDefault();
      move(1, 0, e.shiftKey);
      return;
    case "ArrowLeft":
      e.preventDefault();
      move(0, -1, e.shiftKey);
      return;
    case "ArrowRight":
      e.preventDefault();
      move(0, 1, e.shiftKey);
      return;
    case "Tab":
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1, false);
      return;
    case "Enter":
      e.preventDefault();
      if (e.shiftKey) move(-1, 0, false);
      else move(1, 0, false);
      return;
    case "Home":
      e.preventDefault();
      move(0, 0, false);
      return;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      clearSelection();
      return;
    case "F2":
      e.preventDefault();
      startEdit(anchorCoord());
      return;
    case "Escape":
      state.sel = { anchor, focus: anchor };
      render();
      return;
  }

  if (e.key.length === 1 && !mod) {
    e.preventDefault();
    startEdit(anchorCoord(), e.key);
  }
}

function scrollToCell(r, c) {
  const viewport = $("viewport");
  const left = colOffsets[c];
  const right = left + colWidth(c);
  const top = r * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (left < viewport.scrollLeft) viewport.scrollLeft = left;
  else if (right > viewport.scrollLeft + viewport.clientWidth) {
    viewport.scrollLeft = right - viewport.clientWidth;
  }
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (bottom > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = bottom - viewport.clientHeight;
  }
}

/* ------------------------------------------------------------------ */
/* Import / export                                                      */
/* ------------------------------------------------------------------ */

function exportCSV() {
  const coords = Array.from(state.cells.keys()).map((coord) => parseCoord(coord)).filter(Boolean);
  const maxR = coords.length ? Math.max(...coords.map((p) => p.row)) : 0;
  const maxC = coords.length ? Math.max(...coords.map((p) => p.col)) : 0;
  const grid = Array.from({ length: maxR + 1 }, () => Array(maxC + 1).fill(""));
  for (const [coord, cell] of state.cells) {
    const p = parseCoord(coord);
    if (!p) continue;
    grid[p.row][p.col] = currentText(cell);
  }
  const csv = grid.map((row) => row.map(quoteCSV).join(",")).join("\n");
  download("dreamsheet.csv", csv, "text/csv");
}

function quoteCSV(v) {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function exportJSON() {
  const data = { sheets: [{ name: "Sheet1", cells: serializeCells() }] };
  download("dreamsheet.json", JSON.stringify(data, null, 2), "application/json");
}

function importCSV(text) {
  const rows = text.split(/\r?\n/);
  const updates = [];
  rows.forEach((line, r) => {
    const cols = parseCSVLine(line);
    cols.forEach((val, c) => {
      if (val === "") return;
      const coord = coordToLabel(c, r);
      updates.push({ coord, value: isNumeric(val) ? Number(val) : val });
    });
  });
  snapshot();
  if (EMBEDDED) {
    callShell("updateCells", { sheetId: state.sheetId, updates })
      .then(reloadSheet)
      .catch((err) => showToast("Import failed: " + err.message));
  } else {
    demoSetBulk(updates);
    render();
  }
  showToast(`Imported ${updates.length} cells`);
}

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Persistence (demo mode)                                              */
/* ------------------------------------------------------------------ */

function save() {
  if (EMBEDDED) return;
  try {
    const payload = {
      cells: serializeCells(),
      colWidths: Array.from(state.colWidths.entries()),
      theme: state.theme,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / privacy errors */
  }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function seedSample() {
  const data = [
    ["Item", "Price", "Qty", "Total"],
    ["Widget", 12.5, 3, "=B2*C2"],
    ["Gadget", 8, 5, "=B3*C3"],
    ["Gizmo", 25, 2, "=B4*C4"],
    ["Total", "", "", "=SUM(D2:D4)"],
  ];
  const updates = [];
  data.forEach((row, r) => {
    row.forEach((v, c) => {
      if (v === "") return;
      const coord = coordToLabel(c, r);
      if (typeof v === "string" && v.startsWith("=")) {
        updates.push({ coord, formula: v });
      } else {
        updates.push({ coord, value: v });
      }
    });
  });
  demoSetBulk(updates);
}

/* ------------------------------------------------------------------ */
/* AI fill / embed (bridged to plugin skills)                           */
/* ------------------------------------------------------------------ */

function aiFill() {
  const b = selBox();
  const start = coordToLabel(b.c0, b.r0);
  const end = coordToLabel(b.c1, b.r1);
  const instruction = window.prompt("Instruction (e.g. continue the sequence)");
  if (!instruction) return;
  if (EMBEDDED) {
    callShell("aiFillColumn", { sheetId: state.sheetId, startCoord: start, endCoord: end, instruction })
      .then(reloadSheet)
      .catch((err) => showToast("AI fill failed: " + err.message));
  } else {
    showToast("AI fill requires the plugin bridge");
  }
}

function embed() {
  const coord = anchorCoord();
  const targetClass = window.prompt("Target class (e.g. P2P.SmartNote)");
  if (!targetClass) return;
  const targetId = window.prompt("Target object id");
  if (!targetId) return;
  if (EMBEDDED) {
    callShell("embedObject", { sheetId: state.sheetId, coord, targetObjectId: targetId, targetClass })
      .then(reloadSheet)
      .catch((err) => showToast("Embed failed: " + err.message));
  } else {
    const existing = state.cells.get(coord) || { value: null, formula: null, format: null, embedded: null };
    existing.embedded = { targetClass, targetId };
    state.cells.set(coord, existing);
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Point-and-click formula refs                                         */
/* ------------------------------------------------------------------ */

function activeEditor() {
  return document.querySelector("input[data-editing]");
}

// Returns the input that should receive ref insertions, or null when not
// currently building a formula (either in the in-cell editor or the formula bar).
function isFormulaMode() {
  const ed = activeEditor();
  if (ed && ed.value.startsWith("=")) return ed;
  const fb = $("formula-input");
  if (document.activeElement === fb && fb.value.startsWith("=")) return fb;
  return null;
}

function refRangeText(a, b) {
  const start = coordToLabel(Math.min(a.c, b.c), Math.min(a.r, b.r));
  const end = coordToLabel(Math.max(a.c, b.c), Math.max(a.r, b.r));
  return start === end ? start : `${start}:${end}`;
}

function insertRefText(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  if (input === activeEditor()) $("formula-input").value = input.value;
  input.focus();
  return pos;
}

function renderRefPreview(a, b) {
  const r0 = Math.min(a.r, b.r);
  const r1 = Math.max(a.r, b.r);
  const c0 = Math.min(a.c, b.c);
  const c1 = Math.max(a.c, b.c);
  const left = colOffsets[c0];
  const top = r0 * ROW_HEIGHT;
  let width = 0;
  for (let c = c0; c <= c1; c++) width += colWidth(c);
  const height = (r1 - r0 + 1) * ROW_HEIGHT;
  const selEl = $("selection");
  selEl.style.left = left + "px";
  selEl.style.top = top + "px";
  selEl.style.width = width + "px";
  selEl.style.height = height + "px";
  const handle = $("fill-handle");
  handle.style.left = left + width - 4 + "px";
  handle.style.top = top + height - 4 + "px";
}

/* ------------------------------------------------------------------ */
/* Mouse interaction                                                    */
/* ------------------------------------------------------------------ */

function initMouse() {
  const viewport = $("viewport");
  const layer = $("cell-layer");

  // Cell clicks (event delegation).
  layer.addEventListener("mousedown", (e) => {
    const cellNode = e.target.closest(".cell");
    if (!cellNode) return;
    const coord = cellNode.dataset.coord;
    const p = parseCoord(coord);
    if (!p) return;

    const refInput = isFormulaMode();
    if (refInput) {
      e.preventDefault();
      const basePos = refInput.selectionStart ?? refInput.value.length;
      if (e.shiftKey && refAnchor) {
        const text = refRangeText(refAnchor, { r: p.row, c: p.col });
        insertRefText(refInput, text);
        renderRefPreview(refAnchor, { r: p.row, c: p.col });
        return;
      }
      state.suppressCommit = true;
      dragging = {
        mode: "ref",
        input: refInput,
        baseValue: refInput.value,
        basePos,
        anchor: { r: p.row, c: p.col },
        current: { r: p.row, c: p.col },
      };
      refAnchor = { r: p.row, c: p.col };
      insertRefText(refInput, coordToLabel(p.col, p.row));
      renderRefPreview({ r: p.row, c: p.col }, { r: p.row, c: p.col });
      return;
    }

    if (e.shiftKey) {
      state.sel.focus = { r: p.row, c: p.col };
    } else {
      state.sel = { anchor: { r: p.row, c: p.col }, focus: { r: p.row, c: p.col } };
      state.editing = null;
    }
    syncFormulaBar();
    render();
    dragging = { mode: "select", start: { r: p.row, c: p.col } };
  });

  layer.addEventListener("dblclick", (e) => {
    const cellNode = e.target.closest(".cell");
    if (!cellNode) return;
    startEdit(cellNode.dataset.coord);
  });

  let dragging = null;

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (dragging.mode === "select") {
      const p = cellFromPoint(e.clientX, e.clientY);
      if (p) {
        state.sel = { anchor: dragging.start, focus: { r: p.r, c: p.c } };
        render();
      }
    } else if (dragging.mode === "fill") {
      const p = cellFromPoint(e.clientX, e.clientY);
      if (p) {
        const b = selBox();
        const fillTo = {
          r0: Math.min(b.r0, p.r),
          r1: Math.max(b.r1, p.r),
          c0: Math.min(b.c0, p.c),
          c1: Math.max(b.c1, p.c),
        };
        // Exclude the source selection itself.
        const updates = computeFill(b, fillTo);
        const filtered = updates.filter((u) => {
          const q = parseCoord(u.coord);
          return !(q && q.row >= b.r0 && q.row <= b.r1 && q.col >= b.c0 && q.col <= b.c1);
        });
        dragging.pending = filtered;
        dragging.pendingRange = fillTo;
        render();
        previewFill(filtered);
      }
    } else if (dragging.mode === "ref") {
      const p = cellFromPoint(e.clientX, e.clientY);
      if (p) {
        dragging.current = { r: p.r, c: p.c };
        const text = refRangeText(dragging.anchor, dragging.current);
        const input = dragging.input;
        input.value = dragging.baseValue.slice(0, dragging.basePos) + text + dragging.baseValue.slice(dragging.basePos);
        const pos = dragging.basePos + text.length;
        input.setSelectionRange(pos, pos);
        if (input === activeEditor()) $("formula-input").value = input.value;
        renderRefPreview(dragging.anchor, dragging.current);
      }
    }
  });

  window.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    if (dragging.mode === "ref") {
      state.suppressCommit = false;
      dragging = null;
      renderSelection();
      return;
    }
    if (dragging.mode === "fill" && dragging.pending) {
      snapshot();
      if (EMBEDDED) {
        callShell("updateCells", { sheetId: state.sheetId, updates: dragging.pending })
          .then(reloadSheet)
          .catch((err) => showToast("Fill failed: " + err.message));
      } else {
        demoSetBulk(dragging.pending);
      }
      state.sel = { anchor: { r: dragging.pendingRange.r0, c: dragging.pendingRange.c0 }, focus: { r: dragging.pendingRange.r1, c: dragging.pendingRange.c1 } };
    }
    dragging = null;
    render();
  });

  // Fill handle drag.
  $("fill-handle").addEventListener("mousedown", (e) => {
    e.stopPropagation();
    dragging = { mode: "fill", start: { r: 0, c: 0 }, pending: null };
  });

  // Column resize.
  $("col-headers").addEventListener("mousedown", (e) => {
    const resizer = e.target.closest(".col-resizer");
    if (!resizer) return;
    e.preventDefault();
    const col = Number(resizer.dataset.col);
    const startX = e.clientX;
    const startW = colWidth(col);
    const move = (ev) => {
      const w = Math.min(MAX_COL_W, Math.max(MIN_COL_W, startW + (ev.clientX - startX)));
      state.colWidths.set(col, w);
      render();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      save();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  viewport.addEventListener("scroll", () => {
    if (renderCells._raf) return;
    renderCells._raf = requestAnimationFrame(() => {
      renderCells._raf = null;
      renderCells();
      renderSelection();
    });
  });
}

function cellFromPoint(x, y) {
  const viewport = $("viewport");
  const rect = viewport.getBoundingClientRect();
  const relX = x - rect.left + viewport.scrollLeft;
  const relY = y - rect.top + viewport.scrollTop;
  let c = COLS - 1;
  for (let i = 0; i < COLS; i++) {
    if (relX < colOffsets[i + 1]) {
      c = i;
      break;
    }
  }
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor(relY / ROW_HEIGHT)));
  return { r, c };
}

function previewFill(updates) {
  // Reuse the cell layer to show a live preview by directly rendering.
  // For simplicity, temporarily set pending values without full recalc.
  // (Recalc happens on mouseup via demoSetBulk.)
}

/* ------------------------------------------------------------------ */
/* Toolbar wiring                                                       */
/* ------------------------------------------------------------------ */

function initToolbar() {
  $("btn-bold").addEventListener("click", () => toggleFormat("bold"));
  $("btn-italic").addEventListener("click", () => toggleFormat("italic"));
  $("btn-underline").addEventListener("click", () => toggleFormat("underline"));
  $("btn-align-left").addEventListener("click", () => applyFormat({ align: "left" }));
  $("btn-align-center").addEventListener("click", () => applyFormat({ align: "center" }));
  $("btn-align-right").addEventListener("click", () => applyFormat({ align: "right" }));
  $("num-format").addEventListener("change", (e) => {
    const numFmt = e.target.value;
    applyFormat({ numFmt });
  });
  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  $("btn-insert-row").addEventListener("click", () => structural("insertRows"));
  $("btn-delete-row").addEventListener("click", () => structural("deleteRows"));
  $("btn-insert-col").addEventListener("click", () => structural("insertCols"));
  $("btn-delete-col").addEventListener("click", () => structural("deleteCols"));
  $("btn-ai-fill").addEventListener("click", aiFill);
  $("btn-embed").addEventListener("click", embed);
  $("btn-import").addEventListener("click", () => $("file-input").click());
  $("btn-export-csv").addEventListener("click", exportCSV);
  $("btn-export-json").addEventListener("click", exportJSON);
  $("btn-theme").addEventListener("click", toggleTheme);
  $("file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importCSV(String(reader.result));
    reader.readAsText(file);
    e.target.value = "";
  });

  $("formula-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitCell(anchorCoord(), $("formula-input").value);
    }
  });
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
  save();
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme);
  $("btn-theme").textContent = state.theme === "dark" ? "\u2600" : "\u263E";
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

function boot() {
  if (EMBEDDED) {
    $("bridge-status").textContent = "mode: shell bridge";
    callShell("listSheets", {})
      .then((list) => {
        if (list && list.length) {
          return callShell("getSheet", { sheetId: list[0].sheetId }).then(parseSheet);
        }
        return callShell("createSheet", { title: "Sheet1" }).then(parseSheet);
      })
      .then((sheet) => {
        state.sheetId = sheet.sheetId;
        state.cells = sheet.cells;
        setSelection(0, 0);
        render();
      })
      .catch((err) => {
        $("bridge-status").textContent = "mode: bridge error";
        showToast("Failed to load sheet: " + err.message);
        render();
      });
  } else {
    state.sheetId = "demo";
    const saved = loadSaved();
    if (saved && Array.isArray(saved.cells)) {
      restoreCells(saved.cells);
      if (Array.isArray(saved.colWidths)) {
        for (const [c, w] of saved.colWidths) state.colWidths.set(c, w);
      }
      state.theme = saved.theme || "dark";
    } else {
      seedSample();
    }
    applyTheme();
    setSelection(0, 0);
    render();
    snapshot(); // seed history
  }
}

document.addEventListener("keydown", handleKeydown);
initToolbar();
initMouse();
boot();
