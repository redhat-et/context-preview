import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { skillToggleFile } from "./lib/cache.js"
import { estimateTokens, formatToast } from "./lib/report.js"

function disabledSkillSet(file) {
  return readFile(file, "utf8")
    .then((content) => {
      const value = JSON.parse(content)
      return new Set(Array.isArray(value.disabledSkills) ? value.disabledSkills.filter((name) => typeof name === "string") : [])
    })
    .catch(() => new Set())
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
    .filter((skill) => !disabled.has(skill.id) && !disabled.has(skill.name))

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

async function writeDisabledSkills(file, disabled) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify({ disabledSkills: [...disabled].sort() }, null, 2)}\n`, { mode: 0o600 })
}

function parseArguments(text) {
  const [first, second] = String(text ?? "").trim().split(/\s+/)
  if (!first) return { action: "list" }
  const actions = ["list", "on", "off", "toggle"]
  const action = actions.includes(first) ? first : "toggle"
  const name = actions.includes(first) ? second : first
  if (!actions.includes(first) && second) return { error: "Use: /skill-toggle [list|on|off|toggle] [name]" }
  if (action !== "list" && !name) return { error: `Use: /skill-toggle ${action} <name>` }
  return { action, name }
}

function skillDisabled(skill, disabled) {
  return disabled.has(skill.id) || disabled.has(skill.name)
}

function skillMessage(skills, disabled) {
  if (skills.length === 0) return "No skills are available to toggle."
  return skills.map((skill) => `${skillDisabled(skill, disabled) ? "off" : "on "} ${skill.name ?? skill.id}`).join("\n")
}

export default Plugin.define({
  id: "opencode-context-preview.tui",

  async setup(context) {
    const location = context.location ?? context.data.location.default()
    if (!location) return
    const directory = location.directory ?? process.cwd()
    const disabledFile = skillToggleFile(directory)
    let showing = false

    const show = async () => {
      if (showing) return
      showing = true
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
      } finally {
        showing = false
      }
    }

    await show()

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-context-preview.skill-toggle",
          title: "List or toggle skills",
          group: "Context preview",
          palette: true,
          slash: { name: "skill-toggle", arguments: true },
          enabled: () => true,
          run: async (input) => {
            await context.data.location.skill.sync(location)
            const disabled = await disabledSkillSet(disabledFile)
            const skills = (context.data.location.skill.list(location) ?? [])
              .filter((skill) => skill?.autoinvoke !== false && skill?.description)
              .map((skill) => ({ id: skill.id, name: skill.name ?? skill.id }))
              .sort((left, right) => left.name.localeCompare(right.name))
            const parsed = parseArguments(input)
            if (parsed.error) {
              context.ui.toast.show({ title: "Agent skills", message: parsed.error, variant: "error", duration: 5000 })
              return
            }
            if (parsed.action === "list") {
              context.ui.toast.show({ title: "Agent skills", message: skillMessage(skills, disabled), variant: "info", duration: 10000 })
              return
            }

            const allSkills = parsed.name === "all" && (parsed.action === "on" || parsed.action === "off")
            let message
            if (allSkills) {
              disabled.clear()
              if (parsed.action === "off") for (const skill of skills) disabled.add(skill.id)
              message = `All skills: ${parsed.action}`
            } else {
              const skill = skills.find((entry) => entry.id === parsed.name || entry.name === parsed.name)
              if (!skill) {
                context.ui.toast.show({ title: "Agent skills", message: `Unknown skill: ${parsed.name}`, variant: "error", duration: 5000 })
                return
              }
              if (parsed.action === "on") {
                disabled.delete(skill.id)
                disabled.delete(skill.name)
              } else if (parsed.action === "off") disabled.add(skill.id)
              else if (skillDisabled(skill, disabled)) {
                disabled.delete(skill.id)
                disabled.delete(skill.name)
              } else disabled.add(skill.id)
              message = `${skill.name}: ${skillDisabled(skill, disabled) ? "off" : "on"}`
            }

            await writeDisabledSkills(disabledFile, disabled)
            context.ui.toast.show({
              title: "Agent skills",
              message: `${message}. Start a new session to clear the old context.`,
              variant: "info",
              duration: 5000,
            })
          },
        },
      ],
    }))

    return context.data.listen(({ details }) => {
      if (details?.type === "skill.updated") void show()
    })
  },
})
