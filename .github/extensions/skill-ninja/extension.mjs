// Extension: skill-ninja
// Search, install, and manage Agent Skills (SKILL.md)

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import {
    loadIndex, searchSkills, findSkill, installSkill, uninstallSkill, listInstalled,
    recommendSkills, skillsRoot, addSource, removeSource, refreshIndex, checkUpdates, importFromVsCode,
    syncUpstream, staleSources, STALE_DAYS, MAX_STALE_PER_RUN, setLocalized, installBundle, createSkill, webSearchSkills,
    sourceProblems, setIgnored, setSourceUrl,
} from "./core/core.mjs";
import { startUiServer } from "./core/ui.mjs";

const scopeProp = {
    type: "string", enum: ["user", "project"],
    description: "user = ~/.copilot/skills (default), project = <cwd>/.github/skills",
};
const fmt = (s) => `- ${s.name} [${s.source}] ${(s.description || "").slice(0, 140)}`;
const fail = (msg) => ({ textResultForLlm: msg, resultType: "failure" });
const cwdOf = () => process.cwd();

// Make the running session pick up added/removed skills without a restart.
const reloadSkills = async () => {
    // Deferred: the host may restart extensions on reload, which would drop the in-flight response.
    setTimeout(async () => {
        try {
            await session.rpc.skills.reload();
        } catch (e) {
            await session.log(`skill reload failed: ${e.message ?? e}`, { level: "warning" }).catch(() => {});
        }
    }, 1500);
};

let ui;
const skillCanvas = createCanvas({
    id: "skill-ninja",
    displayName: "Agent Skills Ninja",
    description: "Search, install, update and uninstall Agent Skills with a visual UI.",
    open: async () => {
        ui ??= await startUiServer(cwdOf, reloadSkills);
        return { url: `http://127.0.0.1:${ui.port}/?t=${ui.token}`, title: "Agent Skills Ninja" };
    },
    onClose: () => {
        ui?.server.close();
        ui = undefined;
    },
    actions: [
        {
            name: "search",
            description: "Search the catalog and return matching skills.",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            handler: async ({ input }) => searchSkills(await loadIndex(), input?.query ?? "", 20),
        },
    ],
});

const session = await joinSession({
    requestedEnvironmentVariables: ["GITHUB_TOKEN"],
    canvases: [skillCanvas],
    tools: [
        {
            name: "skill_ninja_import_vscode",
            description: "Import sources and scanned skills from the VS Code 'Agent Skills Ninja' extension data on this PC.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const r = await importFromVsCode();
                return r.files.length
                    ? `Imported ${r.sources.length} source(s) [${r.sources.join(", ")}] and ${r.skills} skill(s) from:\n${r.files.join("\n")}`
                    : "No VS Code Agent Skills Ninja data found on this PC.";
            },
        },
        {
            name: "skill_ninja_check_updates",
            description: "List installed skills whose upstream source changed since install.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const r = await checkUpdates(await loadIndex(), cwdOf());
                return r.length ? r.map((u) => `- ${u.name} (${u.scope}) [${u.source}]`).join("\n") + "\nReinstall with overwrite=true to update." : "All tracked skills are up to date (skills installed before tracking are not checked).";
            },
        },
        {
            name: "skill_ninja_add_source",
            description: "Add a GitHub repository as an extra skill source.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" }, url: { type: "string", description: "https://github.com/owner/repo" }, branch: { type: "string" } },
                required: ["id", "url"],
            },
            handler: async (a) => {
                try {
                    await addSource(a);
                    return `Source '${a.id}' added. Run skill_ninja_update_skill_index to scan it.`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_remove_source",
            description: "Remove a user-added skill source (bundled sources are not affected).",
            parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            handler: async ({ id }) => ((await removeSource(id)) ? `Removed '${id}'.` : fail(`No user source '${id}'.`)),
        },
        {
            name: "skill_ninja_search_skills",
            description: "Search the Agent Skills catalog (SKILL.md) by keywords, e.g. 'pdf', 'azure bicep'.",
            skipPermission: true,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Space-separated keywords" },
                    limit: { type: "number", description: "Max results (default 20)" },
                },
                required: ["query"],
            },
            handler: async ({ query, limit }) => {
                const { total, items } = searchSkills(await loadIndex(), query, Math.min(limit || 20, 100));
                return total ? `${total} match(es), showing ${items.length}:\n${items.map(fmt).join("\n")}` : "No skills found.";
            },
        },
        {
            name: "skill_ninja_install_skill",
            description: "Install a skill from the catalog. Existing skills are only replaced when overwrite=true.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    source: { type: "string", description: "Source id; required if the name exists in several sources" },
                    scope: scopeProp,
                    overwrite: { type: "boolean", description: "Replace an existing install (confirm with the user first)" },
                },
                required: ["name"],
            },
            handler: async ({ name, source, scope = "user", overwrite }) => {
                const index = await loadIndex();
                const hits = findSkill(index, name, source);
                if (!hits.length) return fail(`Skill '${name}' not found in catalog.`);
                if (hits.length > 1) return fail(`Ambiguous; specify source: ${hits.map((h) => h.source).join(", ")}`);
                const src = index.sources.find((s) => s.id === hits[0].source);
                if (!src) return fail(`Unknown source: ${hits[0].source}`);
                try {
                    const r = await installSkill({ skill: hits[0], source: src, scope, cwd: cwdOf(), overwrite });
                    if (r.status === "exists") return fail(`Already installed at ${r.dest}. Ask the user, then retry with overwrite=true.`);
                    await reloadSkills();
                    return `Installed '${name}' (${r.fileCount} files) to ${r.dest} and reloaded skills.`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_uninstall_skill",
            description: "Delete an installed skill directory. Requires confirm=true after the user agrees.",
            parameters: {
                type: "object",
                properties: { name: { type: "string" }, scope: scopeProp, confirm: { type: "boolean" } },
                required: ["name"],
            },
            handler: async ({ name, scope = "user", confirm }) => {
                if (!confirm) return fail(`This deletes the '${name}' skill from ${skillsRoot(scope, cwdOf())}. Ask the user, then retry with confirm=true.`);
                try {
                    const r = await uninstallSkill({ name, scope, cwd: cwdOf() });
                    if (r.status === "removed") await reloadSkills();
                    return r.status === "removed" ? `Removed ${r.dest}` : fail(`No skill found at ${r.dest}`);
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_list_skills",
            description: "List installed skills in user and/or project scope.",
            skipPermission: true,
            parameters: { type: "object", properties: { scope: { ...scopeProp, enum: ["user", "project", "all"] } } },
            handler: async ({ scope = "all" }) => {
                const scopes = scope === "all" ? ["user", "project"] : [scope];
                const rows = (await Promise.all(scopes.map((s) => listInstalled(s, cwdOf())))).flat();
                return rows.length ? rows.map((r) => `- ${r.name} (${r.scope}) ${r.description.slice(0, 120)}`).join("\n") : "No installed skills.";
            },
        },
        {
            name: "skill_ninja_recommend_skills",
            description: "Recommend uninstalled catalog skills for a task or project description.",
            skipPermission: true,
            parameters: { type: "object", properties: { context: { type: "string" } }, required: ["context"] },
            handler: async ({ context }) => {
                const installed = (await Promise.all(["user", "project"].map((s) => listInstalled(s, cwdOf())))).flat().map((r) => r.name);
                const recs = recommendSkills(await loadIndex(), context, installed);
                return recs.length ? recs.map(fmt).join("\n") : "No recommendations.";
            },
        },
        {
            name: "skill_ninja_update_skill_index",
            description: "Scan catalog sources for new SKILL.md entries and cache them. Pass stale=true to scan only sources not scanned for 30+ days (max 5 per run, oldest first); also pulls the latest VS Code extension catalog.",
            skipPermission: true,
            parameters: { type: "object", properties: { sources: { type: "array", items: { type: "string" } }, stale: { type: "boolean" } } },
            handler: async ({ sources, stale } = {}) => {
                let up = "";
                try {
                    const u = await syncUpstream();
                    up = `Upstream catalog: +${u.sources} source(s), +${u.skills} skill(s).\n`;
                } catch (e) {
                    up = `Upstream catalog unavailable: ${e.message}\n`;
                }
                const r = await refreshIndex(sources, stale ? { limit: MAX_STALE_PER_RUN } : {});
                const i = await loadIndex();
                const left = await staleSources(i);
                return `${up}Scan done: ${r.added} new skill(s) from ${r.scanned} source(s). Catalog: ${i.skills.length} skills, ${i.sources.length} sources. ${left.length} source(s) older than ${STALE_DAYS} days.${r.errors.length ? `\nErrors:\n${r.errors.join("\n")}` : ""}`;
            },
        },
        {
            name: "skill_ninja_source_problems",
            description: "List catalog sources whose last scan failed, with the repository name, reason (SSO needed, not found/private, rate limit...) and suggested fix.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const p = await sourceProblems(await loadIndex());
                return p.length ? p.map((x) => `- ${x.repo} (id: ${x.id}) [${x.kind}] ${x.message}${x.ssoUrl ? `\n  SSO authorize: ${x.ssoUrl}` : ""}`).join("\n") + "\nFix with skill_ninja_manage_source (ignore / unignore / set_url), then retry via skill_ninja_update_skill_index." : "No failing sources.";
            },
        },
        {
            name: "skill_ninja_manage_source",
            description: "Mute a failing/unwanted source (ignore), un-mute it (unignore), or point it at a different repository (set_url, optional branch).",
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
            name: "skill_ninja_localize_skill",
            description: "Save a Japanese summary (description_ja) for a catalog skill. Translate the skill's description yourself, then call this.",
            skipPermission: true,
            parameters: {
                type: "object",
                properties: { name: { type: "string" }, source: { type: "string" }, text: { type: "string", description: "Japanese summary, up to ~200 chars" } },
                required: ["name", "source", "text"],
            },
            handler: async ({ name, source, text }) => {
                try {
                    await setLocalized(source, name, text);
                    return `Saved Japanese summary for ${source}/${name}.`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_install_bundle",
            description: "Install every skill of a catalog bundle (existing ones are skipped).",
            parameters: { type: "object", properties: { id: { type: "string" }, scope: scopeProp }, required: ["id"] },
            handler: async ({ id, scope = "user" }) => {
                try {
                    const r = await installBundle({ bundleId: id, scope, cwd: cwdOf() });
                    if (r.some((x) => x.status === "installed")) await reloadSkills();
                    return r.map((x) => `- ${x.name}: ${x.status}${x.error ? ` (${x.error})` : ""}`).join("\n");
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_create_skill",
            description: "Create a new skill scaffold (SKILL.md) in user or project scope.",
            parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, scope: scopeProp }, required: ["name"] },
            handler: async ({ name, description, scope = "user" }) => {
                try {
                    const r = await createSkill({ name, description, scope, cwd: cwdOf() });
                    if (r.status === "exists") return fail(`Already exists: ${r.dest}`);
                    await reloadSkills();
                    return `Created ${r.dest}/SKILL.md. Edit it to fill in the TODOs.`;
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
        {
            name: "skill_ninja_web_search_skills",
            description: "Search GitHub for repositories that publish agent skills. Add a hit with skill_ninja_add_source.",
            skipPermission: true,
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            handler: async ({ query }) => {
                try {
                    const r = await webSearchSkills(query);
                    return r.length ? r.map((x) => `- ${x.id} ★${x.stars} ${x.url} ${x.description.slice(0, 100)}`).join("\n") : "No repositories found.";
                } catch (e) {
                    return fail(String(e.message ?? e));
                }
            },
        },
    ],
});
