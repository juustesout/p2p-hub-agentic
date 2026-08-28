/* SmartTasks frontend (SmartProjects v1.1).
 *
 * Talks to the platform exclusively through the postMessage bridge
 * (source "p2p-hub-plugin"), the same channel the desktop shell's
 * PluginBridge validates per-skill. The bridge calls resolve to the
 * `tasks.*` skills, which are httpBridgeOnly local-operator skills
 * registered by this plugin — the UI never holds the boot token and never
 * reaches the REST surface directly.
 *
 * Dependency auto-shift (Gantt) is a *proposal only*: the dashed bars are
 * never written to the store until the operator explicitly presses
 * "Apply proposal", which routes each changed task through `tasks.updateTask`
 * (subject to the server-side dependency guard).
 */
(function () {
  "use strict";

  var EMBEDDED = window.parent !== window;
  var SHELL_SOURCE = "p2p-hub-shell";
  var PLUGIN_SOURCE = "p2p-hub-plugin";
  var PLUGIN_ID = "tasks";
  var BRIDGE_TIMEOUT_MS = 30000;
  var DAY_MS = 86400000;

  var pending = {};
  var seq = 0;

  var projects = [];
  var current = null; // { id, root, tasks, capacity, criticalPath, proposal }

  var el = {
    status: document.getElementById("status"),
    app: document.getElementById("app"),
    standalone: document.getElementById("standalone"),
    newProjectName: document.getElementById("newProjectName"),
    newProjectForm: document.getElementById("newProjectForm"),
    projectList: document.getElementById("projectList"),
    noProjects: document.getElementById("noProjects"),
    project: document.getElementById("project"),
    projectName: document.getElementById("projectName"),
    capacityChips: document.getElementById("capacityChips"),
    criticalPathLine: document.getElementById("criticalPathLine"),
    capacityTable: document.getElementById("capacityTable").querySelector("tbody"),
    noCapacity: document.getElementById("noCapacity"),
    reloadBtn: document.getElementById("reloadBtn"),
    newTaskForm: document.getElementById("newTaskForm"),
    newTaskName: document.getElementById("newTaskName"),
    newTaskHours: document.getElementById("newTaskHours"),
    newTaskStart: document.getElementById("newTaskStart"),
    newTaskFinish: document.getElementById("newTaskFinish"),
    taskBoard: document.getElementById("taskBoard"),
    proposeBtn: document.getElementById("proposeBtn"),
    applyBtn: document.getElementById("applyBtn"),
    gantt: document.getElementById("gantt"),
    ganttNote: document.getElementById("ganttNote"),
    proposalSummary: document.getElementById("proposalSummary"),
  };

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.className = "status " + (isError ? "status--error" : "status--ok");
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

  function projectIdOf(doc) {
    return (doc && doc.root && doc.root.$id) || "";
  }

  function loadAll() {
    setStatus("Loading…");
    return bridgeCall("listProjects")
      .then(function (docs) {
        projects = Array.isArray(docs) ? docs : [];
        renderProjects();
        setStatus("Live");
      })
      .catch(function (err) {
        setStatus("Failed to load: " + err.message, true);
      });
  }

  function loadProject(id) {
    setStatus("Loading project…");
    return Promise.all([
      bridgeCall("getProject", { projectId: id }),
      bridgeCall("listTasks", { projectId: id }),
      bridgeCall("getCapacity", { projectId: id }),
      bridgeCall("getCriticalPath", { projectId: id }),
    ])
      .then(function (results) {
        var doc = results[0];
        if (!doc || !doc.root) {
          throw new Error("project not found");
        }
        current = {
          id: id,
          root: doc.root,
          tasks: Array.isArray(results[1]) ? results[1] : [],
          capacity: results[2] || { perPeer: [], overAllocation: [] },
          criticalPath: results[3] || { path: [], totalWeight: 0, criticalTaskIds: [] },
          proposal: null,
        };
        renderProject();
        setStatus("Live");
      })
      .catch(function (err) {
        setStatus("Failed to load project: " + err.message, true);
      });
  }

  /* ---- helpers --------------------------------------------------------- */

  function shortId(id) {
    if (!id) return "—";
    return id.length > 14 ? id.slice(0, 7) + "…" + id.slice(-5) : id;
  }

  function statusLabel(status) {
    return status || "todo";
  }

  function dateParse(value) {
    if (typeof value !== "string" || !value) return null;
    var ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  function dayOf(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, n) {
    return new Date(date.getTime() + n * DAY_MS);
  }

  function diffDays(a, b) {
    return Math.round((b - a) / DAY_MS);
  }

  /* ---- project list ---------------------------------------------------- */

  function renderProjects() {
    el.projectList.innerHTML = "";
    el.noProjects.hidden = projects.length > 0;
    projects.forEach(function (doc) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.className = "project-btn";
      btn.textContent = (doc.root && doc.root.name) || "Unnamed project";
      btn.title = projectIdOf(doc);
      btn.addEventListener("click", function () {
        loadProject(projectIdOf(doc));
      });
      li.appendChild(btn);
      el.projectList.appendChild(li);
    });
  }

  /* ---- project view ---------------------------------------------------- */

  function chip(label, cls) {
    var span = document.createElement("span");
    span.className = "chip" + (cls ? " " + cls : "");
    span.textContent = label;
    return span;
  }

  function renderProject() {
    el.projectName.textContent = current.root.name || "Unnamed project";
    el.capacityChips.innerHTML = "";
    var cap = current.capacity;
    el.capacityChips.appendChild(
      chip("Est. " + cap.totalEstimatedHours + "h", "chip--info"),
    );
    el.capacityChips.appendChild(
      chip("Spent " + cap.totalSpentHours + "h", "chip--info"),
    );
    var over = cap.overAllocation || [];
    if (over.length > 0) {
      el.capacityChips.appendChild(
        chip(over.length + " peer(s) over capacity", "chip--warn"),
      );
    } else {
      el.capacityChips.appendChild(chip("Capacity OK", "chip--ok"));
    }
    renderCriticalPath();
    renderCapacity();
    renderTasks();
    renderGantt();
    el.project.hidden = false;
    el.app.hidden = false;
  }

  function renderCriticalPath() {
    var cp = current.criticalPath;
    if (!cp.path || cp.path.length === 0) {
      el.criticalPathLine.textContent = "No tasks yet — nothing to schedule.";
      return;
    }
    var byId = {};
    current.tasks.forEach(function (t) {
      byId[t.$id] = t.name || t.$id;
    });
    el.criticalPathLine.textContent =
      "Critical path: " +
      cp.path.map(function (id) { return byId[id] || shortId(id); }).join(" → ") +
      "  (" + cp.totalWeight + " weighted days)";
  }

  function renderCapacity() {
    var rows = (current.capacity.perPeer || []);
    el.capacityTable.innerHTML = "";
    el.noCapacity.hidden = rows.length > 0;
    rows.forEach(function (p) {
      var tr = document.createElement("tr");
      if (p.overCapacity) tr.className = "row--warn";
      tr.appendChild(cell(shortId(p.peerId)));
      tr.appendChild(cell(String(p.estimatedHours)));
      tr.appendChild(cell(String(p.spentHours)));
      tr.appendChild(cell(String(p.workingDays)));
      tr.appendChild(cell(p.estimatedHoursPerDay.toFixed(1)));
      tr.appendChild(cell(p.overCapacity ? "Over 8h/day" : "OK"));
      el.capacityTable.appendChild(tr);
    });
  }

  function cell(text) {
    var td = document.createElement("td");
    td.textContent = text;
    return td;
  }

  /* ---- task board ------------------------------------------------------ */

  function delegationOf(task) {
    return task.delegation || null;
  }

  function renderTasks() {
    el.taskBoard.innerHTML = "";
    if (current.tasks.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No tasks yet. Add the first one above.";
      el.taskBoard.appendChild(empty);
      return;
    }
    var critical = {};
    (current.criticalPath.criticalTaskIds || []).forEach(function (id) {
      critical[id] = true;
    });
    current.tasks.forEach(function (task) {
      el.taskBoard.appendChild(taskCard(task, Boolean(critical[task.$id])));
    });
  }

  function taskCard(task, isCritical) {
    var card = document.createElement("article");
    card.className = "task" + (isCritical ? " task--critical" : "");

    var head = document.createElement("div");
    head.className = "task-head";

    var name = document.createElement("strong");
    name.textContent = task.name || "Unnamed task";
    name.title = task.$id;
    head.appendChild(name);

    var status = document.createElement("span");
    status.className = "tag tag--" + (task.status || "todo");
    status.textContent = statusLabel(task.status);
    head.appendChild(status);

    if (isCritical) {
      var crit = document.createElement("span");
      crit.className = "tag tag--critical";
      crit.textContent = "critical";
      head.appendChild(crit);
    }
    card.appendChild(head);

    var meta = document.createElement("div");
    meta.className = "task-meta";
    meta.appendChild(chip(shortId(task.$id), "chip--dim"));
    if (typeof task.estimatedHours === "number") {
      meta.appendChild(chip(task.estimatedHours + "h est", "chip--info"));
    }
    if (typeof task.durationDays === "number") {
      meta.appendChild(chip(task.durationDays + "d", "chip--info"));
    }
    card.appendChild(meta);

    var deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    if (deps.length > 0) {
      var depLine = document.createElement("div");
      depLine.className = "task-deps";
      depLine.appendChild(document.createTextNode("Depends on: "));
      deps.forEach(function (depId, i) {
        if (i > 0) depLine.appendChild(document.createTextNode(", "));
        var s = document.createElement("span");
        s.className = "dep-chip";
        s.textContent = shortId(depId);
        s.title = depId;
        depLine.appendChild(s);
      });
      card.appendChild(depLine);
    }

    var delegation = delegationOf(task);
    if (delegation) {
      var delLine = document.createElement("div");
      delLine.className = "task-delegation";
      delLine.appendChild(document.createTextNode("Delegated to " + shortId(delegation.assignedTo) + " — "));
      var dTag = document.createElement("span");
      dTag.className = "tag tag--" + delegation.status;
      dTag.textContent = delegation.status;
      delLine.appendChild(dTag);
      if (delegation.status === "declined" && delegation.declinedReason) {
        var reason = document.createElement("em");
        reason.textContent = ' "' + delegation.declinedReason + '"';
        delLine.appendChild(reason);
      }
      card.appendChild(delLine);
    }

    if (task.completionProof) {
      var proof = task.completionProof;
      var proofLine = document.createElement("div");
      proofLine.className = "task-proof";
      proofLine.appendChild(document.createTextNode(
        "Proof: " + shortId(proof.signedBy) + " @ " + proof.timestamp.slice(0, 19) + " (sig " + proof.signatureHex.slice(0, 12) + "…)",
      ));
      card.appendChild(proofLine);
    }

    var actions = document.createElement("div");
    actions.className = "task-actions";
    if (task.status !== "done") {
      actions.appendChild(actionBtn("Start", function () {
        setStatus("Starting task…");
        updateTaskStatus(task, "in-progress");
      }));
      actions.appendChild(actionBtn("Complete", function () {
        setStatus("Completing task…");
        updateTaskStatus(task, "done");
      }));
    }
    actions.appendChild(actionBtn("Set deps", function () {
      promptDependencies(task);
    }));
    actions.appendChild(actionBtn("Delegate", function () {
      promptDelegate(task);
    }));
    actions.appendChild(actionBtn("Assign", function () {
      promptAssign(task);
    }));
    card.appendChild(actions);

    return card;
  }

  function actionBtn(label, onClick) {
    var btn = document.createElement("button");
    btn.className = "btn btn--small";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function runSkill(promise) {
    return promise.catch(function (err) {
      setStatus("Action failed: " + err.message, true);
      throw err;
    });
  }

  function updateTaskStatus(task, status) {
    runSkill(
      bridgeCall("updateTask", {
        projectId: current.id,
        taskId: task.$id,
        status: status,
      }),
    ).then(function () {
      setStatus("Saved.");
      return loadProject(current.id);
    });
  }

  function promptDependencies(task) {
    var deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    var ids = current.tasks
      .filter(function (t) { return t.$id !== task.$id; })
      .map(function (t) { return t.name + " [" + t.$id + "]"; });
    var raw = prompt(
      "Set dependencies for \"" + (task.name || task.$id) + "\".\n" +
        "Comma-separated task IDs (see names below).\n\n" +
        "Available: " + (ids.join(", ") || "none"),
      deps.join(", "),
    );
    if (raw === null) return;
    var ids2 = raw
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    setStatus("Setting dependencies…");
    runSkill(
      bridgeCall("setDependencies", {
        projectId: current.id,
        taskId: task.$id,
        dependencyIds: ids2,
      }),
    ).then(function () {
      setStatus("Dependencies saved.");
      return loadProject(current.id);
    });
  }

  function promptDelegate(task) {
    var raw = prompt(
      'Delegate task "' + (task.name || task.$id) + '" to peerId:',
      "",
    );
    if (raw === null) return;
    var peerId = raw.trim();
    if (!peerId) {
      setStatus("Delegation needs a non-empty peerId.", true);
      return;
    }
    setStatus("Delegating…");
    runSkill(
      bridgeCall("delegateTask", {
        projectId: current.id,
        taskId: task.$id,
        peerId: peerId,
      }),
    ).then(function () {
      setStatus("Delegated (pending acceptance by the peer).");
      return loadProject(current.id);
    });
  }

  function promptAssign(task) {
    var raw = prompt(
      'Assign a contact resource to task "' + (task.name || task.$id) + '":\n' +
        "Enter the contact's peerId (must exist in the contacts plugin).",
      "",
    );
    if (raw === null) return;
    var peerId = raw.trim();
    if (!peerId) {
      setStatus("Assignment needs a non-empty peerId.", true);
      return;
    }
    setStatus("Assigning resource…");
    runSkill(
      bridgeCall("assignResource", {
        projectId: current.id,
        taskId: task.$id,
        contactPeerId: peerId,
      }),
    ).then(function () {
      setStatus("Resource assigned.");
      return loadProject(current.id);
    });
  }

  /* ---- gantt + auto-shift proposal ------------------------------------ */

  function topoOrder(tasks) {
    var byId = {};
    tasks.forEach(function (t) { byId[t.$id] = t; });
    var placed = new Set();
    var out = [];
    var maxIters = tasks.length * tasks.length + 1;
    var iters = 0;
    while (out.length < tasks.length && iters < maxIters) {
      iters += 1;
      var progressed = false;
      tasks.forEach(function (t) {
        if (placed.has(t.$id)) return;
        var deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        var ready = deps.every(function (d) { return !byId[d] || placed.has(d); });
        if (ready) {
          placed.add(t.$id);
          out.push(t);
          progressed = true;
        }
      });
      if (!progressed) {
        // Cycle guard: place the remaining in input order.
        tasks.forEach(function (t) {
          if (!placed.has(t.$id)) {
            placed.add(t.$id);
            out.push(t);
          }
        });
        break;
      }
    }
    return out;
  }

  function ganttRange() {
    var min = null;
    var max = null;
    current.tasks.forEach(function (t) {
      var s = dateParse(t.start);
      var f = dateParse(t.finish);
      if (s && (!min || s < min)) min = s;
      if (f && (!max || f > max)) max = f;
    });
    return { min: min, max: max };
  }

  function taskDurationDays(task) {
    if (typeof task.durationDays === "number" && task.durationDays > 0) {
      return task.durationDays;
    }
    var s = dateParse(task.start);
    var f = dateParse(task.finish);
    if (s && f) {
      return Math.max(1, diffDays(s, f) + 1);
    }
    return 1;
  }

  function renderGantt() {
    el.gantt.innerHTML = "";
    el.proposalSummary.textContent = "";
    el.applyBtn.disabled = true;
    current.proposal = null;

    var range = ganttRange();
    if (!range.min || !range.max) {
      el.ganttNote.textContent =
        "Give tasks start/finish dates (or durationDays) to see the Gantt.";
      return;
    }
    el.ganttNote.textContent = "";
    var totalDays = Math.max(1, diffDays(range.min, range.max) + 1);

    var ordered = topoOrder(current.tasks);
    var critical = {};
    (current.criticalPath.criticalTaskIds || []).forEach(function (id) {
      critical[id] = true;
    });

    var grid = document.createElement("div");
    grid.className = "gantt-grid";
    grid.style.setProperty("--cols", String(totalDays));

    var labels = document.createElement("div");
    labels.className = "gantt-labels";

    ordered.forEach(function (task) {
      var s = dateParse(task.start);
      var f = dateParse(task.finish);
      var label = document.createElement("div");
      label.className = "gantt-label" + (critical[task.$id] ? " label--critical" : "");
      label.textContent = (task.name || shortId(task.$id)) +
        (typeof task.estimatedHours === "number" ? " (" + task.estimatedHours + "h)" : "");
      label.title = task.$id;
      labels.appendChild(label);

      var row = document.createElement("div");
      row.className = "gantt-row" + (critical[task.$id] ? " row--critical" : "");

      if (s && f) {
        var startCol = diffDays(range.min, s);
        var width = Math.max(1, diffDays(s, f) + 1);
        var bar = document.createElement("div");
        bar.className = "gantt-bar" + (critical[task.$id] ? " bar--critical" : "");
        bar.style.gridColumnStart = String(startCol + 1);
        bar.style.gridColumnEnd = String(startCol + 1 + width);
        row.appendChild(bar);

        if (current.proposal && current.proposal[task.$id]) {
          var p = current.proposal[task.$id];
          var pStartCol = diffDays(range.min, dateParse(p.start));
          var pWidth = Math.max(1, diffDays(dateParse(p.start), dateParse(p.finish)) + 1);
          var pBar = document.createElement("div");
          pBar.className = "gantt-bar gantt-bar--proposal";
          pBar.style.gridColumnStart = String(pStartCol + 1);
          pBar.style.gridColumnEnd = String(pStartCol + 1 + pWidth);
          pBar.title = "proposed " + p.start + " → " + p.finish;
          row.appendChild(pBar);
        }
      } else {
        var note = document.createElement("div");
        note.className = "gantt-note";
        note.textContent = "no dates";
        row.appendChild(note);
      }
      grid.appendChild(row);
    });

    el.gantt.appendChild(labels);
    el.gantt.appendChild(grid);
  }

  function buildProposal() {
    var byId = {};
    current.tasks.forEach(function (t) { byId[t.$id] = t; });
    var ordered = topoOrder(current.tasks);
    var proposed = {};
    var changed = 0;

    ordered.forEach(function (task) {
      var deps = (Array.isArray(task.dependencies) ? task.dependencies : [])
        .filter(function (d) { return byId[d]; });
      var currentStart = dateParse(task.start);
      if (!currentStart || deps.length === 0) return;
      var maxDepEnd = null;
      deps.forEach(function (d) {
        var dep = byId[d];
        var depEnd = proposed[d]
          ? dateParse(proposed[d].finish)
          : dateParse(dep.finish) || dateParse(dep.start);
        if (depEnd && (!maxDepEnd || depEnd > maxDepEnd)) maxDepEnd = depEnd;
      });
      if (!maxDepEnd) return;
      var latestStart = addDays(maxDepEnd, 1);
      if (latestStart <= currentStart) return;
      var duration = taskDurationDays(task);
      var proposedFinish = addDays(latestStart, duration - 1);
      proposed[task.$id] = { start: dayOf(latestStart), finish: dayOf(proposedFinish) };
      changed += 1;
    });

    current.proposal = proposed;
    return changed;
  }

  el.proposeBtn.addEventListener("click", function () {
    if (!current) return;
    var changed = buildProposal();
    if (changed === 0) {
      el.proposalSummary.textContent =
        "No auto-shift proposed: every dated task already starts after its dependencies finish.";
      el.applyBtn.disabled = true;
    } else {
      el.proposalSummary.textContent =
        changed + " task(s) proposed to shift (dashed bars). Review, then press Apply proposal to write them.";
      el.applyBtn.disabled = false;
    }
    renderGantt();
  });

  el.applyBtn.addEventListener("click", function () {
    if (!current || !current.proposal) return;
    var entries = Object.keys(current.proposal).map(function (id) {
      return { taskId: id, proposal: current.proposal[id] };
    });
    if (entries.length === 0) return;
    setStatus("Applying proposal…");
    var chain = Promise.resolve();
    entries.forEach(function (entry) {
      chain = chain.then(function () {
        return bridgeCall("updateTask", {
          projectId: current.id,
          taskId: entry.taskId,
          start: entry.proposal.start,
          finish: entry.proposal.finish,
        });
      });
    });
    chain
      .then(function () {
        setStatus("Proposal applied.");
        current.proposal = null;
        return loadProject(current.id);
      })
      .catch(function (err) {
        setStatus("Apply failed (a dependency guard may have refused): " + err.message, true);
      });
  });

  /* ---- create project / task ------------------------------------------ */

  el.newProjectForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var name = el.newProjectName.value.trim();
    if (!name) {
      setStatus("Project name must not be empty.", true);
      return;
    }
    setStatus("Creating project…");
    bridgeCall("createProject", { name: name })
      .then(function () {
        el.newProjectName.value = "";
        setStatus("Project created.");
        return loadAll();
      })
      .catch(function (err) {
        setStatus("Create failed: " + err.message, true);
      });
  });

  el.newTaskForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!current) return;
    var name = el.newTaskName.value.trim();
    if (!name) {
      setStatus("Task name must not be empty.", true);
      return;
    }
    var payload = { projectId: current.id, name: name };
    var hours = parseFloat(el.newTaskHours.value);
    if (el.newTaskHours.value !== "" && !Number.isNaN(hours) && hours >= 0) {
      payload.estimatedHours = hours;
    }
    if (el.newTaskStart.value) payload.start = el.newTaskStart.value;
    if (el.newTaskFinish.value) payload.finish = el.newTaskFinish.value;
    setStatus("Adding task…");
    bridgeCall("addTask", payload)
      .then(function () {
        el.newTaskName.value = "";
        el.newTaskHours.value = "";
        el.newTaskStart.value = "";
        el.newTaskFinish.value = "";
        setStatus("Task added.");
        return loadProject(current.id);
      })
      .catch(function (err) {
        setStatus("Add failed: " + err.message, true);
      });
  });

  el.reloadBtn.addEventListener("click", function () {
    if (current) loadProject(current.id);
  });

  /* ---- boot ------------------------------------------------------------ */

  if (!EMBEDDED) {
    el.standalone.hidden = false;
    el.app.hidden = true;
    setStatus("Standalone preview");
  } else {
    loadAll();
    setInterval(loadAll, 30000);
  }
})();
