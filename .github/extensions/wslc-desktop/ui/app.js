    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const contentEl = document.getElementById("content");
    const loadingEl = document.getElementById("loading");
    const containerFilterEl = document.getElementById("containerFilter");
    const instanceIdEl = document.getElementById("instanceId");
    const sidebar = document.querySelector(".sidebar");
        const bootstrapEl = document.getElementById("wslc-bootstrap");
    let bootstrap = {};
    try {
      bootstrap = bootstrapEl ? JSON.parse(bootstrapEl.textContent || "{}") : {};
    } catch {
      bootstrap = {};
    }
    const initialContainerFilter = String(bootstrap.initialContainerFilter ?? "");
    const initialDetail = bootstrap.initialDetail ?? null;
    if (instanceIdEl) {
      instanceIdEl.textContent = String(bootstrap.instanceId ?? "-");
    }
    let currentSection = "containers";
    let imagesSubView = "local";
    let currentState = null;
    let containerFilterText = initialContainerFilter;
    let detailContainerId = null;
    let detailTab = "logs";
    let detailData = { logs: null, inspect: null, stats: null };
    let detailLoading = false;
    let lastNavigationNonce = 0;
    let dockerHubQuery = "";
    let dockerHubResults = [];
    let assistantResponse = { containers: "", run: "" };
    let runDraft = { image: "", name: "", ports: "" };
    let busy = false;

    function escHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function table(headers, rows, tableClass = "") {
      const thead = headers.map((h) => "<th>" + escHtml(h) + "</th>").join("");
      const body = rows.length
        ? rows.map((row) => "<tr>" + row.map((cell) => "<td>" + cell + "</td>").join("") + "</tr>").join("")
        : '<tr><td colspan="' + headers.length + '" class="muted">No items found</td></tr>';
      return '<table class="' + escHtml(tableClass) + '"><thead><tr>' + thead + "</tr></thead><tbody>" + body + "</tbody></table>";
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || ("HTTP " + response.status));
      }
      return response.json();
    }

    async function runContainerAction(containerName, action) {
      if (busy) return;
      busy = true;
      try {
        const state = await api("/api/containers/" + encodeURIComponent(containerName) + "/" + action, { method: "POST" });
        applyState(state);
        if (detailContainerId && action !== "remove") {
          detailData = { logs: null, inspect: null, stats: null };
          loadDetailTab(detailTab);
        } else if (detailContainerId && action === "remove") {
          detailContainerId = null;
          renderCurrentSection();
        }
      } catch (error) {
        errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>";
        await loadState();
      } finally {
        busy = false;
      }
    }

    async function searchHub(query) {
      dockerHubQuery = String(query ?? "").trim();
      if (!dockerHubQuery) {
        dockerHubResults = [];
        renderCurrentSection();
        return;
      }
      try {
        dockerHubResults = await api("/api/dockerhub/search?q=" + encodeURIComponent(dockerHubQuery));
      } catch (error) {
        dockerHubResults = [];
        errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>";
      }
      renderCurrentSection();
    }

    function assistantAnswer(section, question) {
      const q = String(question ?? "").toLowerCase().trim();
      if (!q) {
        return "Ask about status, ports, create/run options, or troubleshooting.";
      }
      if (section === "containers") {
        const running = currentState ? currentState.containers.filter((c) => Number(c.state) === 2) : [];
        if (q.includes("running")) {
          return "Running containers: " + running.length + ". " + running.map((c) => c.name).join(", ");
        }
        if (q.includes("port")) {
          const withPorts = currentState ? currentState.containers.filter((c) => Array.isArray(c.portMappings) && c.portMappings.length) : [];
          if (!withPorts.length) return "No mapped ports found.";
          return withPorts.map((c) => c.name + ": " + c.portMappings.map((p) => p.display + (p.url ? " (" + p.url + ")" : "")).join(", ")).join("\\n");
        }
        if (q.includes("remove")) {
          return "Remove is enabled only for stopped containers. Stop first, then remove.";
        }
        return "Try asking: 'which containers are running?', 'which ports are exposed?', or 'why is remove disabled?'.";
      }
      if (q.includes("port")) {
        return "Use ports format host:container. Examples: 8080:80 or 8081:3000,9090:90";
      }
      if (q.includes("name")) {
        return "Container name is optional. If empty, WSLC assigns one automatically.";
      }
      if (q.includes("image")) {
        return "Image must be repository[:tag]. Example: nginx:latest or redis:7.";
      }
      return "Try asking: 'how do I map ports?', 'is name required?', or 'what image format should I use?'.";
    }

    function assistantTemplate(section) {
      const response = assistantResponse[section] || "";
      return '<div class="assistant-box">' +
        '<div class="assistant-title">💬 Assistant</div>' +
        '<div class="section-toolbar">' +
          '<input class="filter-input" id="assistantInput-' + section + '" type="text" placeholder="Ask for help in this section" />' +
          '<button class="btn-primary icon-only" title="Ask assistant" aria-label="Ask assistant" data-assistant-ask="' + section + '">❔</button>' +
        '</div>' +
        (response ? '<div class="assistant-response">' + escHtml(response) + '</div>' : '') +
      '</div>';
    }

    function sectionTemplate(title, tableHtml) {
      return "<section><h2>" + escHtml(title) + "</h2>" + tableHtml + "</section>";
    }

    function isImageAlreadyPulled(repositoryName) {
      const repo = String(repositoryName ?? "").toLowerCase();
      if (!repo || !currentState || !Array.isArray(currentState.images)) {
        return false;
      }
      const fallbackRepo = repo.startsWith("library/") ? repo.slice("library/".length) : null;
      const candidates = currentState.images.map((image) => String(image.name ?? "").toLowerCase());
      return candidates.some((name) => {
        if (!name || name === "<none>") {
          return false;
        }
        if (name === repo || name.startsWith(repo + ":")) {
          return true;
        }
        if (fallbackRepo && (name === fallbackRepo || name.startsWith(fallbackRepo + ":"))) {
          return true;
        }
        return false;
      });
    }

    function setLoading(message) {
      if (!message) {
        loadingEl.textContent = "";
        loadingEl.classList.remove("visible");
        return;
      }
      loadingEl.textContent = message;
      loadingEl.classList.add("visible");
    }

    function findDetailContainer() {
      if (!currentState || !detailContainerId) return null;
      return currentState.containers.find(
        (c) => (c.id && c.id === detailContainerId) || (c.name && c.name === detailContainerId)
      ) || null;
    }

    async function loadDetailTab(tab) {
      if (!detailContainerId) return;
      detailLoading = true;
      renderCurrentSection();
      try {
        const res = await fetch("/api/containers/" + encodeURIComponent(detailContainerId) + "/" + tab);
        const data = await res.json();
        if (tab === "stats") {
          detailData.stats = data.stats || (data.error ? { __error: data.error } : null);
        } else {
          detailData[tab] = data.output != null ? String(data.output) : "";
        }
      } catch (err) {
        if (tab === "stats") {
          detailData.stats = { __error: String(err) };
        } else {
          detailData[tab] = "Error: " + String(err);
        }
      } finally {
        detailLoading = false;
        renderCurrentSection();
      }
    }

    async function sendCurrentToChat(btn) {
      if (!detailContainerId) return;
      const c = findDetailContainer();
      const selection = String(window.getSelection ? window.getSelection() : "").trim();
      const hasSelection = selection.length > 0;
      let text = selection;
      if (!text) {
        if (detailTab === "stats") {
          text = detailData.stats && !detailData.stats.__error ? JSON.stringify(detailData.stats, null, 2) : "";
        } else {
          text = detailData[detailTab] || "";
        }
      }
      if (!text.trim()) {
        errorEl.innerHTML = '<div class="error">Nothing to send yet — the view is still loading or empty.</div>';
        return;
      }
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        await fetch("/api/send-to-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            container: (c && (c.name || c.id)) || detailContainerId,
            tab: detailTab,
            text: text,
            hasSelection: hasSelection,
          }),
        });
        btn.textContent = "✓ Attached";
      } catch (err) {
        btn.textContent = "Failed";
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1600);
      }
    }

    function renderContainerDetail() {
      const c = findDetailContainer();
      if (!c) {
        detailContainerId = null;
        renderCurrentSection();
        return;
      }
      const isRunning = Number(c.state) === 2;
      const shortId = String(c.id || "").slice(0, 12);
      const name = escHtml(c.name || c.id || "");
      const target = escHtml(c.id || c.name);
      const startDisabled = isRunning ? "disabled" : "";
      const stopDisabled = isRunning ? "" : "disabled";
      const restartDisabled = isRunning ? "" : "disabled";
      const removeDisabled = isRunning ? "disabled" : "";
      const statusClass = isRunning ? "status-badge running" : "status-badge stopped";

      const tabs = ["logs", "inspect", "stats"];
      const tabLabels = { logs: "Logs", inspect: "Inspect", stats: "Stats" };
      const tabsHtml = tabs.map((t) =>
        '<button class="detail-tab ' + (detailTab === t ? "active" : "") + '" data-detail-tab="' + t + '">' + tabLabels[t] + '</button>'
      ).join("");

      let body = "";
      if (detailLoading) {
        body = '<div class="detail-loading">Loading…</div>';
      } else if (detailTab === "stats") {
        const s = detailData.stats;
        if (!s) {
          body = '<div class="muted">No stats available.</div>';
        } else if (s.__error) {
          body = '<div class="muted">' + escHtml(s.__error || "Stats unavailable") + '</div>';
        } else {
          const rows = [
            ["CPU", s.CPUPerc], ["Memory", s.MemUsage], ["Mem %", s.MemPerc],
            ["Net I/O", s.NetIO], ["Block I/O", s.BlockIO], ["PIDs", s.PIDs],
          ];
          body = '<div class="stats-grid">' + rows.map((r) =>
            '<div class="stat-card"><div class="stat-label">' + escHtml(r[0]) + '</div><div class="stat-value">' + escHtml(r[1] != null ? String(r[1]) : "-") + '</div></div>'
          ).join("") + '</div>';
        }
      } else {
        const content = detailData[detailTab];
        if (content == null) {
          body = '<div class="muted">No data.</div>';
        } else {
          body = '<pre class="detail-pre">' + escHtml(content || "(empty)") + '</pre>';
        }
      }

      const portsHtml = Array.isArray(c.portMappings) && c.portMappings.length
        ? c.portMappings.map((p) => p.url
            ? '<button class="port-link-btn" data-link="' + escHtml(p.url) + '">' + escHtml(p.display) + '</button>'
            : '<span>' + escHtml(p.display) + '</span>').join(" ")
        : '<span class="muted">-</span>';

      contentEl.innerHTML =
        '<div class="detail-view">' +
          '<div class="breadcrumb"><button class="crumb-link" data-detail-back>Containers</button> / <span>' + name + '</span></div>' +
          '<div class="detail-header">' +
            '<div class="detail-heading">' +
              '<h2 class="detail-name">' + name + '</h2>' +
              '<div class="detail-meta">' +
                '<code class="short-id">' + escHtml(shortId) + '</code>' +
                '<button class="copy-btn" data-copy-id="' + escHtml(c.id || "") + '" title="Copy full ID" aria-label="Copy full ID">⧉</button>' +
                '<span class="detail-image truncate" title="' + escHtml(c.image) + '">' + escHtml(c.image) + '</span>' +
                '<span class="' + statusClass + '">' + escHtml(c.status || (isRunning ? "Running" : "Stopped")) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="detail-actions">' +
              '<button class="btn-success icon-only" title="Start" aria-label="Start" data-action="start" data-container="' + target + '" ' + startDisabled + '>▶</button>' +
              '<button class="btn-warning icon-only" title="Stop" aria-label="Stop" data-action="stop" data-container="' + target + '" ' + stopDisabled + '>⏹</button>' +
              '<button class="btn-info icon-only" title="Restart" aria-label="Restart" data-action="restart" data-container="' + target + '" ' + restartDisabled + '>↻</button>' +
              '<button class="btn-danger icon-only" title="Remove" aria-label="Remove" data-action="remove" data-container="' + target + '" ' + removeDisabled + '>🗑</button>' +
            '</div>' +
          '</div>' +
          '<div class="detail-ports">Ports: ' + portsHtml + '</div>' +
          '<div class="detail-tabs-bar">' +
            '<div class="detail-tabs">' + tabsHtml + '</div>' +
            '<button class="send-chat-btn" data-send-chat title="Attach your text selection (or the whole current tab) to the chat composer so you can add a message before sending">📎 Attach to chat</button>' +
          '</div>' +
          '<p class="send-hint">Tip: select text in the panel below and click “Attach to chat” to attach just that selection to the composer. With nothing selected, the whole ' + escHtml(detailTab) + ' view is attached. It shows up as a pill so you can add your own message before sending.</p>' +
          '<div class="detail-body">' + body + '</div>' +
        '</div>';
    }

    function renderCurrentSection() {
      if (!currentState) {
        contentEl.innerHTML = "";
        return;
      }
      containerFilterEl.style.display = currentSection === "containers" ? "inline-block" : "none";
      if (currentSection === "containers") {
        if (detailContainerId) {
          renderContainerDetail();
          return;
        }
        const query = containerFilterText.trim().toLowerCase();
        const filteredContainers = query
          ? currentState.containers.filter((c) =>
              String(c.name ?? "").toLowerCase().includes(query) ||
              String(c.id ?? "").toLowerCase().includes(query)
            )
          : currentState.containers;
        const containersRows = filteredContainers.map((c) => {
          const target = escHtml(c.id || c.name);
          const isRunning = Number(c.state) === 2;
          const startDisabled = isRunning ? "disabled" : "";
          const stopDisabled = isRunning ? "" : "disabled";
          const removeDisabled = isRunning ? "disabled" : "";
          const portsHtml = Array.isArray(c.portMappings) && c.portMappings.length
            ? '<div class="port-links">' + c.portMappings.map((p) => {
                if (p.url) {
                  return '<button class="port-link-btn" data-link="' + escHtml(p.url) + '">' + escHtml(p.display) + '</button>';
                }
                return '<span>' + escHtml(p.display) + '</span>';
              }).join("") + '</div>'
            : '<span class="muted">-</span>';
          const actions = '<div class="row-actions">' +
            '<button class="btn-success icon-only" title="Start container" aria-label="Start container" data-action="start" data-container="' + target + '" ' + startDisabled + '>▶</button>' +
            '<button class="btn-warning icon-only" title="Stop container" aria-label="Stop container" data-action="stop" data-container="' + target + '" ' + stopDisabled + '>⏹</button>' +
            '<button class="btn-danger icon-only" title="Remove container" aria-label="Remove container" data-action="remove" data-container="' + target + '" ' + removeDisabled + '>🗑</button>' +
            '</div>';
          return [
            '<button class="cell-link truncate" title="' + escHtml(c.name) + '" data-container-detail="' + target + '">' + escHtml(c.name) + '</button>',
            '<span class="truncate" title="' + escHtml(c.image) + '">' + escHtml(c.image) + '</span>',
            escHtml(c.status),
            portsHtml,
            actions
          ];
        });
        contentEl.innerHTML = sectionTemplate(
          "Containers",
          table(["Name", "Image", "Status", "Ports", "Actions"], containersRows, "containers-table")
        );
        return;
      }
      if (currentSection === "images") {
        const rows = currentState.images.map((i) => [
          '<span class="truncate" title="' + escHtml(i.name) + '">' + escHtml(i.name) + '</span>',
          '<span class="truncate" title="' + escHtml(i.id) + '">' + escHtml(i.id) + '</span>',
          escHtml(i.size),
          '<span class="truncate" title="' + escHtml(i.created) + '">' + escHtml(i.created) + '</span>',
        ]);
        const hubRows = dockerHubResults.map((item) => {
          const alreadyPulled = isImageAlreadyPulled(item.name);
          const pullButton = alreadyPulled
            ? '<button class="btn-success icon-only" disabled title="Already available locally" aria-label="Already available locally">✔</button>'
            : '<button class="btn-success icon-only" title="Pull image" aria-label="Pull image" data-image-pull="' + escHtml(item.name) + '">⬇</button>';
          return [
          '<span class="truncate" title="' + escHtml(item.name) + '">' + escHtml(item.name) + '</span>',
          '<span class="truncate" title="' + escHtml(item.shortDescription) + '">' + escHtml(item.shortDescription || "-") + '</span>',
          escHtml(String(item.stars)),
          escHtml(String(item.pulls)),
          '<div class="row-actions">' +
            pullButton +
            '<button class="btn-primary icon-only" title="Run image" aria-label="Run image" data-image-run="' + escHtml(item.name) + '">🚀</button>' +
          '</div>'
          ];
        });
        if (imagesSubView === "local") {
          contentEl.innerHTML = sectionTemplate(
            "Images",
            '<div class="section-toolbar">' +
              '<span class="muted">Local images on WSLC</span>' +
              '<span style="flex:1"></span>' +
                '<button class="btn-primary icon-only" title="Search in Docker Hub" aria-label="Search in Docker Hub" data-images-open-search>🔎</button>' +
            '</div>' +
              table(["Image", "ID", "Size", "Created"], rows, "images-table")
          );
          return;
        }

        contentEl.innerHTML = sectionTemplate(
          "Image Search",
          '<div class="section-toolbar">' +
            '<span class="muted">Search and run images from Docker Hub</span>' +
            '<span style="flex:1"></span>' +
            '<button class="icon-only" title="Back to local images" aria-label="Back to local images" data-images-back-local>←</button>' +
          '</div>' +
          '<div class="section-toolbar">' +
            '<input id="hubQueryInput" class="filter-input" type="search" value="' + escHtml(dockerHubQuery) + '" placeholder="Search Docker Hub repositories" />' +
            '<button class="btn-primary icon-only" title="Search" aria-label="Search" data-hub-search>🔎</button>' +
          '</div>' +
          '<div class="card"><h3>Docker Hub results</h3>' + table(["Repository", "Description", "Stars", "Pulls", "Actions"], hubRows, "hub-table") + '</div>' +
          (runDraft.image
            ? '<div class="card"><h3>Run selected image</h3>' +
              '<div class="section-toolbar"><input id="runImageInput" class="filter-input" type="text" placeholder="Image (e.g. nginx:latest)" value="' + escHtml(runDraft.image) + '" /></div>' +
              '<div class="section-toolbar"><input id="runNameInput" class="filter-input" type="text" placeholder="Container name (optional)" value="' + escHtml(runDraft.name) + '" /></div>' +
              '<div class="section-toolbar"><input id="runPortsInput" class="filter-input" type="text" placeholder="Ports host:container, comma separated (optional)" value="' + escHtml(runDraft.ports) + '" /></div>' +
              '<button class="btn-success icon-only" title="Create container" aria-label="Create container" data-run-create>🚀</button>' +
              assistantTemplate("run") +
            '</div>'
            : '')
        );
        return;
      }
      if (currentSection === "volumes") {
        const rows = currentState.volumes.map((v) => [escHtml(v.name), escHtml(v.driver)]);
        contentEl.innerHTML = sectionTemplate(
          "Volumes",
          '<div class="section-toolbar">' +
            '<input id="newVolumeName" class="filter-input" type="text" placeholder="New volume name" />' +
            '<button class="btn-primary icon-only" title="Create volume" aria-label="Create volume" data-volume-create>➕</button>' +
          '</div>' +
          table(["Name", "Driver"], rows)
        );
        return;
      }
      if (currentSection === "networks") {
        const rows = currentState.networks.map((n) => [escHtml(n.name), escHtml(n.driver), escHtml(n.scope)]);
        contentEl.innerHTML = sectionTemplate(
          "Networks",
          '<div class="section-toolbar">' +
            '<input id="newNetworkName" class="filter-input" type="text" placeholder="New network name" />' +
            '<button class="btn-primary icon-only" title="Create network" aria-label="Create network" data-network-create>➕</button>' +
          '</div>' +
          table(["Name", "Driver", "Scope"], rows)
        );
        return;
      }
      contentEl.innerHTML = "";
    }

    function updateSidebarCounts(state) {
      document.getElementById("count-containers").textContent = String(state.containers.length);
      document.getElementById("count-images").textContent = String(state.images.length);
      document.getElementById("count-volumes").textContent = String(state.volumes.length);
      document.getElementById("count-networks").textContent = String(state.networks.length);
    }

    function formatRelativeElapsed(isoDate) {
      const ts = new Date(isoDate).getTime();
      if (!Number.isFinite(ts)) return "just now";
      const totalSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const parts = [];
      if (hours > 0) parts.push(hours + "h");
      if (minutes > 0 || hours > 0) parts.push(minutes + "m");
      parts.push(seconds + "s");
      return parts.join(" ");
    }

    function applyState(state) {
      currentState = state;
      const updated = formatRelativeElapsed(state.updatedAt);
      statusEl.textContent = "Running containers: " + state.summary.running + " / " + state.summary.total + " · Updated " + updated + " ago";
      errorEl.innerHTML = state.available ? "" : '<div class="error">' + escHtml(state.error || "wslc unavailable") + "</div>";
      updateSidebarCounts(state);
      renderCurrentSection();
    }

    async function loadState() {
      const state = await api("/api/state");
      applyState(state);
    }

    function resolveContainerMatch(rawQuery) {
      if (!currentState) return null;
      const req = String(rawQuery ?? "").trim().toLowerCase();
      if (!req) return null;
      const list = currentState.containers;
      return (
        list.find((c) => String(c.name || "").toLowerCase() === req || String(c.id || "").toLowerCase() === req) ||
        list.find((c) => String(c.id || "").toLowerCase().startsWith(req)) ||
        list.find((c) => String(c.name || "").toLowerCase().includes(req)) ||
        null
      );
    }

    function openContainerDetail(rawQuery, rawTab) {
      const match = resolveContainerMatch(rawQuery);
      if (!match) return false;
      const requestedFilter = String(rawQuery ?? "").trim();
      containerFilterText = requestedFilter;
      if (containerFilterEl) {
        containerFilterEl.value = requestedFilter;
      }
      currentSection = "containers";
      for (const item of sidebar.querySelectorAll("button[data-section]")) {
        item.classList.toggle("active", item.getAttribute("data-section") === "containers");
      }
      detailContainerId = match.id || match.name;
      detailTab = ["logs", "inspect", "stats"].includes(String(rawTab ?? "")) ? String(rawTab) : "logs";
      detailData = { logs: null, inspect: null, stats: null };
      renderCurrentSection();
      loadDetailTab(detailTab);
      return true;
    }

    async function pollNavigationIntent() {
      try {
        const payload = await api("/api/navigation-intent");
        const intent = payload?.intent;
        if (!intent || !intent.container) return;
        const nonce = Number(intent.nonce || 0);
        if (nonce && nonce <= lastNavigationNonce) return;
        if (nonce) lastNavigationNonce = nonce;
        if (!currentState) {
          await loadState();
        }
        if (!openContainerDetail(intent.container, intent.tab)) {
          await loadState();
          openContainerDetail(intent.container, intent.tab);
        }
      } catch {
        // best-effort poll
      }
    }

    containerFilterEl.addEventListener("input", (event) => {
      containerFilterText = event.target.value ?? "";
      renderCurrentSection();
    });
    sidebar.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-section]");
      if (!button) return;
      const nextSection = button.getAttribute("data-section");
      if (nextSection === "images" && currentSection !== "images") {
        imagesSubView = "local";
      }
      currentSection = nextSection;
      for (const item of sidebar.querySelectorAll("button[data-section]")) {
        item.classList.toggle("active", item === button);
      }
      renderCurrentSection();
    });
    contentEl.addEventListener("click", (event) => {
      const linkButton = event.target.closest("button[data-link]");
      if (linkButton) {
        const link = linkButton.getAttribute("data-link");
        if (link) {
          window.open(link, "_blank", "noopener,noreferrer");
        }
        return;
      }
      const detailLink = event.target.closest("button[data-container-detail]");
      if (detailLink) {
        detailContainerId = detailLink.getAttribute("data-container-detail");
        detailTab = "logs";
        detailData = { logs: null, inspect: null, stats: null };
        renderCurrentSection();
        loadDetailTab("logs");
        return;
      }
      if (event.target.closest("button[data-detail-back]")) {
        detailContainerId = null;
        renderCurrentSection();
        return;
      }
      const tabBtn = event.target.closest("button[data-detail-tab]");
      if (tabBtn) {
        detailTab = tabBtn.getAttribute("data-detail-tab");
        if (detailData[detailTab] == null && !(detailTab === "stats" && detailData.stats)) {
          loadDetailTab(detailTab);
        } else {
          renderCurrentSection();
        }
        return;
      }
      const sendChatBtn = event.target.closest("button[data-send-chat]");
      if (sendChatBtn) {
        sendCurrentToChat(sendChatBtn);
        return;
      }
      const copyBtn = event.target.closest("button[data-copy-id]");
      if (copyBtn) {
        const id = copyBtn.getAttribute("data-copy-id");
        if (id && navigator.clipboard) {
          navigator.clipboard.writeText(id).catch(() => {});
        }
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
        return;
      }
      const button = event.target.closest("button[data-action]");
      if (button) {
        const container = button.getAttribute("data-container");
        const action = button.getAttribute("data-action");
        runContainerAction(container, action);
        return;
      }
      const assistantButton = event.target.closest("button[data-assistant-ask]");
      if (assistantButton) {
        const section = assistantButton.getAttribute("data-assistant-ask");
        const inputEl = document.getElementById("assistantInput-" + section);
        const question = inputEl ? inputEl.value : "";
        assistantResponse[section] = assistantAnswer(section, question);
        renderCurrentSection();
        return;
      }
      if (event.target.closest("button[data-hub-search]")) {
        const inputEl = document.getElementById("hubQueryInput");
        searchHub(inputEl ? inputEl.value : "");
        return;
      }
      if (event.target.closest("button[data-images-open-search]")) {
        imagesSubView = "search";
        renderCurrentSection();
        return;
      }
      if (event.target.closest("button[data-images-back-local]")) {
        imagesSubView = "local";
        runDraft = { image: "", name: "", ports: "" };
        assistantResponse.run = "";
        renderCurrentSection();
        return;
      }
      const pullButton = event.target.closest("button[data-image-pull]");
      if (pullButton) {
        if (busy) return;
        busy = true;
        const image = pullButton.getAttribute("data-image-pull");
        setLoading("Pulling image " + image + "... please wait.");
        api("/api/images/pull", { method: "POST", body: JSON.stringify({ image }) })
          .then((state) => applyState(state))
          .catch((error) => { errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>"; })
          .finally(() => {
            busy = false;
            setLoading("");
          });
        return;
      }
      const runFromImageButton = event.target.closest("button[data-image-run]");
      if (runFromImageButton) {
        imagesSubView = "search";
        runDraft.image = runFromImageButton.getAttribute("data-image-run") || "";
        currentSection = "images";
        for (const item of sidebar.querySelectorAll("button[data-section]")) {
          item.classList.toggle("active", item.getAttribute("data-section") === "images");
        }
        renderCurrentSection();
        return;
      }
      if (event.target.closest("button[data-volume-create]")) {
        const name = (document.getElementById("newVolumeName")?.value || "").trim();
        api("/api/volumes/create", { method: "POST", body: JSON.stringify({ name }) })
          .then((state) => applyState(state))
          .catch((error) => { errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>"; });
        return;
      }
      if (event.target.closest("button[data-network-create]")) {
        const name = (document.getElementById("newNetworkName")?.value || "").trim();
        api("/api/networks/create", { method: "POST", body: JSON.stringify({ name }) })
          .then((state) => applyState(state))
          .catch((error) => { errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>"; });
        return;
      }
      if (event.target.closest("button[data-run-create]")) {
        runDraft = {
          image: (document.getElementById("runImageInput")?.value || "").trim(),
          name: (document.getElementById("runNameInput")?.value || "").trim(),
          ports: (document.getElementById("runPortsInput")?.value || "").trim(),
        };
        api("/api/images/run", { method: "POST", body: JSON.stringify(runDraft) })
          .then((state) => {
            runDraft = { image: "", name: "", ports: "" };
            assistantResponse.run = "";
            applyState(state);
            currentSection = "containers";
            for (const item of sidebar.querySelectorAll("button[data-section]")) {
              item.classList.toggle("active", item.getAttribute("data-section") === "containers");
            }
            renderCurrentSection();
          })
          .catch((error) => { errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>"; });
      }
    });

    async function init() {
      try {
        await loadState();
      } catch (error) {
        errorEl.innerHTML = '<div class="error">' + escHtml(error.message) + "</div>";
        statusEl.textContent = "Could not load WSLC state";
        return;
      }
      if (initialDetail && initialDetail.container) {
        openContainerDetail(initialDetail.container, initialDetail.tab);
      }
    }

    init();

    setInterval(() => {
      if (!busy) {
        loadState().catch(() => {});
      }
    }, 8000);

    setInterval(() => {
      pollNavigationIntent();
    }, 1200);
  
