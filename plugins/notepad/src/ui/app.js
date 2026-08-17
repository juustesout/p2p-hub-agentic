/* AI Smart Note frontend.
 *
 * Talks to the notepad plugin exclusively through the postMessage bridge
 * (source "p2p-hub-plugin"), the same channel the desktop shell's
 * PluginBridge validates per-skill. When the document is not embedded inside
 * a shell (window.parent === window), it falls back to a fully local demo mode
 * so the editor remains usable on its own.
 */
(function () {
  "use strict";

  var EMBEDDED = window.parent !== window;
  var SHELL_SOURCE = "p2p-hub-shell";
  var PLUGIN_SOURCE = "p2p-hub-plugin";
  var BRIDGE_TIMEOUT_MS = 15000;

  var pending = {};
  var seq = 0;

  var notes = [];
  var currentNoteId = null;

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
      var requestId = "notepad-" + ++seq + "-" + Date.now();
      pending[requestId] = { resolve: resolve, reject: reject };
      window.parent.postMessage(
        {
          source: PLUGIN_SOURCE,
          pluginId: "notepad",
          requestId: requestId,
          serviceId: "notepad",
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

  function extractNote(doc) {
    var noteId = doc.$top.root.$ref;
    var root = doc.$objects[noteId];
    var blocks = Array.isArray(root.blocks) ? root.blocks : [];
    var blockId = blocks.length ? blocks[0].$ref : null;
    var embeds = Array.isArray(root.embedded) ? root.embedded : [];
    return {
      noteId: noteId,
      title: root.title || "Untitled",
      blockId: blockId,
      content: blockId ? doc.$objects[blockId].text : "",
      embeds: embeds.map(function (ref) {
        return doc.$objects[ref.$ref];
      }),
    };
  }

  /* ---- demo mode ------------------------------------------------------- */

  function demoTransform(instruction, text) {
    if (/summar/i.test(instruction)) {
      var words = text.split(/\s+/);
      var keep = Math.min(words.length, Math.max(1, Math.floor(words.length / 3)));
      return words.slice(0, keep).join(" ") + (words.length > keep ? " …" : "");
    }
    if (/translate/i.test(instruction)) {
      return "[translated] " + text;
    }
    if (/expand/i.test(instruction)) {
      return text + "\n\n(Expanded: " + text + ")";
    }
    if (/grammar/i.test(instruction) || /spelling/i.test(instruction)) {
      return text.replace(/\bi\b/g, "I");
    }
    return text;
  }

  function loadDemo() {
    try {
      var raw = localStorage.getItem("p2p-hub-notepad");
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveDemo() {
    try {
      localStorage.setItem("p2p-hub-notepad", JSON.stringify(notes));
    } catch (e) {
      /* ignore quota/private-mode errors */
    }
  }

  /* ---- state ----------------------------------------------------------- */

  function findNote(id) {
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].noteId === id) return notes[i];
    }
    return null;
  }

  function createNote(title, content) {
    if (EMBEDDED) {
      return callShell("createNote", { title: title, content: content }).then(
        extractNote,
      );
    }
    var note = {
      noteId: uuid(),
      title: title || "Untitled",
      blockId: uuid(),
      content: content || "",
      embeds: [],
    };
    return Promise.resolve(note);
  }

  function transformBlock(note, instruction) {
    if (EMBEDDED) {
      return callShell("aiTransformBlock", {
        noteId: note.noteId,
        blockId: note.blockId,
        instruction: instruction,
      }).then(function (block) {
        return block.text;
      });
    }
    return Promise.resolve(demoTransform(instruction, note.content));
  }

  function embedObject(note, targetObjectId, targetClass) {
    if (EMBEDDED) {
      return callShell("embedObject", {
        noteId: note.noteId,
        targetObjectId: targetObjectId,
        targetClass: targetClass,
      }).then(function (doc) {
        return extractNote(doc).embeds;
      });
    }
    note.embeds.push({
      $id: uuid(),
      $class: "P2P.EmbeddedObject",
      targetClass: targetClass,
      targetId: targetObjectId,
    });
    return Promise.resolve(note.embeds);
  }

  /* ---- rendering ------------------------------------------------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderNoteList() {
    var list = document.getElementById("note-list");
    list.innerHTML = "";
    notes.forEach(function (note) {
      var item = el("li", note.noteId === currentNoteId ? "active" : "");
      item.textContent = note.title;
      item.addEventListener("click", function () {
        selectNote(note.noteId);
      });
      list.appendChild(item);
    });
  }

  function renderEditor() {
    var note = currentNoteId ? findNote(currentNoteId) : null;
    var title = document.getElementById("note-title");
    var content = document.getElementById("note-content");
    var embeds = document.getElementById("embed-list");
    var preview = document.getElementById("preview");

    title.value = note ? note.title : "";
    content.value = note ? note.content : "";
    content.disabled = !note;

    embeds.innerHTML = "";
    if (note && note.embeds && note.embeds.length) {
      note.embeds.forEach(function (embed) {
        var card = el("div", "embed-card");
        card.appendChild(el("div", "embed-class", embed.targetClass || embed.$class));
        card.appendChild(el("div", "embed-id", embed.targetId || embed.$id));
        embeds.appendChild(card);
      });
    }

    if (!preview.classList.contains("hidden")) {
      renderPreview(note ? note.content : "");
    }
  }

  function renderPreview(text) {
    document.getElementById("preview").innerHTML = miniMarkdown(text || "");
  }

  function miniMarkdown(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/^### (.*)$/gm, "<h3>$1</h3>")
      .replace(/^## (.*)$/gm, "<h2>$1</h2>")
      .replace(/^# (.*)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/^[-*] (.*)$/gm, "<li>$1</li>")
      .replace(/\n/g, "<br/>");
  }

  function selectNote(id) {
    currentNoteId = id;
    renderNoteList();
    renderEditor();
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

  /* ---- AI toolbar ------------------------------------------------------ */

  var aiToolbar = document.getElementById("ai-toolbar");
  var activeSelection = null;

  function showAIToolbar(rect, note) {
    if (!note) return;
    activeSelection = note;
    aiToolbar.style.left = rect.left + "px";
    aiToolbar.style.top = rect.top - 46 + "px";
    aiToolbar.classList.remove("hidden");
  }

  function hideAIToolbar() {
    aiToolbar.classList.add("hidden");
    activeSelection = null;
  }

  aiToolbar.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button || !activeSelection) return;
    var instruction = button.getAttribute("data-instruction");
    var note = activeSelection;
    hideAIToolbar();
    showToast("Transforming block…");

    transformBlock(note, instruction)
      .then(function (newText) {
        note.content = newText;
        if (!EMBEDDED) saveDemo();
        renderEditor();
        showToast("Block updated");
      })
      .catch(function (err) {
        showToast("AI transform failed: " + err.message);
      });
  });

  document.getElementById("note-content").addEventListener("mouseup", function (event) {
    var textarea = event.currentTarget;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    if (start === end) {
      hideAIToolbar();
      return;
    }
    var note = currentNoteId ? findNote(currentNoteId) : null;
    if (note) showAIToolbar({ left: event.clientX, top: event.clientY }, note);
  });

  /* ---- other actions --------------------------------------------------- */

  document.getElementById("new-note").addEventListener("click", function () {
    var title = "New note";
    createNote(title, "").then(function (note) {
      notes.push(note);
      if (!EMBEDDED) saveDemo();
      currentNoteId = note.noteId;
      renderNoteList();
      renderEditor();
      document.getElementById("note-title").focus();
    });
  });

  document.getElementById("note-title").addEventListener("input", function (event) {
    var note = currentNoteId ? findNote(currentNoteId) : null;
    if (!note) return;
    note.title = event.target.value;
    if (!EMBEDDED) saveDemo();
    renderNoteList();
  });

  document.getElementById("note-content").addEventListener("input", function (event) {
    var note = currentNoteId ? findNote(currentNoteId) : null;
    if (!note) return;
    note.content = event.target.value;
    if (!EMBEDDED) saveDemo();
  });

  document.getElementById("toggle-preview").addEventListener("click", function () {
    var preview = document.getElementById("preview");
    var content = document.getElementById("note-content");
    var note = currentNoteId ? findNote(currentNoteId) : null;
    if (preview.classList.contains("hidden")) {
      renderPreview(note ? note.content : "");
      preview.classList.remove("hidden");
      content.classList.add("hidden");
    } else {
      preview.classList.add("hidden");
      content.classList.remove("hidden");
    }
  });

  document.getElementById("embed-btn").addEventListener("click", function () {
    var note = currentNoteId ? findNote(currentNoteId) : null;
    if (!note) return;
    var targetClass = window.prompt("Target PBX class (e.g. P2P.CanvasImage)");
    if (!targetClass) return;
    var targetId = window.prompt("Target object id");
    if (!targetId) return;
    embedObject(note, targetId, targetClass)
      .then(function () {
        if (!EMBEDDED) saveDemo();
        renderEditor();
        showToast("Object embedded (OLE)");
      })
      .catch(function (err) {
        showToast("Embed failed: " + err.message);
      });
  });

  /* ---- boot ------------------------------------------------------------ */

  if (EMBEDDED) {
    document.getElementById("bridge-status").textContent = "mode: shell bridge";
    callShell("listNotes", {})
      .then(function (docs) {
        notes = (docs || []).map(extractNote);
        if (notes.length) currentNoteId = notes[0].noteId;
        renderNoteList();
        renderEditor();
      })
      .catch(function () {
        /* listNotes unavailable in some shells — stay on empty state */
        renderNoteList();
        renderEditor();
      });
  } else {
    notes = loadDemo();
    if (notes.length) currentNoteId = notes[0].noteId;
    renderNoteList();
    renderEditor();
  }
})();
