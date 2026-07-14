import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(new URL("./index.html", import.meta.url));
const template = readFileSync(templatePath, "utf8");

export function renderHtml(instanceId, initialContainerFilter = "", initialDetail = null) {
    const bootstrap = JSON.stringify({
        instanceId,
        initialContainerFilter,
        initialDetail,
    }).replaceAll("<", "\\u003c");
    return template.replace("__WSLC_BOOTSTRAP__", bootstrap);
}
