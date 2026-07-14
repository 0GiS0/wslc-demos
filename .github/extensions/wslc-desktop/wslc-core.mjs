import { spawn } from "node:child_process";
import { CanvasError } from "@github/copilot-sdk/extension";

export function runWslc(args) {
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

export function parseJsonOutput(stdout) {
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

export async function getWslcState() {
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

export async function runContainerCommand(action, container) {
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

export async function readJsonBody(req) {
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

export function parsePortsInput(value) {
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

export async function searchDockerHub(query) {
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
