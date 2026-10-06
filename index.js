import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { reportCacheFile, skillToggleFile } from "./lib/cache.js"
import {
  estimateTokens,
  formatToast,
  isSkillAllowed,
  parseAvailableSkills,
  parseSkillMarkdown,
} from "./lib/report.js"

const SKILL_LOCATIONS = [
  [".opencode", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
]

// Plugin instances can be recreated while the OpenCode process remains alive.
// Keep toggles at runtime scope so a session transition does not re-enable skills.
const disabledSkillsByProject = new Map()

function valueOf(result) {
  return result?.data ?? result
}

function skillCommandMessage(skills, disabled) {
  if (skills.length === 0) return "No skills are available to toggle."
  return skills
    .map((skill) => `${disabled.has(skill.name) ? "off" : "on "} ${skill.name}`)
    .join("\n")
}

function filterDisabledSkills(system, disabled) {
  if (disabled.size === 0) return system
  const filtered = system.map((text) => {
    if (!text.includes("<available_skills>")) return text
    return text.replace(/\s*<skill>[\s\S]*?<\/skill>/g, (entry) => {
      const name = entry.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1]
      return name && disabled.has(name) ? "" : entry
    })
  })
  return filtered
}

function redactDisabledSkillText(text, disabled, knownSkills) {
  let redacted = text
  for (const name of disabled) {
    const skill = knownSkills.get(name)
    for (const value of [name, skill?.description]) {
      if (!value) continue
      redacted = redacted.replaceAll(value, "")
    }
  }
  return redacted
}

function parseSkillCommand(argumentsText) {
  const [first, second] = argumentsText.trim().split(/\s+/)
  if (!first) return { action: "list" }
  const actions = ["list", "on", "off", "toggle"]
  const action = actions.includes(first) ? first : "toggle"
  const name = actions.includes(first) ? second : first
  if (!actions.includes(first) && second) return { error: "Use: /skill-toggle [list|on|off|toggle] [name]" }
  if (action !== "list" && !name) return { error: `Use: /skill-toggle ${action} <name>` }
  return { action, name }
}

function projectRoot(directory, worktree) {
  const resolvedDirectory = path.resolve(directory || worktree || process.cwd())
  const resolvedWorktree = path.resolve(worktree || resolvedDirectory)
  if (resolvedWorktree === path.parse(resolvedWorktree).root) return resolvedDirectory

  const relative = path.relative(resolvedWorktree, resolvedDirectory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return resolvedDirectory
  }
  return resolvedWorktree
}

async function readSkillFile(file, fallbackName, source, permission, found) {
  let content
  try {
    content = await readFile(file, "utf8")
  } catch {
    return
  }
  const skill = parseSkillMarkdown(content, fallbackName)
  if (!skill || !isSkillAllowed(skill.name, permission) || found.has(skill.name)) return
  const descriptor = JSON.stringify({ name: skill.name, description: skill.description })
  found.set(skill.name, {
    ...skill,
    source,
    estimatedTokens: estimateTokens(descriptor),
  })
}

async function readSkillsFrom(root, source, permission, found, recursive = false) {
  const pending = [root]
  const visited = new Set()
  while (pending.length) {
    const current = pending.pop()
    let canonical
    try {
      canonical = await realpath(current)
    } catch {
      continue
    }
    if (visited.has(canonical)) continue
    visited.add(canonical)

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    if (current === root) await readSkillFile(path.join(current, "SKILL.md"), path.basename(current), source, permission, found)
    for (const entry of entries) {
      let isDirectory = entry.isDirectory()
      const child = path.join(current, entry.name)
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(child)).isDirectory()
        } catch {
          continue
        }
      }
      if (!isDirectory) continue
      await readSkillFile(path.join(child, "SKILL.md"), entry.name, source, permission, found)
      if (recursive) pending.push(child)
    }
  }
}

async function discoverSkills(directory, worktree, config, agentConfig) {
  if ((agentConfig.tools?.skill ?? config.tools?.skill) === false) return { skills: [], searched: [] }
  const found = new Map()
  const searched = []
  const boundary = projectRoot(directory, worktree)
  let current = path.resolve(directory || boundary)
  const permission = {
    ...(config.permission?.skill ?? {}),
    ...(agentConfig.permission?.skill ?? {}),
  }

  while (true) {
    for (const [base, skills] of SKILL_LOCATIONS) {
      for (const container of [skills, "skill"]) {
        const root = path.join(current, base, container)
        searched.push(root)
        await readSkillsFrom(root, "project", permission, found)
      }
    }
    if (current === boundary || path.dirname(current) === current) break
    current = path.dirname(current)
  }

  const home = os.homedir()
  const globalLocations = [
    ...(process.env.OPENCODE_CONFIG_DIR
      ? [
          [path.join(process.env.OPENCODE_CONFIG_DIR, "skills"), "custom:opencode"],
          [path.join(process.env.OPENCODE_CONFIG_DIR, "skill"), "custom:opencode"],
        ]
      : []),
    [path.join(home, ".config", "opencode", "skills"), "global:opencode"],
    [path.join(home, ".config", "opencode", "skill"), "global:opencode"],
    [path.join(home, ".claude", "skills"), "global:claude"],
    [path.join(home, ".claude", "skill"), "global:claude"],
    [path.join(home, ".agents", "skills"), "global:agents"],
    [path.join(home, ".agents", "skill"), "global:agents"],
  ]
  for (const [root, source] of globalLocations) {
    searched.push(root)
    await readSkillsFrom(root, source, permission, found)
  }

  for (const configuredPath of config.skills?.paths ?? []) {
    const expanded = configuredPath.startsWith("~/")
      ? path.join(home, configuredPath.slice(2))
      : configuredPath
    const root = path.isAbsolute(expanded) ? expanded : path.resolve(directory || boundary, expanded)
    searched.push(root)
    await readSkillsFrom(root, "config:custom", permission, found, true)
  }

  return {
    skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    searched,
  }
}

function activeAgentConfig(config) {
  const name = config.default_agent ?? "build"
  return config.agent?.[name] ?? config.mode?.[name] ?? {}
}

async function getMcpStatuses(client) {
  try {
    return valueOf(await client.mcp.status()) ?? {}
  } catch {
    return {}
  }
}

async function buildReport({ client, directory, worktree }) {
  const config = valueOf(await client.config.get()) ?? {}
  const agentConfig = activeAgentConfig(config)
  const statuses = await getMcpStatuses(client)
  const mcpServers = Object.entries(config.mcp ?? {})
    .filter(([, server]) => server?.enabled !== false)
    .map(([name]) => ({
      name,
      status: statuses[name]?.status ?? "unknown",
    }))
    .filter((server) => server.status === "connected")

  const { skills, searched: skillSearchPaths } = await discoverSkills(directory, worktree, config, agentConfig)
  let canonicalWorktree
  try {
    canonicalWorktree = await realpath(projectRoot(directory, worktree))
  } catch {
    canonicalWorktree = projectRoot(directory, worktree)
  }
  return {
    generatedAt: new Date().toISOString(),
    worktree: canonicalWorktree,
    estimateMethod: "Approximate: Unicode character count divided by four, rounded up.",
    mcpServers,
    skills,
    skillSearchPaths,
    totals: {
      skillTokens: skills.reduce((sum, skill) => sum + skill.estimatedTokens, 0),
    },
  }
}

async function saveReport(report) {
  const file = reportCacheFile(report.worktree)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function showStartupToast(client, report) {
  const message = formatToast(report)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const result = await client.tui.showToast({
        body: {
          title: "Context preview",
          message,
          variant: "info",
          duration: 10000,
        },
      })
      if (valueOf(result) === true) return true
    } catch {
      // The TUI may not have attached yet; retry briefly during startup.
    }
  }
  return false
}

export const ContextPreviewPlugin = async ({ client, directory, worktree }, options = {}) => {
  let reportPromise
  let currentReport
  let toastPromise
  let toastShown = false
  const runtimeKey = projectRoot(directory, worktree)
  const disabledSkills = disabledSkillsByProject.get(runtimeKey) ?? new Set()
  disabledSkillsByProject.set(runtimeKey, disabledSkills)
  const knownSkills = new Map()
  const logWarning = async (message, error) => {
    try {
      await client.app.log({
        body: {
          service: "opencode-context-preview",
          level: "warn",
          message,
          extra: { error: String(error) },
        },
      })
    } catch {
      // Diagnostics must not interfere with OpenCode startup or event handling.
    }
  }

  if (disabledSkills.size === 0) {
    try {
      const saved = JSON.parse(await readFile(skillToggleFile(runtimeKey), "utf8"))
      if (Array.isArray(saved.disabledSkills)) {
        for (const name of saved.disabledSkills) {
          if (typeof name === "string" && name) disabledSkills.add(name)
        }
      }
    } catch {
      // Missing or invalid preferences should not prevent the plugin from loading.
    }
  }

  const saveDisabledSkills = async () => {
    const file = skillToggleFile(runtimeKey)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify({ disabledSkills: [...disabledSkills].sort() }, null, 2)}\n`, { mode: 0o600 })
  }

  const startNewSession = async () => {
    try {
      if (typeof client.tui.executeCommand !== "function") return
      await client.tui.executeCommand({ body: { command: "session_new" } })
    } catch (error) {
      await logWarning("Could not start a new session after changing skill state", error)
    }
  }

  const loadReport = () => {
    if (!reportPromise) {
      reportPromise = (async () => {
        let report
        try {
          const discoveredReport = await buildReport({ client, directory, worktree })
          const enabledSkills = discoveredReport.skills.filter((skill) => !disabledSkills.has(skill.name))
          report = {
            ...discoveredReport,
            skills: enabledSkills,
            totals: {
              ...discoveredReport.totals,
              skillTokens: enabledSkills.reduce((sum, skill) => sum + skill.estimatedTokens, 0),
            },
          }
          currentReport = report
          for (const skill of discoveredReport.skills) knownSkills.set(skill.name, skill)
        } catch (error) {
          reportPromise = undefined
          await logWarning("Could not build the context preview", error)
          return
        }

        try {
          await saveReport(report)
        } catch (error) {
          await logWarning("Could not cache the context preview for the CLI", error)
        }
        return report
      })()
    }
    return reportPromise
  }

  const initialize = async () => {
    const report = await loadReport()
    if (!report || toastShown) return
    if (!toastPromise) {
      toastPromise = showStartupToast(client, report).then((shown) => {
        toastShown = shown
        toastPromise = undefined
      })
    }
    await toastPromise
  }

  const restorePromptText = async (parts) => {
    const text = parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("")
    if (!text) return false
    try {
      return valueOf(await client.tui.appendPrompt({ body: { text } })) === true
    } catch {
      return false
    }
  }

  // Start after returning the hooks so these SDK requests cannot hold up OpenCode's plugin loader.
  setTimeout(() => void initialize(), 100)

  return {
    config: async (config) => {
      config.command ??= {}
      config.command["skill-toggle"] ??= {
        description: "List or toggle skills; toggling starts a new session",
        template: "Skill toggles are handled by the context-preview plugin.",
      }
    },
    "command.execute.before": async (input) => {
      if (input.command !== "skill-toggle") return
      const parsed = parseSkillCommand(input.arguments ?? "")
      if (parsed.error) throw new Error(parsed.error)

      if (!currentReport) await loadReport()
      const skills = [...knownSkills.values()].sort((a, b) => a.name.localeCompare(b.name))
      if (parsed.action === "list") {
        await client.tui.showToast({
          body: {
            title: "Agent skills",
            message: skillCommandMessage(skills, disabledSkills),
            variant: "info",
            duration: 10000,
          },
        })
      } else {
        const skill = skills.find((entry) => entry.name === parsed.name)
        if (!skill) throw new Error(`Unknown skill: ${parsed.name}`)
        if (parsed.action === "on") disabledSkills.delete(skill.name)
        if (parsed.action === "off") disabledSkills.add(skill.name)
        if (parsed.action === "toggle") {
          if (disabledSkills.has(skill.name)) disabledSkills.delete(skill.name)
          else disabledSkills.add(skill.name)
        }
        try {
          await saveDisabledSkills()
        } catch (error) {
          await logWarning("Could not save skill toggle state", error)
        }
        await startNewSession()
        await client.tui.showToast({
          body: {
            title: "Agent skills",
            message: `${skill.name}: ${disabledSkills.has(skill.name) ? "off" : "on"}`,
            variant: "info",
            duration: 5000,
          },
        })
      }

      // A command is otherwise sent to the model after this hook completes.
      throw new Error("Skill command handled by the context-preview plugin.")
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "skill" || !disabledSkills.size) return
      const name = output.args?.name
      if (typeof name === "string" && disabledSkills.has(name)) {
        throw new Error(`Skill is disabled: ${name}`)
      }
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "skill" || !disabledSkills.size) return
      output.description = redactDisabledSkillText(
        filterDisabledSkills([output.description], disabledSkills)[0],
        disabledSkills,
        knownSkills,
      )
    },
    "chat.message": async (_input, output) => {
      if (options.blockFirstPrompt === false) return
      if (toastShown) return

      // chat.message runs before OpenCode saves the user message or starts the provider loop.
      // If this first request is what makes the preview visible, stop it before it can incur cost.
      await initialize()

      const restored = await restorePromptText(output.parts)
      const hasAttachments = output.parts.some((part) => part.type === "file")
      const recovery = restored
        ? "Your text was restored to the prompt."
        : "Please re-enter and resend your prompt after reviewing the estimate."
      const attachments = hasAttachments ? " Reattach any files or images before resending." : ""
      const reason = toastShown
        ? "Context preview displayed. This request was stopped before reaching the model."
        : "The context preview could not be displayed, so this request was stopped before reaching the model. Run opencode-context-preview to inspect the report."
      throw new Error(
        `${reason} ${recovery}${attachments}`,
      )
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const filteredSystem = filterDisabledSkills(output.system, disabledSkills)
        .map((text) => redactDisabledSkillText(text, disabledSkills, knownSkills))
      output.system.splice(0, output.system.length, ...filteredSystem)
      if (!currentReport) return
      const discovered = parseAvailableSkills(output.system)
      if (!discovered) return

      const skills = discovered.map((skill) => ({
        ...skill,
        source: "system-prompt",
        estimatedTokens: estimateTokens(JSON.stringify({ name: skill.name, description: skill.description })),
      }))
      for (const skill of skills) knownSkills.set(skill.name, skill)
      const previous = currentReport.skills
        .map(({ name, description }) => `${name}\u0000${description}`)
        .sort()
      const next = skills.map(({ name, description }) => `${name}\u0000${description}`).sort()
      if (previous.length === next.length && previous.every((item, index) => item === next[index])) return

      currentReport.skills = skills
      currentReport.totals.skillTokens = skills.reduce((sum, skill) => sum + skill.estimatedTokens, 0)
      try {
        await saveReport(currentReport)
      } catch (error) {
        await logWarning("Could not cache the system-prompt skill inventory", error)
      }
    },
    event: async ({ event }) => {
      if (event.type === "server.connected" || event.type === "session.created") await initialize()
    },
  }
}
