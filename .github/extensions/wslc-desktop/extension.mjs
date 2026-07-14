import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import {
    runWslc,
    parseJsonOutput,
    getWslcState,
    runContainerCommand,
    readJsonBody,
    parsePortsInput,
    searchDockerHub,
} from "./wslc-core.mjs";
import { renderHtml } from "./ui/render.mjs";
const servers = new Map();

const UI_FILES = {
    "/ui/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/ui/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};
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
            if (req.method === "GET" && UI_FILES[url.pathname]) {
                const asset = UI_FILES[url.pathname];
                const assetPath = fileURLToPath(new URL(`./ui/${asset.file}`, import.meta.url));
                const content = await readFile(assetPath);
                res.statusCode = 200;
                res.setHeader("Content-Type", asset.type);
                res.end(content);
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/state") {
                writeJson(res, 200, await getWslcState());
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/navigation-intent") {
                const intent = uiState.pendingNavigation ?? null;
                uiState.pendingNavigation = null;
                writeJson(res, 200, { intent });
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
                    name: "show_container_detail",
                    description: "Navigates the open canvas to a container detail tab (logs, inspect, or stats).",
                    inputSchema: {
                        type: "object",
                        properties: {
                            container: { type: "string", minLength: 1 },
                            tab: { type: "string", enum: ["logs", "inspect", "stats"] },
                        },
                        required: ["container"],
                    },
                    handler: async (ctx) => {
                        const container = String(ctx.input?.container ?? "").trim();
                        const tab = String(ctx.input?.tab ?? "logs").trim() || "logs";
                        if (!container) {
                            throw new CanvasError("invalid_input", "container is required");
                        }
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError("instance_not_found", "Canvas instance is not open");
                        }
                        const nonce = Date.now();
                        entry.uiState.initialContainerFilter = container;
                        entry.uiState.initialDetail = { container, tab };
                        entry.uiState.pendingNavigation = { container, tab, nonce };
                        return { ok: true, container, tab };
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
                        pendingNavigation: requestedDetail ? { ...requestedDetail, nonce: Date.now() } : null,
                    });
                    servers.set(ctx.instanceId, entry);
                } else {
                    entry.uiState.initialContainerFilter = requestedFilter;
                    entry.uiState.initialDetail = requestedDetail;
                    entry.uiState.pendingNavigation = requestedDetail ? { ...requestedDetail, nonce: Date.now() } : null;
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
