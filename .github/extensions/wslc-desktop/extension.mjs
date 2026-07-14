import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const servers = new Map();

function runWslc(args) {
    return new Promise((resolve) => {
        const child = spawn("wslc", args, { stdio: ["ignore", "pipe", "pipe"] });
        const out = [];
        const err = [];
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 20_000);

        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                code: -1,
                stdout: "",
                stderr: error.message,
            });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                ok: !timedOut && code === 0,
                code: timedOut ? -1 : (code ?? -1),
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: timedOut ? "Command timed out" : Buffer.concat(err).toString("utf8"),
            });
        });
    });
}

function parseJsonOutput(stdout) {
    const text = stdout.trim();
    if (!text) {
        return [];
    }
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function stateToLabel(state) {
    const map = {
        0: "unknown",
        1: "created",
        2: "running",
        3: "stopped",
        4: "paused",
        5: "restarting",
        6: "removing",
        7: "dead",
    };
    return map[Number(state)] ?? `state:${state}`;
}

function buildPortMappings(ports) {
    if (!Array.isArray(ports) || ports.length === 0) {
        return [];
    }
    return ports
        .map((port) => {
            const address = port.BindingAddress ?? "127.0.0.1";
            const host = port.HostPort ?? "?";
            const container = port.ContainerPort ?? "?";
            const protocol = Number(port.Protocol) === 17 ? "udp" : "tcp";
            const display = `${host}->${container}/${protocol}`;
            const browserAddress = address === "0.0.0.0" ? "127.0.0.1" : address;
            return {
                address,
                hostPort: Number(host),
                containerPort: Number(container),
                protocol,
                display,
                url: protocol === "tcp" && Number.isFinite(Number(host))
                    ? `http://${browserAddress}:${host}`
                    : null,
            };
        });
}

function formatPorts(mappings) {
    return mappings.map((mapping) => mapping.display).join(", ");
}

function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function getWslcState() {
    const containersResult = await runWslc(["ps", "-a", "--format", "json"]);
    if (!containersResult.ok) {
        return {
            available: false,
            error: containersResult.stderr || "wslc is not available",
            updatedAt: new Date().toISOString(),
            summary: { running: 0, total: 0 },
            containers: [],
            images: [],
            volumes: [],
            networks: [],
        };
    }

    const imagesResult = await runWslc(["images", "--format", "json"]);
    const volumesResult = await runWslc(["volume", "ls", "--format", "json"]);
    const networksResult = await runWslc(["network", "ls", "--format", "json"]);

    const containers = parseJsonOutput(containersResult.stdout).map((container) => {
        const portMappings = buildPortMappings(container.Ports);
        return {
            portMappings,
            id: container.Id ?? "",
            name: container.Name ?? "",
            image: container.Image ?? "",
            status: stateToLabel(container.State),
            state: Number(container.State ?? 0),
            ports: formatPorts(portMappings),
        };
    });
    const running = containers.filter((container) => container.state === 2).length;

    return {
        available: true,
        error: null,
        updatedAt: new Date().toISOString(),
        summary: { running, total: containers.length },
        containers,
        images: imagesResult.ok
            ? parseJsonOutput(imagesResult.stdout).map((image) => ({
                name: image.Repository && image.Tag ? `${image.Repository}:${image.Tag}` : "<none>",
                id: image.Id ?? "",
                size: `${Math.round((Number(image.Size ?? 0) / (1024 * 1024)) * 10) / 10} MB`,
                created: image.Created ? new Date(Number(image.Created) * 1000).toLocaleString() : "",
            }))
            : [],
        volumes: volumesResult.ok
            ? parseJsonOutput(volumesResult.stdout).map((volume) => ({
                name: volume.Name ?? "",
                driver: volume.Driver ?? "",
            }))
            : [],
        networks: networksResult.ok
            ? parseJsonOutput(networksResult.stdout).map((network) => ({
                name: network.Name ?? "",
                driver: network.Driver ?? "",
                scope: network.Scope ?? "",
            }))
            : [],
    };
}

async function runContainerCommand(action, container) {
    if (action === "restart") {
        const stopped = await runWslc(["stop", container]);
        if (!stopped.ok) {
            return stopped;
        }
        return runWslc(["start", container]);
    }
    const commandMap = {
        start: ["start", container],
        stop: ["stop", container],
        remove: ["rm", container],
    };
    const args = commandMap[action];
    if (!args) {
        throw new CanvasError("invalid_action", `Unsupported action: ${action}`);
    }
    return runWslc(args);
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
        return {};
    }
    try {
        return JSON.parse(raw);
    } catch {
        throw new CanvasError("invalid_json", "Invalid JSON body");
    }
}

function parsePortsInput(value) {
    const text = String(value ?? "").trim();
    if (!text) {
        return [];
    }
    return text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
            const [host, container] = item.split(":").map((part) => part.trim());
            if (!host || !container) {
                throw new CanvasError("invalid_ports", `Invalid port mapping "${item}". Use host:container format.`);
            }
            return `${host}:${container}`;
        });
}

async function searchDockerHub(query) {
    const q = String(query ?? "").trim();
    if (!q) {
        return [];
    }
    const params = new URLSearchParams({
        query: q,
        page_size: "20",
        page: "1",
    });
    const response = await fetch(`https://hub.docker.com/v2/search/repositories/?${params.toString()}`, {
        headers: {
            "User-Agent": "wslc-desktop-canvas",
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new CanvasError("dockerhub_search_failed", `Docker Hub search failed (${response.status})`);
    }
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((item) => {
        const namespace = item.repo_owner ?? item.namespace ?? "library";
        const repo = item.repo_name ?? item.name ?? "";
        const fullName = namespace && repo ? `${namespace}/${repo}` : repo;
        return {
            name: fullName,
            shortDescription: item.short_description ?? "",
            stars: Number(item.star_count ?? 0),
            pulls: Number(item.pull_count ?? 0),
            isOfficial: Boolean(item.is_official),
            isAutomated: Boolean(item.is_automated),
        };
    });
}

function renderHtml(instanceId, initialContainerFilter = "", initialDetail = null) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WSLC Desktop</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    .app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    .sidebar {
      border-right: 1px solid var(--border-color-default, #d1d9e0);
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .brand {
      font-weight: var(--font-weight-semibold, 600);
      margin-bottom: 6px;
      font-size: 16px;
    }
    .sidebar-item {
      width: 100%;
      text-align: left;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-color-default, #1f2328);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sidebar-item.active {
      border-color: var(--border-color-default, #d1d9e0);
      background: color-mix(in srgb, var(--background-color-default, #ffffff) 85%, var(--text-color-muted, #656d76) 15%);
    }
    .sidebar-item .count {
      margin-left: auto;
      color: var(--text-color-muted, #656d76);
      font-size: 12px;
    }
    .main { padding: 16px; min-width: 0; overflow-x: hidden; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; justify-content: space-between; }
    .toolbar-left { display: flex; gap: 8px; align-items: center; }
    button {
      border: 1px solid var(--border-color-default, #d1d9e0);
      background: var(--background-color-default, #fff);
      color: var(--text-color-default, #1f2328);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
    }
    button:hover { filter: brightness(0.97); }
    .icon-only {
      min-width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
    }
    .btn-primary {
      background: var(--true-color-blue-muted, #dbeafe);
      color: var(--true-color-blue, #0969da);
      border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 35%, transparent);
    }
    .btn-success {
      background: #ddf4e4;
      color: #1a7f37;
      border-color: #1a7f3733;
    }
    .btn-warning {
      background: #fff8c5;
      color: #9a6700;
      border-color: #9a670033;
    }
    .btn-danger {
      background: #ffebe9;
      color: #cf222e;
      border-color: #cf222e33;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; table-layout: fixed; }
    th, td {
      border-bottom: 1px solid var(--border-color-default, #d1d9e0);
      text-align: left;
      vertical-align: top;
      padding: 6px 8px;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th { color: var(--text-color-muted, #656d76); }
    section { margin-bottom: 20px; }
    .muted { color: var(--text-color-muted, #656d76); }
    .status { margin-bottom: 10px; }
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .error {
      border: 1px solid var(--true-color-red-muted, #ffd8d3);
      background: color-mix(in srgb, var(--true-color-red-muted, #ffd8d3) 35%, transparent);
      color: var(--true-color-red, #d1242f);
      padding: 8px 10px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .small { font-size: 12px; }
    .section-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .filter-input {
      border: 1px solid var(--border-color-default, #d1d9e0);
      background: var(--background-color-default, #fff);
      color: var(--text-color-default, #1f2328);
      border-radius: 6px;
      padding: 6px 8px;
      min-width: 260px;
    }
    .filter-input:focus {
      outline: 2px solid var(--color-focus-outline, #0969da);
      outline-offset: 1px;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .port-links {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .port-link-btn {
      border: 0;
      background: transparent;
      color: var(--true-color-blue, #0969da);
      padding: 0;
      border-radius: 0;
      text-align: left;
      font-size: 12px;
    }
    .port-link-btn:hover { text-decoration: underline; filter: none; }
    .containers-table th:nth-child(2),
    .containers-table td:nth-child(2) {
      width: 220px;
      max-width: 220px;
    }
    .hub-table th:nth-child(2),
    .hub-table td:nth-child(2) {
      width: 170px;
      max-width: 170px;
    }
    .hub-table th:nth-child(5),
    .hub-table td:nth-child(5) {
      width: 140px;
      max-width: 140px;
    }
    .truncate {
      display: block;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .assistant-box {
      margin-top: 12px;
      border: 1px solid var(--border-color-default, #d1d9e0);
      border-radius: 8px;
      padding: 10px;
    }
    .assistant-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .assistant-response {
      margin-top: 8px;
      padding: 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--background-color-default, #ffffff) 88%, var(--text-color-muted, #656d76) 12%);
      white-space: pre-wrap;
    }
    .card {
      border: 1px solid var(--border-color-default, #d1d9e0);
      border-radius: 8px;
      padding: 10px;
      margin-top: 10px;
    }
    .loading {
      display: none;
      margin-bottom: 10px;
      border: 1px solid #9a670033;
      background: #fff8c5;
      color: #9a6700;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
    }
    .loading.visible { display: block; }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--border-color-default, #d1d9e0);
        flex-direction: row;
        flex-wrap: wrap;
      }
      .brand { width: 100%; }
      .sidebar-item { flex: 1 1 calc(50% - 8px); min-width: 0; }
      .filter-input { min-width: 0; width: 100%; }
      .section-toolbar { align-items: stretch; }
    }
    .cell-link {
      background: none; border: none; padding: 0; margin: 0;
      color: var(--true-color-blue, #0969da); cursor: pointer; font: inherit;
      text-align: left; max-width: 100%;
    }
    .cell-link:hover { text-decoration: underline; }
    .detail-view { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .breadcrumb { font-size: 13px; color: var(--text-color-muted, #656d76); display: flex; align-items: center; gap: 6px; }
    .crumb-link {
      background: none; border: none; padding: 0; color: var(--true-color-blue, #0969da);
      cursor: pointer; font: inherit;
    }
    .crumb-link:hover { text-decoration: underline; }
    .detail-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .detail-name { margin: 0 0 6px 0; font-size: 20px; font-weight: 600; }
    .detail-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
    .short-id {
      background: var(--background-color-muted, #f6f8fa); border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px; padding: 2px 6px; font-size: 12px;
    }
    .copy-btn {
      background: none; border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px;
      cursor: pointer; padding: 2px 6px; font-size: 12px; color: var(--text-color-default, #1f2328);
    }
    .copy-btn:hover { background: var(--background-color-muted, #f6f8fa); }
    .detail-image { font-size: 12px; color: var(--text-color-muted, #656d76); max-width: 260px; }
    .status-badge { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
    .status-badge.running { background: rgba(31,136,61,0.15); color: var(--true-color-green, #1a7f37); }
    .status-badge.stopped { background: rgba(101,109,118,0.15); color: var(--text-color-muted, #656d76); }
    .detail-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .btn-info { background: var(--true-color-blue, #0969da); color: #fff; }
    .detail-ports { font-size: 13px; color: var(--text-color-muted, #656d76); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .detail-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-color-default, #d0d7de); }
    .detail-tab {
      background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
      padding: 8px 14px; font: inherit; color: var(--text-color-muted, #656d76);
    }
    .detail-tab:hover { color: var(--text-color-default, #1f2328); }
    .detail-tab.active { color: var(--text-color-default, #1f2328); border-bottom-color: var(--true-color-blue, #0969da); font-weight: 600; }
    .detail-tabs-bar { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border-color-default, #d0d7de); }
    .detail-tabs-bar .detail-tabs { border-bottom: none; }
    .send-chat-btn {
      display: inline-flex; align-items: center; gap: 6px; margin-bottom: 6px;
      background: var(--true-color-blue, #0969da); color: #fff; border: none; border-radius: 6px;
      padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; flex-shrink: 0;
    }
    .send-chat-btn:hover { filter: brightness(1.08); }
    .send-chat-btn:disabled { opacity: 0.7; cursor: default; }
    .send-hint { font-size: 12px; color: var(--text-color-muted, #656d76); margin: 2px 0 0; }
    .detail-body { min-height: 120px; }
    .detail-pre {
      background: var(--background-color-muted, #f6f8fa); border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 8px; padding: 12px; overflow: auto; max-height: 460px;
      font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    .detail-loading { color: var(--text-color-muted, #656d76); padding: 20px 0; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat-card {
      border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px; padding: 12px;
      background: var(--background-color-default, #fff);
    }
    .stat-label { font-size: 12px; color: var(--text-color-muted, #656d76); margin-bottom: 6px; }
    .stat-value { font-size: 18px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">🐳 WSLC Desktop</div>
      <button class="sidebar-item active" data-section="containers" title="Containers" aria-label="Containers"><span>📦 Containers</span><span class="count" id="count-containers">0</span></button>
      <button class="sidebar-item" data-section="images" title="Images" aria-label="Images"><span>🖼️ Images</span><span class="count" id="count-images">0</span></button>
      <button class="sidebar-item" data-section="volumes" title="Volumes" aria-label="Volumes"><span>💾 Volumes</span><span class="count" id="count-volumes">0</span></button>
      <button class="sidebar-item" data-section="networks" title="Networks" aria-label="Networks"><span>🕸️ Networks</span><span class="count" id="count-networks">0</span></button>
    </aside>
    <main class="main">
      <h1>WSLC Desktop</h1>
      <div class="toolbar">
        <div class="toolbar-left">
          <input id="containerFilter" class="filter-input" type="search" placeholder="Filter containers by name or ID" value="${esc(initialContainerFilter)}" />
          <span class="small muted">Instance: <code>${esc(instanceId)}</code></span>
        </div>
      </div>
      <div id="loading" class="loading"></div>
      <div id="status" class="status muted">Loading...</div>
      <div id="error"></div>
      <div id="content"></div>
    </main>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const contentEl = document.getElementById("content");
    const loadingEl = document.getElementById("loading");
    const containerFilterEl = document.getElementById("containerFilter");
    const sidebar = document.querySelector(".sidebar");
    const initialContainerFilter = ${JSON.stringify(initialContainerFilter)};
    const initialDetail = ${JSON.stringify(initialDetail)};
    let currentSection = "containers";
    let imagesSubView = "local";
    let currentState = null;
    let containerFilterText = initialContainerFilter;
    let detailContainerId = null;
    let detailTab = "logs";
    let detailData = { logs: null, inspect: null, stats: null };
    let detailLoading = false;
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

    function applyState(state) {
      currentState = state;
      const updated = new Date(state.updatedAt).toLocaleString();
      statusEl.textContent = "Running containers: " + state.summary.running + " / " + state.summary.total + " · Updated " + updated;
      errorEl.innerHTML = state.available ? "" : '<div class="error">' + escHtml(state.error || "wslc unavailable") + "</div>";
      updateSidebarCounts(state);
      renderCurrentSection();
    }

    async function loadState() {
      const state = await api("/api/state");
      applyState(state);
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
      if (initialDetail && initialDetail.container && currentState) {
        const req = String(initialDetail.container).toLowerCase();
        const list = currentState.containers;
        const match =
          list.find((c) => String(c.name || "").toLowerCase() === req || String(c.id || "").toLowerCase() === req) ||
          list.find((c) => String(c.id || "").toLowerCase().startsWith(req)) ||
          list.find((c) => String(c.name || "").toLowerCase().includes(req));
        if (match) {
          currentSection = "containers";
          for (const item of sidebar.querySelectorAll("button[data-section]")) {
            item.classList.toggle("active", item.getAttribute("data-section") === "containers");
          }
          detailContainerId = match.id || match.name;
          detailTab = ["logs", "inspect", "stats"].includes(initialDetail.tab) ? initialDetail.tab : "logs";
          renderCurrentSection();
          loadDetailTab(detailTab);
        }
      }
    }

    init();

    setInterval(() => {
      if (!busy) {
        loadState().catch(() => {});
      }
    }, 8000);
  </script>
</body>
</html>`;
}

function writeJson(res, statusCode, body) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

async function startServer(instanceId, uiState) {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml(instanceId, uiState.initialContainerFilter ?? "", uiState.initialDetail ?? null));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/state") {
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/send-to-chat") {
                const body = await readJsonBody(req);
                const container = String(body.container ?? "").trim();
                const tab = String(body.tab ?? "").trim() || "logs";
                const rawText = String(body.text ?? "");
                const hasSelection = Boolean(body.hasSelection);
                if (!rawText.trim()) {
                    writeJson(res, 400, { error: "Nothing to send" });
                    return;
                }
                const MAX = 12000;
                let text = rawText;
                if (text.length > MAX) {
                    if (!hasSelection && tab === "logs") {
                        text = "… (truncated)\n" + text.slice(text.length - MAX);
                    } else {
                        text = text.slice(0, MAX) + "\n… (truncated)";
                    }
                }
                const scope = hasSelection ? "selection" : `full ${tab}`;
                const title = `${container} · ${tab} (${scope})`;
                try {
                    if (!session?.rpc?.extensions?.sendAttachmentsToMessage) {
                        throw new Error("Attachment API is not available in this session");
                    }
                    await session.rpc.extensions.sendAttachmentsToMessage({
                        instanceId,
                        attachments: [
                            {
                                type: "extension_context",
                                title,
                                payload: {
                                    source: "wslc-desktop",
                                    container,
                                    tab,
                                    scope: hasSelection ? "selection" : "full-view",
                                    text,
                                },
                            },
                        ],
                    });
                    writeJson(res, 200, { ok: true });
                } catch (error) {
                    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/dockerhub/search") {
                const query = url.searchParams.get("q") ?? "";
                writeJson(res, 200, await searchDockerHub(query));
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/refresh") {
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/images/pull") {
                const body = await readJsonBody(req);
                const image = String(body.image ?? "").trim();
                if (!image) {
                    writeJson(res, 400, { error: "image is required" });
                    return;
                }
                const result = await runWslc(["pull", image]);
                if (!result.ok) {
                    writeJson(res, 400, { error: result.stderr || `Failed to pull ${image}` });
                    return;
                }
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/images/run") {
                const body = await readJsonBody(req);
                const image = String(body.image ?? "").trim();
                const name = String(body.name ?? "").trim();
                const ports = parsePortsInput(body.ports);
                if (!image) {
                    writeJson(res, 400, { error: "image is required" });
                    return;
                }
                const args = ["run", "-d"];
                if (name) {
                    args.push("--name", name);
                }
                for (const mapping of ports) {
                    args.push("-p", mapping);
                }
                args.push(image);
                const result = await runWslc(args);
                if (!result.ok) {
                    writeJson(res, 400, { error: result.stderr || `Failed to run ${image}` });
                    return;
                }
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/volumes/create") {
                const body = await readJsonBody(req);
                const name = String(body.name ?? "").trim();
                if (!name) {
                    writeJson(res, 400, { error: "volume name is required" });
                    return;
                }
                const result = await runWslc(["volume", "create", name]);
                if (!result.ok) {
                    writeJson(res, 400, { error: result.stderr || `Failed to create volume ${name}` });
                    return;
                }
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/networks/create") {
                const body = await readJsonBody(req);
                const name = String(body.name ?? "").trim();
                if (!name) {
                    writeJson(res, 400, { error: "network name is required" });
                    return;
                }
                const result = await runWslc(["network", "create", name]);
                if (!result.ok) {
                    writeJson(res, 400, { error: result.stderr || `Failed to create network ${name}` });
                    return;
                }
                writeJson(res, 200, await getWslcState());
                return;
            }
            const detailMatch = req.method === "GET" ? url.pathname.match(/^\/api\/containers\/([^/]+)\/(logs|inspect|stats)$/) : null;
            if (detailMatch) {
                const container = decodeURIComponent(detailMatch[1]);
                const kind = detailMatch[2];
                if (kind === "logs") {
                    const result = await runWslc(["logs", "-n", "500", container]);
                    writeJson(res, 200, { ok: result.ok, output: (result.stdout || "") + (result.stderr || "") });
                    return;
                }
                if (kind === "inspect") {
                    const result = await runWslc(["inspect", container]);
                    writeJson(res, 200, { ok: result.ok, output: result.ok ? result.stdout : (result.stderr || "") });
                    return;
                }
                const result = await runWslc(["stats", "--format", "json", container]);
                let stats = null;
                if (result.ok) {
                    const parsed = parseJsonOutput(result.stdout);
                    stats = parsed.length ? parsed[0] : null;
                }
                writeJson(res, 200, { ok: result.ok, stats, error: result.ok ? null : (result.stderr || "") });
                return;
            }
            const actionMatch = req.method === "POST" ? url.pathname.match(/^\/api\/containers\/([^/]+)\/(start|stop|remove|restart)$/) : null;
            if (actionMatch) {
                const container = decodeURIComponent(actionMatch[1]);
                const action = actionMatch[2];
                const command = await runContainerCommand(action, container);
                if (!command.ok) {
                    writeJson(res, 400, { error: command.stderr || `Failed to ${action} container ${container}` });
                    return;
                }
                writeJson(res, 200, await getWslcState());
                return;
            }
            writeJson(res, 404, { error: "Not found" });
        } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/`, uiState };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "wslc-desktop",
            displayName: "WSLC Desktop",
            description: "Docker Desktop style panel to manage WSLC containers, images, volumes, and networks.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    containerFilter: { type: "string", minLength: 1 },
                    container: { type: "string", minLength: 1 },
                    detailContainer: { type: "string", minLength: 1 },
                    detailTab: { type: "string", enum: ["logs", "inspect", "stats"] },
                },
            },
            actions: [
                {
                    name: "refresh_state",
                    description: "Refreshes WSLC containers, images, volumes, and networks state.",
                    handler: async () => {
                        return getWslcState();
                    },
                },
                {
                    name: "container_start",
                    description: "Starts a WSLC container by name or id.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            container: { type: "string", minLength: 1 },
                        },
                        required: ["container"],
                    },
                    handler: async (ctx) => {
                        const container = String(ctx.input?.container ?? "").trim();
                        if (!container) {
                            throw new CanvasError("invalid_input", "container is required");
                        }
                        const result = await runContainerCommand("start", container);
                        if (!result.ok) {
                            throw new CanvasError("wslc_command_failed", result.stderr || `Failed to start ${container}`);
                        }
                        return getWslcState();
                    },
                },
                {
                    name: "container_stop",
                    description: "Stops a WSLC container by name or id.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            container: { type: "string", minLength: 1 },
                        },
                        required: ["container"],
                    },
                    handler: async (ctx) => {
                        const container = String(ctx.input?.container ?? "").trim();
                        if (!container) {
                            throw new CanvasError("invalid_input", "container is required");
                        }
                        const result = await runContainerCommand("stop", container);
                        if (!result.ok) {
                            throw new CanvasError("wslc_command_failed", result.stderr || `Failed to stop ${container}`);
                        }
                        return getWslcState();
                    },
                },
                {
                    name: "container_remove",
                    description: "Removes a WSLC container by name or id.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            container: { type: "string", minLength: 1 },
                        },
                        required: ["container"],
                    },
                    handler: async (ctx) => {
                        const container = String(ctx.input?.container ?? "").trim();
                        if (!container) {
                            throw new CanvasError("invalid_input", "container is required");
                        }
                        const result = await runContainerCommand("remove", container);
                        if (!result.ok) {
                            throw new CanvasError("wslc_command_failed", result.stderr || `Failed to remove ${container}`);
                        }
                        return getWslcState();
                    },
                },
            ],
            open: async (ctx) => {
                const detailContainer = String(ctx.input?.detailContainer ?? "").trim();
                const detailTab = String(ctx.input?.detailTab ?? "").trim();
                const requestedFilter = String(ctx.input?.containerFilter ?? ctx.input?.container ?? detailContainer ?? "").trim();
                const requestedDetail = detailContainer
                    ? { container: detailContainer, tab: detailTab || "logs" }
                    : null;
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, {
                        initialContainerFilter: requestedFilter,
                        initialDetail: requestedDetail,
                    });
                    servers.set(ctx.instanceId, entry);
                } else {
                    entry.uiState.initialContainerFilter = requestedFilter;
                    entry.uiState.initialDetail = requestedDetail;
                }
                const state = await getWslcState();
                return {
                    title: "WSLC Desktop",
                    status: state.available
                        ? `${state.summary.running}/${state.summary.total} running`
                        : "wslc unavailable",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
