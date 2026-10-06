import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ContextPreviewPlugin } from "../index.js"
import { reportCacheFile, skillToggleFile } from "../lib/cache.js"
import {
  estimateTokens,
  formatReport,
  formatToast,
  isSkillAllowed,
  parseAvailableSkills,
  parseSkillMarkdown,
} from "../lib/report.js"

test("estimates Unicode text in four-character units", () => {
  assert.equal(estimateTokens("1234"), 1)
  assert.equal(estimateTokens("12345"), 2)
  assert.equal(estimateTokens("🙂🙂🙂🙂"), 1)
})

test("parses required skill frontmatter and block descriptions", () => {
  assert.deepEqual(
    parseSkillMarkdown("---\nname: review\ndescription: >\n  Review changes\n  for correctness\n---\nBody", "review"),
    { name: "review", description: "Review changes for correctness" },
  )
  assert.equal(parseSkillMarkdown("# no frontmatter", "missing"), undefined)
})

test("parses active skill entries from OpenCode's system prompt", () => {
  assert.deepEqual(
    parseAvailableSkills([
      "Skills provide specialized instructions.",
      "<available_skills>\n  <skill>\n    <name>customize-opencode</name>\n    <description>Edit OpenCode config</description>\n  </skill>\n</available_skills>",
    ]),
    [{ name: "customize-opencode", description: "Edit OpenCode config" }],
  )
  assert.deepEqual(parseAvailableSkills(["No skills are currently available."]), [])
  assert.equal(parseAvailableSkills(["system prompt without a skill list"]), undefined)
})

test("honors the most specific skill deny rule", () => {
  assert.equal(isSkillAllowed("internal-db", { "*": "deny", "internal-*": "allow", "internal-db": "deny" }), false)
  assert.equal(isSkillAllowed("public-docs", { "internal-*": "deny" }), true)
})

test("formats the full report and itemized startup toast", () => {
  const report = {
    generatedAt: "2026-09-28T00:00:00.000Z",
    estimateMethod: "Approximate character heuristic.",
    mcpServers: [{ name: "github", status: "connected" }],
    skills: [{ name: "review", source: "project", estimatedTokens: 4 }],
    totals: { skillTokens: 4 },
  }
  assert.match(formatReport(report), /Active MCP servers: 1/)
  assert.match(formatReport(report), /github \[connected\]/)
  assert.doesNotMatch(formatReport(report), /tools|tokens.*MCP/)
  assert.match(formatToast(report), /MCP github: connected/)
  assert.match(formatToast(report), /Skill review: ~4 tokens/)
  assert.match(formatToast(report), /Toggle these on & off with \/mcp or \/skill-toggle/)
  assert.doesNotMatch(formatToast(report), /MCP values list active servers/)
})

test("formats active MCP servers without tool details", () => {
  const report = {
    generatedAt: "2026-09-28T00:00:00.000Z",
    estimateMethod: "Approximate character heuristic.",
    mcpServers: [{
      name: "github",
      status: "connected",
    }],
    skills: [],
    skillSearchPaths: [],
    totals: { skillTokens: 0 },
  }
  assert.match(formatReport(report), /github \[connected\]/)
  assert.doesNotMatch(formatReport(report), /unavailable|tools/)
  assert.match(formatToast(report), /MCP github: connected/)
})

test("includes every MCP and skill row in the startup toast", () => {
  const report = {
    mcpServers: [{ name: "mcp-1", status: "connected" }],
    skills: Array.from({ length: 8 }, (_, index) => ({ name: `skill-${index}`, estimatedTokens: index + 1 })),
    totals: { skillTokens: 36 },
  }
  const toast = formatToast(report)
  assert.match(toast, /Skill skill-7: ~8 tokens/)
  assert.doesNotMatch(toast, /more;/)
})

test("builds the startup toast and saves a CLI-readable report", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-context-preview-"))
  const previousCacheDirectory = process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
  const cacheDirectory = path.join(temp, "cache")
  const project = path.join(temp, "project")
  await mkdir(path.join(project, ".opencode", "skills", "review"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "skills", "private-skill"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "skill", "legacy"), { recursive: true })
  await mkdir(path.join(project, ".claude", "skills", "claude-skill"), { recursive: true })
  await mkdir(path.join(project, "vendor", "skills", "custom-path-skill"), { recursive: true })
  const linkedSkill = path.join(temp, "linked-skill")
  await mkdir(linkedSkill, { recursive: true })
  await mkdir(path.join(project, ".agents", "skills"), { recursive: true })
  await symlink(linkedSkill, path.join(project, ".agents", "skills", "linked-skill"), "dir")
  await writeFile(
    path.join(project, ".opencode", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review changes carefully\n---\nInstructions",
  )
  await writeFile(
    path.join(project, ".opencode", "skills", "private-skill", "SKILL.md"),
    "---\nname: private-skill\ndescription: Hidden skill\n---\nInstructions",
  )
  await writeFile(
    path.join(project, ".opencode", "skill", "legacy", "SKILL.md"),
    "---\nname: legacy\ndescription: Legacy singular skill path\n---\nInstructions",
  )
  await writeFile(
    path.join(project, ".claude", "skills", "claude-skill", "SKILL.md"),
    "---\nname: claude-skill\ndescription: Skill imported from Claude\n---\nInstructions",
  )
  await writeFile(
    path.join(project, "vendor", "skills", "custom-path-skill", "SKILL.md"),
    "---\nname: custom-path-skill\ndescription: Skill from configured path\n---\nInstructions",
  )
  await writeFile(
    path.join(linkedSkill, "SKILL.md"),
    "---\nname: linked-skill\ndescription: Skill installed through a symlink\n---\nInstructions",
  )
  process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = cacheDirectory
  t.after(async () => {
    if (previousCacheDirectory === undefined) delete process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
    else process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = previousCacheDirectory
    await rm(temp, { recursive: true, force: true })
  })

  const toastBodies = []
  const executedCommands = []
  const logs = []
  let requestedModel
  const client = {
    config: {
      get: async () => ({
        data: {
          model: "openai/gpt-test",
          default_agent: "build",
          mcp: {
            search: { type: "remote", url: "https://example.test/mcp" },
            disabled: { type: "remote", url: "https://disabled.test/mcp", enabled: false },
          },
          permission: { skill: { "private-*": "deny" } },
          skills: { paths: ["./vendor/skills"] },
          tools: { search_private: false },
          agent: { build: { tools: {} } },
        },
      }),
      providers: async () => ({ data: { default: { openai: "gpt-test" } } }),
    },
    mcp: {
      status: async () => ({ data: { search: { status: "connected" }, disabled: { status: "disabled" } } }),
    },
    tool: {
      list: async ({ query }) => {
        requestedModel = query
        return {
          data: [
            { id: "search_lookup", description: "Search documents", parameters: { query: { type: "string" } } },
            { id: "search_private", description: "Not enabled", parameters: {} },
          ],
        }
      },
    },
    tui: {
      executeCommand: async ({ body }) => {
        executedCommands.push(body.command)
        return { data: true }
      },
      showToast: async ({ body }) => {
        toastBodies.push(body)
        return { data: true }
      },
    },
    app: {
      log: async ({ body }) => {
        logs.push(body)
        return { data: true }
      },
    },
  }

  const hooks = await ContextPreviewPlugin({ client, directory: project, worktree: "/" })
  assert.equal(requestedModel, undefined)
  assert.equal(toastBodies.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 150))
   assert.equal(requestedModel, undefined)
  assert.equal(toastBodies.length, 1)
  assert.match(toastBodies[0].message, /MCP search:/)
  assert.match(toastBodies[0].message, /Skill review:/)
  assert.match(toastBodies[0].message, /Skill legacy:/)
  assert.match(toastBodies[0].message, /Skill claude-skill:/)
  assert.match(toastBodies[0].message, /Skill custom-path-skill:/)
  assert.match(toastBodies[0].message, /Skill linked-skill:/)
  assert.doesNotMatch(toastBodies[0].message, /private-skill|MCP disabled/)
  assert.deepEqual(logs, [])
  await hooks["chat.message"]({}, { parts: [{ type: "text", text: "First visible prompt" }] })
  await hooks["experimental.chat.system.transform"]({}, {
    system: [
      "<available_skills>",
      "<skill><name>claude-skill</name><description>Skill imported from Claude</description></skill>",
      "<skill><name>custom-path-skill</name><description>Skill from configured path</description></skill>",
      "<skill><name>legacy</name><description>Legacy singular skill path</description></skill>",
      "<skill><name>linked-skill</name><description>Skill installed through a symlink</description></skill>",
      "<skill><name>review</name><description>Review changes carefully</description></skill>",
      "</available_skills>",
    ],
  })
  const canonicalProject = await realpath(project)
  const cachedReport = JSON.parse(await readFile(reportCacheFile(canonicalProject), "utf8"))
   assert.doesNotMatch(JSON.stringify(cachedReport), /search_lookup/)
  assert.equal(cachedReport.worktree, canonicalProject)
  assert.ok(cachedReport.skillSearchPaths.includes(path.join(project, ".opencode", "skills")))
  assert.ok(cachedReport.skillSearchPaths.includes(path.join(project, ".claude", "skills")))
  assert.ok(!cachedReport.skillSearchPaths.includes("/.opencode/skills"))

  const cli = path.resolve("bin/context-preview.js")
  const output = execFileSync(process.execPath, [cli], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONTEXT_PREVIEW_CACHE_DIR: cacheDirectory },
  })
   assert.doesNotMatch(output, /search_lookup|Search documents/)
  assert.match(output, /review: ~/)
  assert.match(output, /legacy: ~/)
  assert.match(output, /claude-skill: ~/)
  assert.match(output, /custom-path-skill: ~/)
  assert.match(output, /linked-skill: ~/)
  assert.doesNotMatch(output, /private-skill|search_private|MCP disabled/)
  assert.equal(typeof hooks.event, "function")
  const commandConfig = {}
  await hooks.config(commandConfig)
  assert.equal(commandConfig.command["skill-toggle"].description, "List or toggle skills; toggling starts a new session")
  await assert.rejects(
    hooks["command.execute.before"]({ command: "skill-toggle", arguments: "review" }, { parts: [] }),
    /Skill command handled/,
  )
  const providerSystem = [
    "<available_skills><skill><name>review</name><description>Review changes carefully</description></skill><skill><name>legacy</name><description>Legacy singular skill path</description></skill></available_skills>",
    "Project instructions mention review and Review changes carefully.",
  ]
  const filtered = { system: providerSystem }
  await hooks["experimental.chat.system.transform"]({}, filtered)
  assert.equal(filtered.system, providerSystem)
  assert.doesNotMatch(providerSystem.join("\n"), /review|Review changes carefully/)
  const nextPrompt = { parts: [{ type: "text", text: "What skills do you have?" }] }
  await hooks["chat.message"]({}, nextPrompt)
  assert.equal(nextPrompt.parts.length, 1)
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "skill" }, { args: { name: "review" } }),
    /Skill is disabled: review/,
  )
  const skillDefinition = {
    description: "<available_skills><skill><name>review</name><description>Review changes carefully</description></skill></available_skills>",
    parameters: {},
  }
  await hooks["tool.definition"]({ toolID: "skill" }, skillDefinition)
  assert.doesNotMatch(skillDefinition.description, /review/i)
  await assert.rejects(
    hooks["command.execute.before"]({ command: "skill-toggle", arguments: "on review" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(executedCommands, ["session_new", "session_new"])
  await hooks["experimental.chat.system.transform"]({}, {
    system: [
      "<available_skills><skill><name>customize-opencode</name><description>Built-in skill</description></skill></available_skills>",
    ],
  })
  assert.equal(toastBodies.length, 3)
  await hooks.event({ event: { type: "session.created" } })
  assert.equal(toastBodies.length, 3)

  await assert.rejects(
    hooks["command.execute.before"]({ command: "skill-toggle", arguments: "off review" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["review"] })
  const { ContextPreviewPlugin: FreshContextPreviewPlugin } = await import(`../index.js?persisted=${Date.now()}`)
  const recreatedHooks = await FreshContextPreviewPlugin({ client, directory: project, worktree: "/" })
  const recreatedProviderSystem = [
    "<available_skills><skill><name>review</name><description>Review changes carefully</description></skill><skill><name>legacy</name><description>Legacy singular skill path</description></skill></available_skills>",
  ]
  const recreatedSystem = { system: recreatedProviderSystem }
  await recreatedHooks["experimental.chat.system.transform"]({}, recreatedSystem)
  assert.equal(recreatedSystem.system, recreatedProviderSystem)
  assert.doesNotMatch(recreatedProviderSystem[0], /<name>review<\/name>/)
  assert.match(recreatedProviderSystem[0], /<name>legacy<\/name>/)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(toastBodies.length >= 4)
  assert.doesNotMatch(toastBodies.at(-1).message, /Skill review:/)
  const persistedReport = JSON.parse(await readFile(reportCacheFile(canonicalProject), "utf8"))
  assert.doesNotMatch(JSON.stringify(persistedReport), /"name": "review"/)
})

test("stops the first provider-bound message if the preview was not shown yet", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-context-preview-gate-"))
  const previousCacheDirectory = process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
  process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = path.join(temp, "cache")
  t.after(async () => {
    if (previousCacheDirectory === undefined) delete process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
    else process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = previousCacheDirectory
    await rm(temp, { recursive: true, force: true })
  })

  const toastBodies = []
  const appended = []
  const client = {
    config: {
      get: async () => ({
        data: {
          model: "openai/gpt-test",
          mcp: { search: { type: "remote", url: "https://example.test/mcp" } },
          tools: {},
          agent: { build: {} },
        },
      }),
      providers: async () => ({ data: { default: { openai: "gpt-test" } } }),
    },
    mcp: { status: async () => ({ data: { search: { status: "connected" } } }) },
    tool: { list: async () => ({ data: [] }) },
    tui: {
      showToast: async ({ body }) => {
        toastBodies.push(body)
        return { data: true }
      },
      appendPrompt: async ({ body }) => {
        appended.push(body.text)
        return { data: true }
      },
    },
    app: { log: async () => ({ data: true }) },
  }
  const hooks = await ContextPreviewPlugin({ client, directory: temp, worktree: temp })
  const message = { parts: [{ type: "text", text: "First request", synthetic: false }] }

  await assert.rejects(
    hooks["chat.message"]({}, message),
    /stopped before reaching the model/,
  )
  assert.equal(toastBodies.length, 1)
   assert.match(toastBodies[0].message, /MCP search: connected/)
  assert.deepEqual(appended, ["First request"])
  const cached = JSON.parse(await readFile(reportCacheFile(await realpath(temp)), "utf8"))
   assert.equal(cached.mcpServers[0].status, "connected")

  await hooks["chat.message"]({}, message)
  assert.equal(toastBodies.length, 1)
})
