// Extension: skill-ninja
// Search, install, and manage Agent Skills (SKILL.md)

import { joinSession } from "@github/copilot-sdk/extension";

import {
    loadIndex, searchSkills, findSkill, installSkill, uninstallSkill,
    listInstalled, recommendSkills, skillsRoot,
} from "./core/core.mjs";

const scopeProp = {
    type: "string", enum: ["user", "project"],
    description: "user = ~/.copilot/skills (default), project = <cwd>/.github/skills",
};
const fmt = (s) => `- ${s.name} [${s.source}] ${(s.description || "").slice(0, 140)}`;
const fail = (msg) => ({ textResultForLlm: msg, resultType: "failure" });
const cwdOf = () => process.cwd();

const session = await joinSession({
    requestedEnvironmentVariables: ["GITHUB_TOKEN"],
    tools: [
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
            description: "Report catalog status (bundled index date, sources, skill count). Refreshing from sources is not implemented yet.",
            skipPermission: true,
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const i = await loadIndex();
                return `Catalog updated ${i.lastUpdated}: ${i.skills.length} skills, ${i.sources.length} sources. Live refresh is not implemented in this MVP.`;
            },
        },
    ],
});
