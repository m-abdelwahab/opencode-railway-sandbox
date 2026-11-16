import { Rpc } from "@opencode/plugin/rpc"

const sandbox = {
  type: "object",
  properties: {
    task: { type: "string" },
    description: { type: "string" },
    backend: { type: "string", enum: ["sandbox", "free-vm", "pending"] },
    sandbox: { type: "string" },
    status: {
      type: "string",
      enum: ["awaiting-sign-in", "running", "previewing", "finished", "failed", "stopped", "expired"],
    },
    detail: { type: "string" },
    directory: { type: "string" },
    sessionID: { type: "string" },
    startedAt: { type: "number" },
    updatedAt: { type: "number" },
    expiresAt: { type: "number" },
    previewURL: { type: "string" },
    shareable: { type: "boolean" },
    patchFile: { type: "string" },
    applied: { type: "boolean" },
    variables: { type: "array", items: { type: "string" } },
  },
  required: ["task", "description", "backend", "status", "directory", "sessionID", "startedAt", "updatedAt"],
  additionalProperties: false,
} as const

/** Contract between the server part and the Desktop panel (and any other client). */
export const RailwaySandbox = Rpc.define({
  id: "railway-sandbox",
  methods: {
    list: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { sandboxes: { type: "array", items: sandbox } },
        required: ["sandboxes"],
        additionalProperties: false,
      },
    },
    stop: {
      input: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { stopped: { type: "boolean" }, message: { type: "string" } },
        required: ["stopped", "message"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
})
