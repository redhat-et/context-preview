import { readFile } from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { skillToggleFile } from "./lib/cache.js"
import { skillToggleMatches } from "./lib/skill-toggle.js"
import { estimateTokens, formatToast } from "./lib/report.js"
import { ContextPreviewRpc } from "./rpc.js"

function disabledSkillSet(file) {
  return readFile(file, "utf8")
    .then((content) => {
      const value = JSON.parse(content)
      return new Set(Array.isArray(value.disabledSkills) ? value.disabledSkills.filter((name) => typeof name === "string") : [])
    })
    .catch(() => new Set())
}

function projectRoot(context, location) {
  const directory = path.resolve(location?.directory ?? process.cwd())
  let projects = []
  try {
    projects = context.data.project?.list?.() ?? []
  } catch {
    // The project catalog is optional for older CLI runtimes.
  }
  const matching = projects
    .filter((project) => typeof project?.canonical === "string")
    .filter((project) => {
      const canonical = path.resolve(project.canonical)
      const relative = path.relative(canonical, directory)
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    })
    .sort((left, right) => path.resolve(right.canonical).length - path.resolve(left.canonical).length)
  return matching[0]?.canonical ?? directory
}

function skillIsDisabled(skill, disabled) {
  return [...disabled].some((key) => skillToggleMatches(skill, key))
}

async function buildReport(context, location, disabled) {
  await Promise.all([
    context.data.location.mcp.server.sync(location),
    context.data.location.skill.sync(location),
  ])
  const servers = context.data.location.mcp.server.list(location) ?? []
  const skills = context.data.location.skill.list(location) ?? []
  const availableSkills = skills
    .filter((skill) => skill?.autoinvoke !== false && typeof skill?.description === "string" && skill.description)
    .map((skill) => ({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description,
      source: "v2",
      estimatedTokens: estimateTokens(JSON.stringify({ name: skill.name ?? skill.id, description: skill.description })),
    }))
    .filter((skill) => !skillIsDisabled(skill, disabled))

  return {
    generatedAt: new Date().toISOString(),
    worktree: path.resolve(location?.directory ?? process.cwd()),
    estimateMethod: "Approximate: Unicode character count divided by four, rounded up.",
    mcpServers: servers
      .filter((server) => (typeof server?.status === "string" ? server.status : server?.status?.status) === "connected")
      .map((server) => ({ name: server.name, status: "connected" })),
    skills: availableSkills,
    skillSearchPaths: [],
    totals: { skillTokens: availableSkills.reduce((sum, skill) => sum + skill.estimatedTokens, 0) },
  }
}

export default Plugin.define({
  id: "opencode-context-preview.tui",

  async setup(context) {
    const location = context.location ?? context.data.location.default()
    if (!location) return
    const disabledFile = skillToggleFile(projectRoot(context, location))

    try {
      const disabled = await disabledSkillSet(disabledFile)
      const report = await buildReport(context, location, disabled)
      context.ui.toast.show({
        title: "Context preview",
        message: formatToast(report),
        variant: "info",
        duration: 10000,
      })
    } catch (error) {
      console.warn(`[opencode-context-preview] Could not show TUI preview: ${String(error)}`)
    }

    if (typeof context.client?.rpc !== "function") return
    const rpc = context.client.rpc(ContextPreviewRpc)
    const unsubscribe = rpc.events.on("toast", (event) => {
      if (event.location?.directory && location.directory && path.resolve(event.location.directory) !== path.resolve(location.directory)) return
      context.ui.toast.show(event.data)
    })
    return unsubscribe
  },
})
