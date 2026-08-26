/* Trust & Governance frontend.
 *
 * Talks to the platform exclusively through the postMessage bridge
 * (source "p2p-hub-plugin"), the same channel the desktop shell's
 * PluginBridge validates per-skill. The bridge calls resolve to the
 * `governance-ui.*` admin skills, which are httpBridgeOnly operator skills
 * registered by core-server — the UI never holds the boot token and never
 * reaches the REST surface directly.
 */
(function () {
  "use strict";

  var EMBEDDED = window.parent !== window;
  var SHELL_SOURCE = "p2p-hub-shell";
  var PLUGIN_SOURCE = "p2p-hub-plugin";
  var PLUGIN_ID = "governance-ui";
  var BRIDGE_TIMEOUT_MS = 30000;

  var pending = {};
  var seq = 0;

  var catalog = { skills: [], topics: [] };
  var topology = [];
  var matrixByPeer = {};
  var editingPeer = null;
  var editingVerified = false;

  var el = {
    status: document.getElementById("status"),
    app: document.getElementById("app"),
    standalone: document.getElementById("standalone"),
    peers: document.getElementById("peers").querySelector("tbody"),
    noPeers: document.getElementById("noPeers"),
    editorSection: document.getElementById("editorSection"),
    editorPeerLabel: document.getElementById("editorPeerLabel"),
    editorTrustTag: document.getElementById("editorTrustTag"),
    skillChecks: document.getElementById("skillChecks"),
    topicChecks: document.getElementById("topicChecks"),
    rateLimit: document.getElementById("rateLimit"),
    saveBtn: document.getElementById("saveBtn"),
    removeBtn: document.getElementById("removeBtn"),
    verifyBtn: document.getElementById("verifyBtn"),
    cancelBtn: document.getElementById("cancelBtn"),
    lastResult: document.getElementById("lastResult"),
  };

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.className =
      "status " + (isError ? "status--error" : "status--ok");
  }

  function result(text, isError) {
    el.lastResult.textContent = text;
    el.lastResult.className =
      "result " + (isError ? "result--error" : "result--ok");
  }

  /* ---- bridge ---------------------------------------------------------- */

  function callShell(method, args) {
    return new Promise(function (resolve, reject) {
      var requestId = PLUGIN_ID + "-" + ++seq + "-" + Date.now();
      pending[requestId] = { resolve: resolve, reject: reject };
      window.parent.postMessage(
        {
          source: PLUGIN_SOURCE,
          pluginId: PLUGIN_ID,
          requestId: requestId,
          serviceId: PLUGIN_ID,
          method: method,
          arguments: args || {},
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

  function bridgeCall(method, args) {
    return callShell(method, args).then(function (res) {
      if (res && res.status === "error") {
        throw new Error(res.error || "bridge error");
      }
      return res;
    });
  }

  /* ---- data ------------------------------------------------------------ */

  function loadAll() {
    setStatus("Loading…");
    return Promise.all([
      bridgeCall("getCatalog").then(function (r) {
        catalog = r || { skills: [], topics: [] };
      }),
      bridgeCall("getTopology").then(function (r) {
        topology = (r && r.peers) || [];
      }),
      bridgeCall("listPermissions").then(function (r) {
        var entries = (r && r.entries) || [];
        matrixByPeer = {};
        entries.forEach(function (e) {
          matrixByPeer[e.peerId] = e;
        });
      }),
    ])
      .then(function () {
        render();
        setStatus("Live");
      })
      .catch(function (err) {
        setStatus("Failed to load: " + err.message, true);
      });
  }

  /* ---- render ---------------------------------------------------------- */

  function trustLabel(state) {
    return {
      none: "No identity",
      discovered: "Discovered",
      pending: "Pending",
      verified: "Verified",
      blocked: "Blocked",
    }[state] || state;
  }

  function shortId(id) {
    if (!id) return "—";
    return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-6) : id;
  }

  function peerKey(peer) {
    return peer.peerId ? "peer:" + peer.peerId : "instance:" + peer.instanceId;
  }

  function render() {
    renderPeers();
    el.app.hidden = false;
    el.standalone.hidden = EMBEDDED;
  }

  function renderPeers() {
    el.peers.innerHTML = "";
    el.noPeers.hidden = topology.length > 0;
    topology.forEach(function (peer) {
      var tr = document.createElement("tr");
      var entry = peer.matrix;

      var name = document.createElement("td");
      name.textContent = peer.displayName || shortId(peer.peerId || peer.instanceId);
      name.className = "cell--name";

      var identity = document.createElement("td");
      identity.textContent = peer.peerIdVerified
        ? shortId(peer.peerId)
        : shortId(peer.instanceId);
      identity.title = peer.peerIdVerified
        ? "verified identity " + peer.peerId
        : "unverified instance " + peer.instanceId;

      var trust = document.createElement("td");
      var tag = document.createElement("span");
      tag.className = "tag tag--" + peer.trustState;
      tag.textContent = trustLabel(peer.trustState);
      trust.appendChild(tag);

      var subs = document.createElement("td");
      subs.textContent = String(peer.activeSubscriptions || 0);

      var perms = document.createElement("td");
      if (entry && entry.skills && entry.skills.length) {
        perms.textContent = entry.skills.length + " skill(s)";
        perms.title = entry.skills.join(", ");
      } else {
        perms.textContent = "default";
        perms.className = "cell--dim";
      }

      var actions = document.createElement("td");
      var editBtn = document.createElement("button");
      editBtn.className = "btn btn--small";
      editBtn.textContent = entry ? "Edit" : "Grant";
      editBtn.addEventListener("click", function () {
        openEditor(peer);
      });
      actions.appendChild(editBtn);
      if (peer.peerId && peer.trustState !== "blocked") {
        var verifyBtn = document.createElement("button");
        verifyBtn.className = "btn btn--small";
        verifyBtn.textContent = "Verify";
        verifyBtn.addEventListener("click", function () {
          verifyPeer(peer.peerId);
        });
        actions.appendChild(verifyBtn);
      }

      tr.appendChild(name);
      tr.appendChild(identity);
      tr.appendChild(trust);
      tr.appendChild(subs);
      tr.appendChild(perms);
      tr.appendChild(actions);
      el.peers.appendChild(tr);
    });
  }

  /* ---- editor ---------------------------------------------------------- */

  function openEditor(peer) {
    editingPeer = peer;
    editingVerified = Boolean(peer.peerIdVerified);
    el.editorPeerLabel.textContent =
      peer.displayName || shortId(peer.peerId || peer.instanceId);
    el.editorTrustTag.className = "tag tag--" + peer.trustState;
    el.editorTrustTag.textContent = trustLabel(peer.trustState);
    el.editorSection.hidden = false;

    var entry = peer.matrix || { skills: [], topics: [] };
    var selectedSkills = {};
    (entry.skills || []).forEach(function (s) {
      selectedSkills[s] = true;
    });
    var selectedTopics = {};
    (entry.topics || []).forEach(function (t) {
      selectedTopics[t] = true;
    });

    el.skillChecks.innerHTML = "";
    if (catalog.skills.length === 0) {
      el.skillChecks.textContent = "No network-exposed skills right now.";
    }
    catalog.skills.forEach(function (s) {
      el.skillChecks.appendChild(makeCheck("skill", s.skill, selectedSkills[s.skill], s.capabilityType));
    });

    el.topicChecks.innerHTML = "";
    if (catalog.topics.length === 0) {
      el.topicChecks.textContent = "No exposed event topics right now.";
    }
    catalog.topics.forEach(function (t) {
      el.topicChecks.appendChild(makeCheck("topic", t, selectedTopics[t], ""));
    });

    el.rateLimit.value =
      entry.customRateLimit === undefined ? "" : String(entry.customRateLimit);
    result("");
  }

  function makeCheck(kind, value, checked, hint) {
    var label = document.createElement("label");
    label.className = "check";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.kind = kind;
    input.dataset.value = value;
    input.checked = Boolean(checked);
    label.appendChild(input);
    var span = document.createElement("span");
    span.textContent = value;
    label.appendChild(span);
    if (hint) {
      var em = document.createElement("em");
      em.textContent = " · " + hint;
      label.appendChild(em);
    }
    return label;
  }

  function collectedSkills() {
    var out = [];
    el.skillChecks.querySelectorAll('input[data-kind="skill"]:checked').forEach(function (i) {
      out.push(i.dataset.value);
    });
    return out;
  }

  function collectedTopics() {
    var out = [];
    el.topicChecks.querySelectorAll('input[data-kind="topic"]:checked').forEach(function (i) {
      out.push(i.dataset.value);
    });
    return out;
  }

  /* ---- actions --------------------------------------------------------- */

  function verifyPeer(peerId) {
    result("Requesting verification…");
    bridgeCall("verifyPeer", { peerId: peerId })
      .then(function (r) {
        if (r && r.verified) {
          result("Verified.");
        } else {
          result("Verification failed: " + ((r && r.error) || "unknown"), true);
        }
        return loadAll();
      })
      .catch(function (err) {
        result("Verification denied: " + err.message, true);
      });
  }

  el.saveBtn.addEventListener("click", function () {
    if (!editingPeer) return;
    var skills = collectedSkills();
    var topics = collectedTopics();
    var rateRaw = el.rateLimit.value.trim();
    var body = { peerId: editingPeer.peerId, skills: skills, topics: topics };
    if (rateRaw !== "") {
      body.customRateLimit = Number(rateRaw);
    }
    if (isNaN(body.customRateLimit)) {
      result("customRateLimit must be a whole number or empty.", true);
      return;
    }
    result("Saving (confirm in the shell prompt)…");
    bridgeCall("registerSkills", body)
      .then(function () {
        result("Permissions saved.");
        return loadAll();
      })
      .catch(function (err) {
        result("Save denied: " + err.message, true);
      });
  });

  el.removeBtn.addEventListener("click", function () {
    if (!editingPeer || !editingPeer.peerId) return;
    result("Removing (confirm in the shell prompt)…");
    bridgeCall("removePermissions", { peerId: editingPeer.peerId })
      .then(function () {
        result("Entry cleared.");
        return loadAll();
      })
      .catch(function (err) {
        result("Remove denied: " + err.message, true);
      });
  });

  el.cancelBtn.addEventListener("click", function () {
    el.editorSection.hidden = true;
    editingPeer = null;
    result("");
  });

  /* ---- boot ------------------------------------------------------------ */

  if (!EMBEDDED) {
    document.getElementById("standalone").hidden = false;
    document.getElementById("app").hidden = true;
    setStatus("Standalone preview");
  } else {
    loadAll();
    setInterval(loadAll, 20000);
  }
})();
