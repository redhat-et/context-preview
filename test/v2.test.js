import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import plugin, { ContextPreviewV2Plugin } from "../index.js"
import { reportCacheFile, skillToggleFile } from "../lib/cache.js"
import { ContextPreviewRpc } from "../rpc.js"

test("exports a V2 definition and a separate V1 server entrypoint", () => {
  assert.equal(plugin.id, "opencode-context-preview")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(plugin.setup, ContextPreviewV2Plugin.setup)
  assert.equal(typeof plugin.server, "function")
})

test("registers V2 report, toggle, filtering, and cleanup behavior", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-context-preview-v2-"))
  const previousCacheDirectory = process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
  process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = path.join(temp, "cache")
  await mkdir(path.join(temp, "project"), { recursive: true })
  const project = path.join(temp, "project")
  const originalInfo = console.info
  console.info = () => {}
  t.after(async () => {
    console.info = originalInfo
    if (previousCacheDirectory === undefined) delete process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
    else process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = previousCacheDirectory
    await rm(temp, { recursive: true, force: true })
  })

  const skills = [
    { id: "code-review", name: "Code Review", description: "Review changes", path: path.join(project, "review", "SKILL.md") },
    { id: "docs", name: "docs", description: "Write documentation", path: path.join(project, "docs", "SKILL.md") },
    { id: "go", name: "Go", description: "Use ongoing guidance", path: path.join(project, "go", "SKILL.md") },
    { id: "name", name: "name", description: "Use the named skill", path: path.join(project, "name", "SKILL.md") },
    { id: "hidden", name: "Hidden", description: "Not advertised", autoinvoke: false, path: path.join(project, "hidden", "SKILL.md") },
  ]
  let command
  let skillTransform
  let toolTransform
  const toolHooks = new Map()
  const sessionHooks = new Map()
  let subscribeOptions
  let emitEvent
  let resolveRefresh
  let visibleSkills = skills
  let skillListCalls = 0
  const rpcEvents = []
  const refreshObserved = new Promise((resolve) => {
    resolveRefresh = resolve
  })
  const reloads = []
  const ctx = {
    options: {},
    location: {
      directory: project,
      project: { id: "project", directory: project, canonical: project },
    },
    mcp: {
      list: async () => ({ data: [{ name: "github", status: { status: "connected" } }] }),
    },
    rpc: {
      register: async (definition, handlers) => {
        assert.equal(definition, ContextPreviewRpc)
        assert.deepEqual(Object.keys(handlers), [])
        return { events: { emit: async (name, data) => rpcEvents.push({ name, data }) } }
      },
    },
    skill: {
      list: async () => {
        skillListCalls += 1
        if (skillListCalls === 2) resolveRefresh()
        return { data: visibleSkills }
      },
      transform: async (callback) => {
        skillTransform = callback
        callback({ list: () => skills, remove: (id) => reloads.push(`remove:${id}`) })
      },
      reload: async () => {
        reloads.push("skills")
        visibleSkills = reloads.filter((entry) => entry === "skills").length === 1 ? skills.filter((skill) => skill.id !== "code-review") : skills
      },
    },
    tool: {
      transform: async (callback) => {
        toolTransform = callback
      },
      hook: async (name, callback) => toolHooks.set(name, callback),
      reload: async () => reloads.push("tools"),
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => { command = definition } })
      },
    },
    session: {
      hook: async (name, callback) => sessionHooks.set(name, callback),
    },
    event: {
      subscribe: (options) => {
        subscribeOptions = options
        return (async function* () {
          while (!options.signal.aborted) {
            const event = await new Promise((resolve) => {
              emitEvent = (next) => {
                emitEvent = undefined
                resolve(next)
              }
              options.signal.addEventListener("abort", () => resolve(undefined), { once: true })
            })
            if (!event) return
            yield event
          }
        })()
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  assert.equal(command.name, "skill-toggle")
  assert.equal(typeof command.execute, "function")
  assert.doesNotMatch(await readFile(reportCacheFile(await realpath(project)), "utf8"), /Not advertised/)
  assert.equal(typeof skillTransform, "function")
  assert.equal(typeof toolTransform, "function")
  assert.deepEqual([...toolHooks.keys()], ["execute.before"])
  assert.deepEqual([...sessionHooks.keys()], ["prompt", "context", "compaction", "generate", "title"])
  assert.ok(subscribeOptions.signal instanceof AbortSignal)

  await command.execute({ prompt: { text: "/skill-toggle off code-review" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review"] })
  assert.ok(reloads.includes("skills"))
  assert.ok(reloads.includes("tools"))
  assert.equal(rpcEvents.at(-1).name, "toast")
  assert.match(rpcEvents.at(-1).data.message, /Code Review: off/)
  await assert.rejects(
    toolHooks.get("execute.before")({ tool: "skill", input: { id: "code-review" } }),
    /Skill is disabled: code-review/,
  )

  const transformedTool = { description: "Load <available_skills><skill><name>Code Review</name><description>Review changes</description></skill></available_skills>" }
  toolTransform({
    update: (id, update) => {
      assert.equal(id, "skill")
      update(transformedTool)
    },
  })
  assert.doesNotMatch(transformedTool.description, /review/i)

  skillTransform({ list: () => skills, remove: (id) => reloads.push(`removed:${id}`) })
  assert.ok(reloads.includes("removed:code-review"))

  const context = {
    system: [{
      type: "text",
      text: "<available_skills><skill><id>code-review</id><name>Code Review</name><description>Review changes</description></skill><skill><id>docs</id><name>docs</name><description>Write documentation</description></skill></available_skills>",
    }],
  }
  await sessionHooks.get("context")(context)
  assert.doesNotMatch(context.system[0].text, /<name>Code Review<\/name>/)
  assert.match(context.system[0].text, /<name>docs<\/name>/)

  await new Promise((resolve) => setImmediate(resolve))
  emitEvent({ type: "skill.updated", location: { directory: project } })
  await refreshObserved
  await new Promise((resolve) => setImmediate(resolve))
  await command.execute({ prompt: { text: "/skill-toggle on code-review" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })
  await assert.doesNotReject(toolHooks.get("execute.before")({ tool: "skill", input: { id: "code-review" } }))
  await command.execute({ prompt: { text: "/skill-toggle list" } })
  assert.match(rpcEvents.at(-1).data.message, /Code Review/)

  await command.execute({ prompt: { text: "/skill-toggle off go" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["go"] })

  const shortSkillTool = {
    description: [
      "Keep ongoing goals and guidance.",
      "<available_skills>",
      "<skill><id>go</id><name>Go</name><description>Use go here</description></skill>",
      "<skill><id>docs</id><name>docs</name><description>Keep ongoing guidance</description></skill>",
      "</available_skills>",
    ].join(""),
  }
  toolTransform({
    update: (id, update) => {
      assert.equal(id, "skill")
      update(shortSkillTool)
    },
  })
  assert.doesNotMatch(shortSkillTool.description, /<name>Go<\/name>/)
  assert.match(shortSkillTool.description, /ongoing goals and guidance/)
  assert.match(shortSkillTool.description, /Keep ongoing guidance/)

  const shortSkillContext = {
    system: [{
      type: "text",
      text: "Keep ongoing instructions. <available_skills><skill><id>go</id><name>Go</name><description>Use go here</description></skill><skill><id>docs</id><name>docs</name><description>Keep ongoing guidance</description></skill></available_skills>",
    }],
  }
  await sessionHooks.get("context")(shortSkillContext)
  assert.doesNotMatch(shortSkillContext.system[0].text, /<name>Go<\/name>/)
  assert.match(shortSkillContext.system[0].text, /Keep ongoing instructions/)
  assert.match(shortSkillContext.system[0].text, /Keep ongoing guidance/)

  await command.execute({ prompt: { text: "/skill-toggle on go" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })
  await command.execute({ prompt: { text: "/skill-toggle toggle go" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["go"] })
  await command.execute({ prompt: { text: "/skill-toggle toggle go" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })

  await command.execute({ prompt: { text: "/skill-toggle off name" } })
  const tagContext = {
    system: [{
      type: "text",
      text: "<available_skills><skill><id>name</id><name>name</name><description>Use the named skill</description></skill><skill><id>docs</id><name>docs</name><description>Write documentation</description></skill></available_skills>",
    }],
  }
  await sessionHooks.get("context")(tagContext)
  assert.doesNotMatch(tagContext.system[0].text, /<name>name<\/name>/)
  assert.match(tagContext.system[0].text, /<name>docs<\/name>/)
  await command.execute({ prompt: { text: "/skill-toggle on name" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })
  await command.execute({ prompt: { text: "/skill-toggle list" } })
  assert.match(rpcEvents.at(-1).data.message, /Code Review/)
  await command.execute({ prompt: { text: "/skill-toggle off all" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), {
    disabledSkills: ["code-review", "docs", "go", "name"],
  })
  await command.execute({ prompt: { text: "/skill-toggle on all" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })

  await cleanup()
  assert.equal(subscribeOptions.signal.aborted, true)
  assert.ok(JSON.parse(await readFile(reportCacheFile(await realpath(project)), "utf8")).mcpServers.some((server) => server.name === "github"))
})

test("shares canonical toggle keys between V1 and V2", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-context-preview-toggle-"))
  const previousCacheDirectory = process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
  const previousInfo = console.info
  process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = path.join(temp, "cache")
  console.info = () => {}
  const project = path.join(temp, "project")
  await mkdir(path.join(temp, "cache"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "skills", "code-review"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "skills", "github"), { recursive: true })
  await writeFile(
    path.join(project, ".opencode", "skills", "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review changes\n---\nInstructions",
  )
  await writeFile(
    path.join(project, ".opencode", "skills", "github", "SKILL.md"),
    "---\nname: github\ndescription: Use GitHub\n---\nInstructions",
  )
  await writeFile(skillToggleFile(project), `${JSON.stringify({ disabledSkills: ["Code Review", "code-review"] })}\n`)
  t.after(async () => {
    console.info = previousInfo
    if (previousCacheDirectory === undefined) delete process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR
    else process.env.OPENCODE_CONTEXT_PREVIEW_CACHE_DIR = previousCacheDirectory
    await rm(temp, { recursive: true, force: true })
  })

  const skills = [{
    id: "code-review",
    name: "Code Review",
    description: "Review changes",
    path: path.join(project, "review", "SKILL.md"),
  }, {
    id: "github",
    name: "GitHub",
    description: "Use GitHub",
    path: path.join(project, "github", "SKILL.md"),
  }]
  let v2Command
  let v2Hook
  const v2Context = {
    location: {
      directory: project,
      project: { id: "project", directory: project, canonical: project },
    },
    mcp: { list: async () => ({ data: [] }) },
    skill: {
      list: async () => ({ data: skills }),
      transform: async (callback) => callback({ list: () => skills, remove: () => {} }),
      reload: async () => {},
    },
    tool: {
      transform: async () => {},
      hook: async (name, callback) => {
        assert.equal(name, "execute.before")
        v2Hook = callback
      },
      reload: async () => {},
    },
    command: {
      transform: async (callback) => callback({ add: (definition) => { v2Command = definition } }),
    },
  }

  const cleanup = await ContextPreviewV2Plugin.setup(v2Context)
  const client = {
    config: { get: async () => ({ data: {} }) },
    mcp: { status: async () => ({ data: {} }) },
    tui: {
      executeCommand: async () => ({ data: true }),
      showToast: async () => ({ data: true }),
      appendPrompt: async () => ({ data: true }),
    },
    app: { log: async () => ({ data: true }) },
  }
  const v1Hooks = await plugin.server({ client, directory: project, worktree: "/" }, { blockFirstPrompt: false })

  await assert.rejects(
    v1Hooks["command.execute.before"]({ command: "skill-toggle", arguments: "on code-review" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })

  await v2Command.execute({ prompt: { text: "/skill-toggle off code-review" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review"] })
  const v1DisplayOnlySystem = {
    system: ["<available_skills><skill><name>Code Review</name><description>Review changes</description></skill></available_skills>"],
  }
  await v1Hooks["experimental.chat.system.transform"]({}, v1DisplayOnlySystem)
  assert.doesNotMatch(v1DisplayOnlySystem.system[0], /<name>Code Review<\/name>/)
  await assert.rejects(
    v1Hooks["command.execute.before"]({ command: "skill-toggle", arguments: "off Code Review" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review"] })
  await assert.rejects(
    v1Hooks["tool.execute.before"]({ tool: "skill" }, { args: { name: "Code Review" } }),
    /Skill is disabled: Code Review/,
  )
  await assert.rejects(v2Hook({ tool: "skill", input: { id: "code-review" } }), /Skill is disabled: code-review/)

  await v2Command.execute({ prompt: { text: "/skill-toggle off github" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review", "github"] })
  await assert.rejects(
    v1Hooks["tool.execute.before"]({ tool: "skill" }, { args: { name: "GitHub" } }),
    /Skill is disabled: GitHub/,
  )
  await assert.rejects(
    v1Hooks["command.execute.before"]({ command: "skill-toggle", arguments: "on GitHub" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review"] })

  await assert.rejects(
    v1Hooks["command.execute.before"]({ command: "skill-toggle", arguments: "off code-review" }, { parts: [] }),
    /Skill command handled/,
  )
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["code-review"] })
  await v2Command.execute({ prompt: { text: "/skill-toggle on code-review" } })
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: [] })
  await assert.doesNotReject(v2Hook({ tool: "skill", input: { id: "code-review" } }))

  await new Promise((resolve) => setTimeout(resolve, 150))
  await cleanup()
})
