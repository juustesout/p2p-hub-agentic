/* AI Grid & Sheet frontend.
 *
 * Communicates with the calc plugin through the postMessage bridge (source
 * "p2p-hub-plugin"), the same channel the desktop shell's PluginBridge
 * validates per-skill. Falls back to a local demo grid when not embedded.
 */
(function () {
  "use strict";

  var EMBEDDED = window.parent !== window;
  var SHELL_SOURCE = "p2p-hub-shell";
  var PLUGIN_SOURCE = "p2p-hub-plugin";
  var BRIDGE_TIMEOUT_MS = 15000;

  var COLS = 26;
  var ROWS = 40;

  var pending = {};
  var seq = 0;

  var sheetId = null;
  var cells = {};
  var selected = "A1";

  /* ---- bridge ---------------------------------------------------------- */

  function callShell(method, args) {
    return new Promise(function (resolve, reject) {
      var requestId = "calc-" + ++seq + "-" + Date.now();
      pending[requestId] = { resolve: resolve, reject: reject };
      window.parent.postMessage(
        {
          source: PLUGIN_SOURCE,
          pluginId: "calc",
          requestId: requestId,
          serviceId: "calc",
          method: method,
          arguments: args,
        },
        "*",
      );
      setTimeout(function () {
        if (pending[requestId]) {
          delete pending[requestId];
          reject(new Error("bridge timeout"));
        }
      }, BRIDGE_TIMEOUT_MS);
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (
      !data ||
      data.source !== SHELL_SOURCE ||
      !data.requestId ||
      !pending[data.requestId]
    ) {
      return;
    }
    var entry = pending[data.requestId];
    delete pending[data.requestId];
    if (data.status === "ok") {
      entry.resolve(data.result);
    } else {
      entry.reject(new Error(data.error || "bridge error"));
    }
  });

  function parseSheet(doc) {
    var rootId = doc.$top.root.$ref;
    var root = doc.$objects[rootId];
    var sheetRef = root.sheets[0].$ref;
    var sheet = doc.$objects[sheetRef];
    var out = {};
    var sheetCells = sheet.cells || {};
    Object.keys(sheetCells).forEach(function (coord) {
      var cell = doc.$objects[sheetCells[coord].$ref];
      out[coord] = {
        value: cell.value,
        formula: cell.formula,
        embedded: cell.embeddedObject
          ? doc.$objects[cell.embeddedObject.$ref]
          : null,
      };
    });
    return { sheetId: sheetRef, cells: out };
  }

  function reloadSheet() {
    return callShell("getSheet", { sheetId: sheetId }).then(parseSheet).then(
      function (sheet) {
        cells = sheet.cells;
        renderGrid();
      },
    );
  }

  /* ---- demo helpers ---------------------------------------------------- */

  function colLabel(i) {
    return String.fromCharCode(65 + i);
  }

  function coordCol(coord) {
    var letters = coord.match(/^([A-Z]+)/)[1];
    var s = 0;
    for (var i = 0; i < letters.length; i++) {
      s = s * 26 + (letters.charCodeAt(i) - 64);
    }
    return s - 1;
  }

  function coordRow(coord) {
    return parseInt(coord.match(/(\d+)$/)[1], 10) - 1;
  }

  function rangeCoords(a, b) {
    var c1 = coordCol(a);
    var r1 = coordRow(a);
    var c2 = coordCol(b);
    var r2 = coordRow(b);
    var out = [];
    for (var r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (var c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        out.push(colLabel(c) + (r + 1));
      }
    }
    return out;
  }

  function isNumeric(s) {
    return s !== "" && !isNaN(Number(s));
  }

  function demoEval(raw) {
    var m = raw.match(/^=SUM\(\s*([A-Z]+\d+)(?::([A-Z]+\d+))?\s*\)$/i);
    if (m) {
      return rangeCoords(m[1], m[2] || m[1]).reduce(function (acc, c) {
        var v = cells[c] ? cells[c].value : null;
        return acc + (typeof v === "number" ? v : 0);
      }, 0);
    }
    m = raw.match(/^=AVERAGE\(\s*([A-Z]+\d+)(?::([A-Z]+\d+))?\s*\)$/i);
    if (m) {
      var nums = rangeCoords(m[1], m[2] || m[1])
        .map(function (c) {
          return cells[c] ? cells[c].value : null;
        })
        .filter(function (v) {
          return typeof v === "number";
        });
      return nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : "#DIV/0!";
    }
    m = raw.match(/^=AI\(\s*["'](.*?)["']\s*,\s*([A-Z]+\d+)\s*\)$/i);
    if (m) {
      var ref = cells[m[2]] && cells[m[2]].value != null ? cells[m[2]].value : "#REF!";
      return "[AI: " + m[1] + " -> " + ref + "]";
    }
    return "#REF!";
  }

  /* ---- rendering ------------------------------------------------------- */

  function th(text, className) {
    var node = document.createElement("th");
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function renderGrid() {
    var table = document.getElementById("grid");
    table.innerHTML = "";

    var thead = document.createElement("thead");
    var headerRow = document.createElement("tr");
    headerRow.appendChild(th(""));
    for (var c = 0; c < COLS; c++) headerRow.appendChild(th(colLabel(c)));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    for (var r = 0; r < ROWS; r++) {
      var row = document.createElement("tr");
      row.appendChild(th(String(r + 1), "row-header"));
      for (var c2 = 0; c2 < COLS; c2++) {
        var coord = colLabel(c2) + (r + 1);
        var td = document.createElement("td");
        td.dataset.coord = coord;
        if (coord === selected) td.classList.add("selected");
        var cell = cells[coord];
        if (cell) {
          if (cell.embedded) {
            td.classList.add("cell-embed");
            td.textContent = "OBJ";
            td.title = (cell.embedded.targetClass || "embedded") + " · " + (cell.embedded.targetId || "");
          } else if (cell.value !== null && cell.value !== undefined) {
            td.textContent = String(cell.value);
            if (cell.value === "#AI_ERR" || cell.value === "#REF!" || cell.value === "#DIV/0!") {
              td.classList.add("cell-error");
            }
          }
        }
        td.addEventListener("mousedown", function (event) {
          select(event.currentTarget.dataset.coord);
        });
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
  }

  function select(coord) {
    selected = coord;
    document.getElementById("cell-ref").textContent = coord;
    var cell = cells[coord];
    var formulaInput = document.getElementById("formula-input");
    formulaInput.value = cell
      ? cell.formula || (cell.value == null ? "" : String(cell.value))
      : "";
    renderGrid();
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.add("hidden");
    }, 2600);
  }

  /* ---- actions --------------------------------------------------------- */

  function commit() {
    var raw = document.getElementById("formula-input").value.trim();
    var coord = selected;
    if (!coord || !sheetId) return;

    if (EMBEDDED) {
      var p;
      if (raw.charAt(0) === "=") {
        p = callShell("updateCell", {
          sheetId: sheetId,
          coord: coord,
          formula: raw,
        }).then(function () {
          if (/^=AI\(/i.test(raw)) {
            return callShell("evaluateAIFormula", {
              sheetId: sheetId,
              coord: coord,
            });
          }
          return null;
        });
      } else {
        var value = raw === "" ? null : isNumeric(raw) ? Number(raw) : raw;
        p = callShell("updateCell", {
          sheetId: sheetId,
          coord: coord,
          value: value,
        });
      }
      p.then(reloadSheet).catch(function (err) {
        showToast("Update failed: " + err.message);
      });
    } else {
      var prev = cells[coord] || {};
      if (raw.charAt(0) === "=") {
        cells[coord] = { value: demoEval(raw), formula: raw, embedded: prev.embedded || null };
      } else {
        cells[coord] = {
          value: raw === "" ? null : isNumeric(raw) ? Number(raw) : raw,
          formula: null,
          embedded: prev.embedded || null,
        };
      }
      renderGrid();
    }
  }

  function aiFill() {
    var range = window.prompt("Range (e.g. A1:A10)");
    if (!range) return;
    var instruction = window.prompt("Instruction (e.g. Continue the months)");
    if (!instruction) return;
    var parts = range.split(":");
    var start = parts[0].trim();
    var end = (parts[1] || parts[0]).trim();

    if (EMBEDDED) {
      callShell("aiFillColumn", {
        sheetId: sheetId,
        startCoord: start,
        endCoord: end,
        instruction: instruction,
      })
        .then(reloadSheet)
        .catch(function (err) {
          showToast("AI fill failed: " + err.message);
        });
    } else {
      rangeCoords(start, end).forEach(function (c) {
        var prev = cells[c] || {};
        if (prev.value == null && !prev.embedded) {
          cells[c] = { value: "[fill]", formula: null, embedded: null };
        }
      });
      renderGrid();
    }
  }

  function embed() {
    if (!selected) return;
    var targetClass = window.prompt("Target class (e.g. P2P.SmartNote)");
    if (!targetClass) return;
    var targetId = window.prompt("Target object id");
    if (!targetId) return;

    if (EMBEDDED) {
      callShell("embedObject", {
        sheetId: sheetId,
        coord: selected,
        targetObjectId: targetId,
        targetClass: targetClass,
      })
        .then(reloadSheet)
        .catch(function (err) {
          showToast("Embed failed: " + err.message);
        });
    } else {
      var prev = cells[selected] || {};
      cells[selected] = {
        value: prev.value,
        formula: prev.formula,
        embedded: { targetClass: targetClass, targetId: targetId },
      };
      renderGrid();
    }
  }

  /* ---- wiring ---------------------------------------------------------- */

  document.getElementById("formula-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") commit();
  });
  document.getElementById("ai-fill").addEventListener("click", aiFill);
  document.getElementById("embed").addEventListener("click", embed);

  function boot() {
    if (EMBEDDED) {
      document.getElementById("bridge-status").textContent = "mode: shell bridge";
      callShell("listSheets", {})
        .then(function (list) {
          if (list && list.length) {
            return callShell("getSheet", { sheetId: list[0].sheetId }).then(parseSheet);
          }
          return callShell("createSheet", { title: "Sheet1" }).then(parseSheet);
        })
        .then(function (sheet) {
          sheetId = sheet.sheetId;
          cells = sheet.cells;
          select(selected);
        })
        .catch(function (err) {
          document.getElementById("bridge-status").textContent = "mode: bridge error";
          showToast("Failed to load sheet: " + err.message);
          renderGrid();
        });
    } else {
      sheetId = "demo";
      cells = {};
      select(selected);
    }
  }

  boot();
})();
