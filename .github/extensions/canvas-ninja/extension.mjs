// Extension: canvas-ninja
// Discover, review and install Copilot App canvas extensions.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import {
    loadIndex, searchExtensions, findExtension, reviewExtension, publicReview, installExtension, uninstallExtension, listInstalled,
    checkUpdates, addSource, removeSource, refreshIndex, staleSources, STALE_DAYS, MAX_STALE_PER_RUN, sourceProblems, setIgnored,
    setSourceUrl, webSearch, setLocalized, loadConfig,
} from "./core/core.mjs";
import { startUiServer } from "./core/ui.mjs";

const scopeProp = { type: "string", enum: ["user", "project"], description: "user = ~/.copilot/extensions (default), project = <cwd>/.github/extensions" };
const fail = (msg) => ({ textResultForLlm: msg, resultType: "failure" });
const cwdOf = () => process.cwd();
const fmt = (e) => `- ${e.displayName || e.name} (${e.name}) [${e.source}] ${(e.description || "").slice(0, 140)}`;

// Reload is deferred and explicit: it restarts extension processes, including this one.
const reloadExtensions = async () => {
    setTimeout(async () => {
        try {
            await session.rpc.extensions.reload();
        } catch (e) {
            await session.log(`extension reload failed: ${e.message ?? e}`, { level: "warning" }).catch(() => {});
        }
    }, 1500);
};

const sessionExtensions = async () => (await session.rpc.extensions.list()).extensions.map(({ name, source, status }) => ({ name, source, status }));
const askAgent = async (prompt) => {
    await session.send({ prompt });
};

const reviewText = (r) =>
    [
        `Risk: ${r.risk.toUpperCase()} (heuristic, not a security verdict) — ${r.repo}@${r.commit.slice(0, 7)}, ${r.fileCount} files, tree ${r.treeHash.slice(0, 12)}`,
        ...r.findings.map((f) => `- [${f.sev}] ${f.label}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`),
        r.note,
    ].join("\n");

const pick = async (name, source) => {
    const index = await loadIndex();
    const hits = findExtension(index, name, source);
    if (!hits.length) throw new Error(`Extension '${name}' not found in catalog.`);
    if (hits.length > 1) throw new Error(`Ambiguous; specify source: ${hits.map((h) => h.source).join(", ")}`);
    return hits[0];
};

let ui;
const canvas = createCanvas({
    id: "canvas-ninja",
    displayName: "Agent Canvas Ninja",
    description: "Search, review and install Copilot App canvas extensions with a visual UI.",
    open: async () => {
        ui ??= await startUiServer({ cwd: cwdOf, reload: async () => reloadExtensions(), sessionExtensions, askAgent });
        return { url: `http://127.0.0.1:${ui.port}/?t=${ui.token}`, title: "Agent Canvas Ninja" };
    },
    onClose: () => {
        ui?.server.close();
        ui = undefined;
    },
    actions: [
        {
            name: "search",
            description: "Search the canvas extension catalog.",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            handler: async ({ input }) => searchExtensions(await loadIndex(), input?.query ?? "", { limit: 20 }),
        },
    ],
});

const session = await joinSession({
    requestedEnvironmentVariables: ["GITHUB_TOKEN"],
    canvases: [canvas],
    tools: [
        {
            name: "canvas_ninja_search",
            description: "Search the catalog of Copilot App canvas extensions by keywords, e.g. 'kanban', 'diagram'.",
            skipPermission: true,
            parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
            handler: async ({ query, limit }) => {
                const { total, items } = searchExtensions(await loadIndex(), query, { limit: Math.min(limit || 20, 100), ja: (await loadConfig()).ja });
                return total ? `${total} match(es), showing ${items.length}:\n${items.map(fmt).join("\n")}` : "No extensions found.";
            },
        },
        {
            name: "canvas_ninja_review_extension",
            description: "Fetch a catalog extension at its latest commit and return a heuristic risk report (child_process, env vars, network, fs writes, hooks, ...). Not a security verdict.",
            skipPermission: true,
            parameters: { type: "object", properties: { name: { type: "string" }, source: { type: "string" } }, required: ["name"] },
            handler: async ({ name, source }) => {
                try {
                    return reviewText(publicReview(await reviewExtension(await pick(name, source))));
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_install_extension",
            description: "Install a catalog extension (pinned to the reviewed commit). High-risk extensions need acknowledge_risk=true after the user agrees. Existing installs are only replaced when overwrite=true. Extensions load after an extension reload.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" }, source: { type: "string" }, scope: scopeProp,
                    overwrite: { type: "boolean", description: "Replace an existing install (confirm with the user first)" },
                    acknowledge_risk: { type: "boolean", description: "Set only after the user reviewed the risk report and agreed" },
                },
                required: ["name"],
            },
            handler: async ({ name, source, scope = "user", overwrite, acknowledge_risk }) => {
                try {
                    const entry = await pick(name, source);
                    const r = await installExtension({ entry, scope, cwd: cwdOf(), overwrite, acknowledgeRisk: acknowledge_risk });
                    if (r.status === "exists") return fail(`Already installed at ${r.dest}. Ask the user, then retry with overwrite=true.`);
                    if (r.status === "risk") return fail(`High risk — not installed.\n${reviewText(r.review)}\nShow this to the user; retry with acknowledge_risk=true only if they agree.`);
                    await reloadExtensions();
                    return `Installed '${name}' (${r.fileCount} files, risk ${r.risk}, commit ${r.commit.slice(0, 7)}) to ${r.dest}. Extensions will reload shortly.${r.warnings.length ? `\nNotes: ${r.warnings.join("; ")}` : ""}`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_uninstall_extension",
            description: "Delete an installed extension directory. Requires confirm=true after the user agrees; extensions not installed by Canvas Ninja also need force=true.",
            parameters: {
                type: "object",
                properties: { name: { type: "string" }, scope: scopeProp, confirm: { type: "boolean" }, force: { type: "boolean" } },
                required: ["name"],
            },
            handler: async ({ name, scope = "user", confirm, force }) => {
                if (!confirm) return fail(`This deletes the '${name}' extension (${scope} scope). Ask the user, then retry with confirm=true.`);
                try {
                    const r = await uninstallExtension({ name, scope, cwd: cwdOf(), force });
                    if (r.status === "removed") {
                        await reloadExtensions();
                        return `Removed ${r.dest}. Extensions will reload shortly.`;
                    }
                    return fail(r.status === "unmanaged" ? `${r.dest} was not installed by Canvas Ninja. Ask the user, then retry with force=true.` : `No extension found at ${r.dest}`);
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_list_installed",
            description: "List installed extensions in user and/or project scope, with the live status in this session.",
            skipPermission: true,
            parameters: { type: "object", properties: { scope: { ...scopeProp, enum: ["user", "project", "all"] } } },
            handler: async ({ scope = "all" } = {}) => {
                const scopes = scope === "all" ? ["user", "project"] : [scope];
                const rows = (await Promise.all(scopes.map((s) => listInstalled(s, cwdOf())))).flat();
                const live = await sessionExtensions().catch(() => []);
                return rows.length
                    ? rows.map((r) => `- ${r.name} (${r.scope}) ${live.find((l) => l.name === r.name && l.source === r.scope)?.status ?? "not loaded"}${r.managed ? "" : " [manual]"} ${r.description.slice(0, 100)}`).join("\n")
                    : "No installed extensions.";
            },
        },
        {
            name: "canvas_ninja_check_updates",
            description: "List extensions installed by Canvas Ninja whose upstream directory changed since install.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const { updates, errors } = await checkUpdates(cwdOf());
                const tail = errors.length ? `\nErrors:\n${errors.join("\n")}` : "";
                return (updates.length ? updates.map((u) => `- ${u.name} (${u.scope}) [${u.repo}]`).join("\n") + "\nUpdate with canvas_ninja_install_extension overwrite=true." : "All tracked extensions are up to date.") + tail;
            },
        },
        {
            name: "canvas_ninja_add_source",
            description: "Add a GitHub repository (or a /tree/<ref>/<path> folder URL) as an extra extension source and scan it.",
            parameters: { type: "object", properties: { url: { type: "string" }, id: { type: "string" }, branch: { type: "string" } }, required: ["url"] },
            handler: async ({ url, id, branch }) => {
                try {
                    const sid = await addSource({ id, url, branch });
                    const r = await refreshIndex([sid]);
                    return `Source '${sid}' added. Scanned ${r.scanned}, ${r.added} extension(s).${r.errors.length ? `\nErrors: ${r.errors.join("; ")}` : ""}`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_remove_source",
            description: "Remove a user-added source (bundled sources are not affected).",
            parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            handler: async ({ id }) => ((await removeSource(id)) ? `Removed '${id}'.` : fail(`No user source '${id}'.`)),
        },
        {
            name: "canvas_ninja_update_index",
            description: `Rescan catalog sources on GitHub. Pass stale=true to scan only sources older than ${STALE_DAYS} days (max ${MAX_STALE_PER_RUN} per run).`,
            skipPermission: true,
            parameters: { type: "object", properties: { sources: { type: "array", items: { type: "string" } }, stale: { type: "boolean" } } },
            handler: async ({ sources, stale } = {}) => {
                const ids = stale ? (await staleSources()).slice(0, MAX_STALE_PER_RUN) : sources;
                if (stale && !ids.length) return "No stale sources.";
                const r = await refreshIndex(ids);
                const i = await loadIndex();
                return `Scanned ${r.scanned} source(s), ${r.added} new. Catalog: ${i.extensions.length} extensions, ${i.sources.length} sources.${r.errors.length ? `\nErrors:\n${r.errors.join("\n")}` : ""}`;
            },
        },
        {
            name: "canvas_ninja_source_problems",
            description: "List sources whose last scan failed, with the reason and suggested fix.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const p = await sourceProblems();
                return p.length ? p.map((x) => `- ${x.repo} (id: ${x.id}) [${x.kind}] ${x.message}${x.ssoUrl ? `\n  SSO authorize: ${x.ssoUrl}` : ""}`).join("\n") + "\nFix with canvas_ninja_manage_source (ignore / unignore / set_url)." : "No failing sources.";
            },
        },
        {
            name: "canvas_ninja_manage_source",
            description: "Mute a failing/unwanted source (ignore), un-mute it (unignore), or point it at a different repository (set_url).",
            parameters: {
                type: "object",
                properties: { id: { type: "string" }, action: { type: "string", enum: ["ignore", "unignore", "set_url"] }, url: { type: "string" }, branch: { type: "string" } },
                required: ["id", "action"],
            },
            handler: async ({ id, action, url, branch }) => {
                try {
                    if (action === "set_url") await setSourceUrl(id, url, branch);
                    else await setIgnored(id, action === "ignore");
                    return `${action} applied to '${id}'.`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_web_search",
            description: "Search GitHub for repositories that publish Copilot canvas extensions. Add a hit with canvas_ninja_add_source.",
            skipPermission: true,
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            handler: async ({ query }) => {
                try {
                    const { items, note } = await webSearch(query);
                    return (items.length ? items.map((x) => `- ${x.repo} ★${x.stars} ${x.url} ${x.description.slice(0, 100)}`).join("\n") : "No repositories found.") + (note ? `\n${note}` : "");
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "canvas_ninja_localize",
            description: "Save a Japanese summary for a catalog extension. Translate its description yourself, then call this.",
            skipPermission: true,
            parameters: { type: "object", properties: { key: { type: "string", description: "Catalog key, e.g. github/awesome-copilot:extensions/draw" }, text: { type: "string" } }, required: ["key", "text"] },
            handler: async ({ key, text }) => {
                await setLocalized(key, text);
                return `Saved Japanese summary for ${key}.`;
            },
        },
    ],
});
