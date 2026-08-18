/* AI Canvas frontend.
 *
 * Talks to the paint plugin exclusively through the postMessage bridge
 * (source "p2p-hub-plugin"), the same channel the desktop shell's
 * PluginBridge validates per-skill. When the document is not embedded inside
 * a shell (window.parent === window), it falls back to a fully local demo mode
 * so the canvas remains usable on its own.
 */
(function () {
  "use strict";

  var EMBEDDED = window.parent !== window;
  var SHELL_SOURCE = "p2p-hub-shell";
  var PLUGIN_SOURCE = "p2p-hub-plugin";
  var BRIDGE_TIMEOUT_MS = 30000;

  var pending = {};
  var seq = 0;

  var state = {
    canvasId: null,
    title: "Untitled",
    width: 800,
    height: 600,
    layers: [],
    tool: "pen",
    color: "#4f8cff",
    size: 4,
    drawing: false,
  };

  var board = document.getElementById("board");
  var ctx = board.getContext("2d");

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ---- bridge ---------------------------------------------------------- */

  function callShell(method, args) {
    return new Promise(function (resolve, reject) {
      var requestId = "paint-" + ++seq + "-" + Date.now();
      pending[requestId] = { resolve: resolve, reject: reject };
      window.parent.postMessage(
        {
          source: PLUGIN_SOURCE,
          pluginId: "paint",
          requestId: requestId,
          serviceId: "paint",
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

  function extractCanvas(doc) {
    var canvasId = doc.$top.root.$ref;
    var root = doc.$objects[canvasId];
    var layerRefs = Array.isArray(root.layers) ? root.layers : [];
    var embeds = Array.isArray(root.embedded) ? root.embedded : [];
    return {
      canvasId: canvasId,
      title: root.title || "Untitled",
      width: typeof root.width === "number" ? root.width : 800,
      height: typeof root.height === "number" ? root.height : 600,
      layers: layerRefs.map(function (ref) {
        var l = doc.$objects[ref.$ref] || {};
        return normalizeLayer(ref.$ref, l);
      }),
      embeds: embeds.map(function (ref) {
        return doc.$objects[ref.$ref];
      }),
    };
  }

  function normalizeLayer(layerId, obj) {
    return {
      layerId: layerId,
      kind: obj.kind === "vector" ? "vector" : "raster",
      data: typeof obj.data === "string" ? obj.data : "",
      dataKind: obj.dataKind === "url" ? "url" : "base64",
      visible: obj.visible !== false,
      opacity: typeof obj.opacity === "number" ? obj.opacity : 1,
      prompt: typeof obj.prompt === "string" ? obj.prompt : null,
    };
  }

  /* ---- demo mode ------------------------------------------------------- */

  function loadDemo() {
    try {
      var raw = localStorage.getItem("p2p-hub-paint");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveDemo() {
    try {
      localStorage.setItem(
        "p2p-hub-paint",
        JSON.stringify({
          canvasId: state.canvasId,
          title: state.title,
          width: state.width,
          height: state.height,
          layers: state.layers,
        }),
      );
    } catch (e) {
      /* ignore */
    }
  }

  function demoGenerate(prompt) {
    // Build a placeholder gradient "image" locally (no network, no AI).
    var c = document.createElement("canvas");
    c.width = state.width;
    c.height = state.height;
    var g = c.getContext("2d");
    var grad = g.createLinearGradient(0, 0, state.width, state.height);
    grad.addColorStop(0, "#4f8cff");
    grad.addColorStop(1, "#7c5cff");
    g.fillStyle = grad;
    g.fillRect(0, 0, state.width, state.height);
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.font = "20px sans-serif";
    g.fillText(prompt, 20, 40, state.width - 40);
    var base64 = c.toDataURL("image/png").split(",")[1];
    return {
      layerId: uuid(),
      kind: "raster",
      data: base64,
      dataKind: "base64",
      visible: true,
      opacity: 1,
      prompt: prompt,
    };
  }

  /* ---- layer actions (bridge or demo) ---------------------------------- */

  function createCanvas(title) {
    if (EMBEDDED) {
      return callShell("createCanvas", { title: title }).then(extractCanvas);
    }
    var c = { canvasId: uuid(), title: title, width: state.width, height: state.height, layers: [] };
    return Promise.resolve(c);
  }

  function addLayer(layer) {
    if (EMBEDDED) {
      return callShell("addLayer", {
        canvasId: state.canvasId,
        kind: layer.kind,
        data: layer.data,
        visible: layer.visible,
        opacity: layer.opacity,
      }).then(function (obj) {
        return normalizeLayer(obj.$id, obj);
      });
    }
    layer.layerId = uuid();
    return Promise.resolve(layer);
  }

  function updateLayer(layerId, patch) {
    if (EMBEDDED) {
      return callShell("updateLayer", {
        canvasId: state.canvasId,
        layerId: layerId,
        visible: patch.visible,
        opacity: patch.opacity,
      }).then(function (obj) {
        return normalizeLayer(obj.$id, obj);
      });
    }
    for (var i = 0; i < state.layers.length; i++) {
      if (state.layers[i].layerId === layerId) {
        if (patch.visible !== undefined) state.layers[i].visible = patch.visible;
        if (patch.opacity !== undefined) state.layers[i].opacity = patch.opacity;
        return Promise.resolve(state.layers[i]);
      }
    }
    return Promise.reject(new Error("layer not found"));
  }

  function deleteLayer(layerId) {
    if (EMBEDDED) {
      return callShell("deleteLayer", {
        canvasId: state.canvasId,
        layerId: layerId,
      });
    }
    state.layers = state.layers.filter(function (l) {
      return l.layerId !== layerId;
    });
    return Promise.resolve(null);
  }

  function aiGenerate(prompt) {
    if (EMBEDDED) {
      return callShell("aiGenerateImage", {
        canvasId: state.canvasId,
        prompt: prompt,
      }).then(function (obj) {
        return normalizeLayer(obj.$id, obj);
      });
    }
    return Promise.resolve(demoGenerate(prompt));
  }

  function exportImage() {
    if (EMBEDDED) {
      return callShell("exportPNG", { canvasId: state.canvasId });
    }
    // Demo: flatten the current canvas.
    return Promise.resolve({
      dataUrl: board.toDataURL("image/png"),
      mime: "image/png",
      width: state.width,
      height: state.height,
    });
  }

  function embedObject(targetObjectId, targetClass) {
    if (EMBEDDED) {
      return callShell("embedObject", {
        canvasId: state.canvasId,
        targetObjectId: targetObjectId,
        targetClass: targetClass,
      });
    }
    return Promise.resolve(null);
  }

  /* ---- compositing ----------------------------------------------------- */

  function drawImageLayer(layer, w, h) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(img, 0, 0, w, h);
        ctx.restore();
        resolve();
      };
      img.onerror = function () {
        resolve();
      };
      if (layer.kind === "vector") {
        img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(layer.data)));
      } else if (layer.dataKind === "url") {
        img.src = layer.data;
      } else {
        img.src = "data:image/png;base64," + layer.data;
      }
    });
  }

  function compose() {
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, board.width, board.height);
    var visible = state.layers.filter(function (l) {
      return l.visible;
    });
    var chain = Promise.resolve();
    visible.forEach(function (layer) {
      chain = chain.then(function () {
        return drawImageLayer(layer, board.width, board.height);
      });
    });
    return chain.then(renderLayers);
  }

  /* ---- drawing (pen / fill) -------------------------------------------- */

  function pos(e) {
    var rect = board.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (board.width / rect.width),
      y: (e.clientY - rect.top) * (board.height / rect.height),
    };
  }

  board.addEventListener("pointerdown", function (e) {
    if (state.tool !== "pen") return;
    state.drawing = true;
    board.setPointerCapture(e.pointerId);
    var p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });

  board.addEventListener("pointermove", function (e) {
    if (!state.drawing || state.tool !== "pen") return;
    var p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  });

  board.addEventListener("pointerup", function () {
    state.drawing = false;
  });

  function fillCanvas() {
    ctx.fillStyle = state.color;
    ctx.fillRect(0, 0, board.width, board.height);
  }

  function clearCanvas() {
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, board.width, board.height);
  }

  function snapshotBase64() {
    return board.toDataURL("image/png").split(",")[1];
  }

  /* ---- rendering ------------------------------------------------------- */

  function renderLayers() {
    var list = document.getElementById("layers");
    list.innerHTML = "";
    var empty = document.getElementById("empty-hint");
    empty.classList.toggle("hidden", state.layers.length > 0);

    state.layers.forEach(function (layer) {
      var li = document.createElement("li");

      var check = document.createElement("input");
      check.type = "checkbox";
      check.checked = layer.visible;
      check.addEventListener("change", function () {
        updateLayer(layer.layerId, { visible: check.checked })
          .then(function (updated) {
            layer.visible = updated.visible;
            if (!EMBEDDED) saveDemo();
            return compose();
          })
          .catch(showError);
      });

      var label = document.createElement("span");
      label.className = "kind";
      label.textContent =
        (layer.kind === "vector" ? "vector" : "raster") +
        (layer.prompt ? " · " + layer.prompt : "");

      var del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", function () {
        deleteLayer(layer.layerId)
          .then(function () {
            state.layers = state.layers.filter(function (l) {
              return l.layerId !== layer.layerId;
            });
            if (!EMBEDDED) saveDemo();
            return compose();
          })
          .catch(showError);
      });

      li.appendChild(check);
      li.appendChild(label);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.add("hidden");
    }, 3000);
  }

  function showError(err) {
    showToast("Error: " + (err && err.message ? err.message : err));
  }

  /* ---- toolbar wiring -------------------------------------------------- */

  document.querySelectorAll(".tool").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tool").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      state.tool = btn.getAttribute("data-tool");
    });
  });

  document.getElementById("color").addEventListener("input", function (e) {
    state.color = e.target.value;
  });

  document.getElementById("size").addEventListener("input", function (e) {
    state.size = Number(e.target.value);
  });

  document.getElementById("save-layer").addEventListener("click", function () {
    var base64 = snapshotBase64();
    addLayer({ kind: "raster", data: base64, visible: true, opacity: 1 })
      .then(function (layer) {
        state.layers.push(layer);
        if (!EMBEDDED) saveDemo();
        clearCanvas();
        return compose();
      })
      .then(function () {
        showToast("Drawing saved as a layer");
      })
      .catch(showError);
  });

  document.getElementById("clear").addEventListener("click", function () {
    clearCanvas();
  });

  document.getElementById("generate").addEventListener("click", function () {
    var prompt = document.getElementById("prompt").value.trim();
    if (!prompt) {
      showToast("Enter a prompt first.");
      return;
    }
    showToast("Generating image…");
    aiGenerate(prompt)
      .then(function (layer) {
        state.layers.push(layer);
        if (!EMBEDDED) saveDemo();
        return compose();
      })
      .then(function () {
        showToast("Image layer added");
      })
      .catch(showError);
  });

  document.getElementById("export").addEventListener("click", function () {
    exportImage()
      .then(function (result) {
        var a = document.createElement("a");
        a.href = result.dataUrl;
        a.download = (state.title || "canvas") + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast("Exported");
      })
      .catch(showError);
  });

  document.getElementById("embed").addEventListener("click", function () {
    var targetClass = window.prompt("Target PBX class (e.g. P2P.SmartNote)");
    if (!targetClass) return;
    var targetId = window.prompt("Target object id");
    if (!targetId) return;
    embedObject(targetId, targetClass)
      .then(function () {
        showToast("Object embedded (OLE)");
      })
      .catch(showError);
  });

  /* ---- boot ------------------------------------------------------------ */

  board.width = state.width;
  board.height = state.height;
  clearCanvas();

  if (EMBEDDED) {
    document.getElementById("bridge-status").textContent = "mode: shell bridge";
    callShell("listCanvases", {})
      .then(function (docs) {
        var canvases = (docs || []).map(extractCanvas);
        if (canvases.length) {
          applyCanvas(canvases[0]);
        } else {
          return callShell("createCanvas", { title: "New canvas" }).then(function (doc) {
            applyCanvas(extractCanvas(doc));
          });
        }
      })
      .catch(function () {
        // Canvas plugin unavailable in some shells — stay on demo state.
        document.getElementById("bridge-status").textContent = "mode: local demo";
        compose();
      });
  } else {
    var saved = loadDemo();
    if (saved && saved.canvasId) {
      state.canvasId = saved.canvasId;
      state.title = saved.title || "Untitled";
      state.width = saved.width || 800;
      state.height = saved.height || 600;
      state.layers = saved.layers || [];
      board.width = state.width;
      board.height = state.height;
    }
    compose();
  }

  function applyCanvas(canvas) {
    state.canvasId = canvas.canvasId;
    state.title = canvas.title;
    state.width = canvas.width;
    state.height = canvas.height;
    state.layers = canvas.layers;
    board.width = state.width;
    board.height = state.height;
    compose();
  }
})();
