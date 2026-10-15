import { Rpc } from "@opencode/plugin/rpc"

export const ContextPreviewRpc = Rpc.define({
  id: "opencode-context-preview",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
          duration: { type: "number" },
        },
        required: ["title", "message", "variant"],
        additionalProperties: false,
      },
    },
  },
})
