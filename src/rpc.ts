import { Rpc } from "@opencode/plugin/rpc"

const computer = {
  type: "object",
  properties: {
    task: { type: "string" },
    description: { type: "string" },
    backend: { type: "string", enum: ["sandbox", "free-vm", "pending"] },
    computer: { type: "string" },
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
export const RailwayComputer = Rpc.define({
  id: "railway-computer",
  methods: {
    list: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { computers: { type: "array", items: computer } },
        required: ["computers"],
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
