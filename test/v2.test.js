import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
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
  assert.deepEqual(JSON.parse(await readFile(skillToggleFile(project), "utf8")), { disabledSkills: ["Code Review", "code-review"] })
  assert.ok(reloads.includes("skills"))
  assert.ok(reloads.includes("tools"))
  assert.equal(rpcEvents.at(-1).name, "toast")
  assert.match(rpcEvents.at(-1).data.message, /Code Review: off/)
  assert.throws(
    () => toolHooks.get("execute.before")({ tool: "skill", input: { id: "code-review" } }),
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
  assert.doesNotThrow(() => toolHooks.get("execute.before")({ tool: "skill", input: { id: "code-review" } }))

  await cleanup()
  assert.equal(subscribeOptions.signal.aborted, true)
  assert.ok(JSON.parse(await readFile(reportCacheFile(await realpath(project)), "utf8")).mcpServers.some((server) => server.name === "github"))
})
