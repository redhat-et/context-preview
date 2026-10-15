import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import tui from "../tui.js"
import { ContextPreviewRpc } from "../rpc.js"

test("shows the startup preview and listens for server skill-toggle toasts", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-context-preview-tui-"))
  const project = path.join(temp, "project")
  const directory = path.join(project, "src")
  await mkdir(directory, { recursive: true })

  const toasts = []
  let eventHandler
  let unsubscribeCalls = 0
  const context = {
    location: { directory },
    data: {
      project: { list: () => [{ canonical: project }] },
      location: {
        mcp: { server: { sync: async () => {}, list: () => [{ name: "github", status: "connected" }] } },
        skill: {
          sync: async () => {},
          list: () => [{ id: "code-review", name: "Code Review", description: "Review changes" }],
        },
      },
    },
    client: {
      rpc: (definition) => {
        assert.equal(definition, ContextPreviewRpc)
        return {
          events: {
            on: (name, handler) => {
              assert.equal(name, "toast")
              eventHandler = handler
              return () => {
                unsubscribeCalls += 1
              }
            },
          },
        }
      },
    },
    ui: { toast: { show: (toast) => toasts.push(toast) } },
  }

  t.after(() => rm(temp, { recursive: true, force: true }))

  const cleanup = await tui.setup(context)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "Context preview")
  assert.equal(typeof eventHandler, "function")
  assert.equal(typeof cleanup, "function")

  eventHandler({
    location: { directory },
    data: { title: "Agent skills", message: "Code Review: off", variant: "info", duration: 5000 },
  })
  assert.equal(toasts.length, 2)
  assert.equal(toasts[1].title, "Agent skills")

  eventHandler({
    location: { directory: path.join(temp, "other") },
    data: { title: "Ignored", message: "other project", variant: "info", duration: 5000 },
  })
  assert.equal(toasts.length, 2)

  cleanup()
  assert.equal(unsubscribeCalls, 1)
})
