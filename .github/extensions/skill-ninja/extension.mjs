// Extension: skill-ninja
// Search, install, and manage Agent Skills (SKILL.md)

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import {
    loadIndex, searchSkills, findSkill, installSkill, uninstallSkill, listInstalled,
    recommendSkills, skillsRoot, addSource, removeSource, refreshIndex, checkUpdates,
} from "./core/core.mjs";
import { startUiServer } from "./core/ui.mjs";

const scopeProp = {
    type: "string", enum: ["user", "project"],
    description: "user = ~/.copilot/skills (default), project = <cwd>/.github/skills",
};
const fmt = (s) => `- ${s.name} [${s.source}] ${(s.description || "").slice(0, 140)}`;
const fail = (msg) => ({ textResultForLlm: msg, resultType: "failure" });
const cwdOf = () => process.cwd();

let ui;
const skillCanvas = createCanvas({
    id: "skill-ninja",
    displayName: "Skill Ninja",
    description: "Search, install, update and uninstall Agent Skills with a visual UI.",
    open: async () => {
        ui ??= await startUiServer(cwdOf);
        return { url: `http://127.0.0.1:${ui.port}/?t=${ui.token}`, title: "Skill Ninja" };
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
                    return `Installed '${name}' (${r.fileCount} files) to ${r.dest}. It may need /clear or a restart to be picked up.`;
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
            description: "Scan catalog sources (all, or the given source ids) for new SKILL.md entries and cache them.",
            skipPermission: true,
            parameters: { type: "object", properties: { sources: { type: "array", items: { type: "string" } } } },
            handler: async ({ sources } = {}) => {
                const r = await refreshIndex(sources);
                const i = await loadIndex();
                return `Scan done: ${r.added} new skill(s). Catalog: ${i.skills.length} skills, ${i.sources.length} sources.${r.errors.length ? `\nErrors:\n${r.errors.join("\n")}` : ""}`;
            },
        },
    ],
});
