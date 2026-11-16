import { Plugin } from "@opencode/plugin"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as FreeVM from "./free-vm.ts"
import * as OAuth from "./oauth.ts"
import { resolveEnvironment, SetupError, type RailwayAuth } from "./railway-auth.ts"
import { destroySandbox, runSandbox } from "./sandbox.ts"
import { AnonymousUnavailable, sleep, type ForwardedCredential, type ModelRef, type RunInput, type RunResult } from "./types.ts"
import { pack } from "./workspace.ts"

export const INTEGRATION_ID = "railway-computer"
/** Public (native) OAuth client for "Railway Computer". PKCE only; there is no secret to protect. */
export const DEFAULT_OAUTH_CLIENT_ID = "rlwy_oaci_usmpkY8YlXHCXisdsEA1xmY4"
const OAUTH_METHOD_ID = "oauth"
const TOOL = "railway_computer"
const STATE_DIR = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode-railway-computer")

interface Options {
  readonly oauthClientId?: string
  readonly oauthPort?: number
  /** Railway project (name or ID) for sandboxes when signed in with OAuth or an account token. */
  readonly project?: string
  /** Environment name or ID within that project. Defaults to "production". */
  readonly environment?: string
  readonly environmentId?: string
  /** Default remote model as "providerID/modelID#variant". Falls back to the parent session's model. */
  readonly model?: string
  readonly agent?: string
  /** Try a free anonymous `ssh railway.new` computer before asking the user to sign in. Defaults to true. */
  readonly anonymous?: boolean
  readonly idleTimeoutMinutes?: number
  /** Hard cap on a sandbox task's runtime, enforced inside the VM. */
  readonly maxMinutes?: number
  /** How long a preview stays up. */
  readonly previewMinutes?: number
  /** Keep sandboxes running after non-preview tasks (until their idle timeout). */
  readonly keepSandbox?: boolean
  /** Upgrade the sandbox's OpenCode to the local version before starting. */
  readonly matchVersion?: boolean
}

const CONNECT_HINT =
  "Tell the user to connect Railway in OpenCode (`/connect` → Railway, or Settings → Integrations): sign in with Railway, paste a Railway project token, or set RAILWAY_TOKEN for the OpenCode server."

const parseModel = (value: string): ModelRef => {
  const [ref = "", variant] = value.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0) throw new Error(`Invalid model "${value}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

export default Plugin.define({
  id: "railway-computer",
  async setup(ctx) {
    const options = ctx.options as Options
    const clientID = options.oauthClientId ?? process.env.OPENCODE_RAILWAY_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID
    const oauth = { clientID, port: options.oauthPort ?? 19876 }
    const running = new Map<string, { controller: AbortController; result?: RunResult }>()

    await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "Railway"
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with Railway" },
        // OpenCode brands `methodID`; our credentials always carry OAUTH_METHOD_ID, so the casts only restore the brand.
        authorize: async () => (await OAuth.authorize(oauth, OAUTH_METHOD_ID)) as never,
        refresh: async (credential) => (await OAuth.refresh(oauth, credential)) as never,
        label: (credential) => (credential.metadata?.email as string | undefined) ?? "Railway",
      })
      editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "Railway project token" } })
      editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "env", names: ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN"] } })
    })

    /** Resolves the connected Railway account, or undefined when none is connected. */
    const account = async (): Promise<RailwayAuth | undefined> => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (!connection || !value) return undefined
      if (value.type === "key" && !(connection.type === "env" && connection.name === "RAILWAY_API_TOKEN"))
        return { token: value.key, authType: "project-token", describe: "your Railway project (project token)" }
      const token = value.type === "key" ? value.key : value.type === "oauth" ? value.access : undefined
      if (!token) throw new SetupError(`Unsupported Railway credential type "${value.type}". ${CONNECT_HINT}`)
      const placement = await resolveEnvironment(token, {
        project: options.project,
        environment: options.environment,
        environmentId: options.environmentId ?? (connection.type === "env" ? process.env.RAILWAY_ENVIRONMENT_ID : undefined),
      })
      return { token, authType: "bearer", environmentId: placement.environmentId, describe: placement.describe }
    }

    /** Reuses the local OpenCode login for the remote model's provider when it can work on another machine. */
    const forward = async (providerID: string): Promise<ForwardedCredential[] | undefined> => {
      const connection = await ctx.integration.connection.active(providerID)
      const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (!value) return []
      if (value.type === "key") return [{ integrationID: providerID, value: { type: "key", key: value.key } }]
      if (value.type === "oauth")
        return [
          {
            integrationID: providerID,
            // The access token was refreshed locally if it was close to expiring. The refresh token stays here so the
            // remote machine can never rotate it out from under this machine's login.
            value: { type: "oauth", methodID: value.methodID, access: value.access, refresh: "", expires: value.expires, ...(value.metadata ? { metadata: value.metadata } : {}) },
          },
        ]
      return undefined // e.g. Claude Agent: a login that only exists on this machine
    }

    const savePatch = async (task: string, patch: string) => {
      if (!patch.trim()) return undefined
      const dir = path.join(os.tmpdir(), "opencode-railway-computer")
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${task}.patch`)
      await writeFile(file, patch)
      return file
    }

    const report = (task: string, result: RunResult, patchFile: string | undefined, modelNote: string | undefined) =>
      [
        `<railway_computer task="${task}" backend="${result.backend}" outcome="${result.outcome}" computer="${result.computer}">`,
        result.text.trim(),
        "",
        result.diffstat ? `Changes made on the Railway computer:\n${result.diffstat}` : "No file changes were made on the Railway computer.",
        ...(patchFile
          ? [`The changes were NOT applied locally. Patch saved to ${patchFile}. Review it, then apply with \`git apply ${patchFile}\` from the project root if appropriate.`]
          : []),
        ...(result.preview
          ? [
              "",
              `Preview URL: ${result.preview.url} (${result.preview.check}; ${result.preview.shareable ? "shareable" : "not shareable yet"})`,
              ...(result.preview.note ? [result.preview.note] : []),
            ]
          : []),
        ...(modelNote ? [modelNote] : []),
        ...result.notes,
        result.running && result.backend === "sandbox"
          ? `The sandbox ${result.computer} is still running; stop it early with the railway_computer_stop tool.`
          : result.backend === "sandbox"
            ? "The sandbox has been destroyed."
            : "",
        `</railway_computer>`,
      ]
        .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
        .join("\n")

    const deliver = (sessionID: string, description: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, description }).catch((error) => console.error("[railway-computer] delivery failed", error))

    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        options: { codemode: false },
        description: [
          "Gives a subagent its own Railway computer (a fresh Linux VM) and runs a task there instead of on this machine.",
          "The project's files (git-tracked and untracked, excluding ignored files) are copied over; a headless OpenCode agent does the task with full permissions on that VM.",
          "Use it for builds, installs, test suites, risky or long-running experiments, parallel work, and for live previews: set preview=true to have the app built and served on a public URL.",
          "File changes come back as a patch you can review and apply; they are never applied automatically.",
          "Runs in the background by default: the call returns immediately and you receive a <railway_computer> message when it finishes. Do not poll.",
          "Without a connected Railway account it uses a free anonymous Railway computer; if that is unavailable it returns a Railway sign-in link to relay to the user.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "A short 3-5 word label for the task" },
            prompt: { type: "string", description: "Complete, self-contained instructions. The remote agent cannot see this conversation." },
            preview: { type: "boolean", description: "Build the app and serve it on a preview URL that is returned when done. Defaults to false." },
            agent: { type: "string", description: 'Remote agent to use. Defaults to "build".' },
            model: { type: "string", description: 'Only if the user asks for a specific model: "providerID/modelID" or "providerID/modelID#variant".' },
            wait: { type: "boolean", description: "Block until the task finishes instead of running in the background. Defaults to false." },
          },
          required: ["description", "prompt"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as { description: string; prompt: string; preview?: boolean; agent?: string; model?: string; wait?: boolean }
          const parent = await ctx.session.get({ sessionID: context.sessionID })

          const requested = input.model || options.model
          let model: ModelRef | undefined = requested ? parseModel(requested) : parent.model
          let credentials = model ? await forward(model.providerID) : []
          let modelNote: string | undefined
          if (credentials === undefined) {
            if (requested) throw new Error(`Provider "${model!.providerID}" uses a login that only works on this machine, so it cannot run on a Railway computer. Pick a model from a provider connected with an API key or OAuth.`)
            modelNote = `The session's model (${model!.providerID}/${model!.id}) uses a login that only works on this machine, so the remote agent used OpenCode's default model instead.`
            model = undefined
            credentials = []
          }

          const archive = await pack(parent.location.directory)
          const task = `rc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
          const controller = new AbortController()
          const entry: { controller: AbortController; result?: RunResult } = { controller }
          running.set(task, entry)
          const runInput = (progress: RunInput["progress"]): RunInput => ({
            archive: archive.archive,
            prompt: input.prompt,
            title: input.description,
            agent: input.agent || options.agent || "build",
            model,
            credentials,
            preview: input.preview === true,
            previewMinutes: options.previewMinutes ?? 60,
            signal: controller.signal,
            progress,
          })
          const viaSandbox = (auth: RailwayAuth) => (progress: RunInput["progress"]) =>
            runSandbox(
              {
                auth,
                idleTimeoutMinutes: options.idleTimeoutMinutes ?? 30,
                maxMinutes: options.maxMinutes ?? 120,
                opencodeVersion: options.matchVersion ? ctx.app.version : undefined,
              },
              runInput(progress),
            )
          const finish = async (result: RunResult) => {
            entry.result = result
            const patchFile = await savePatch(task, result.patch)
            if (result.backend === "sandbox" && !result.preview && !options.keepSandbox) {
              await result.dispose()
              return report(task, { ...result, running: false }, patchFile, modelNote)
            }
            return report(task, result, patchFile, modelNote)
          }
          const background = (label: string, work: () => Promise<RunResult>) => {
            void work()
              .then(finish)
              .then(
                (output) => deliver(context.sessionID, `Railway computer finished: ${input.description}`, output),
                (error) =>
                  deliver(
                    context.sessionID,
                    `Railway computer failed: ${input.description}`,
                    `<railway_computer task="${task}" outcome="failed">\n${error instanceof Error ? error.message : String(error)}\n</railway_computer>`,
                  ),
              )
              .finally(() => running.delete(task))
            return label
          }
          const summary = `${archive.git ? `${archive.files} files` : "project directory"}, ${(archive.archive.byteLength / 1024).toFixed(0)} KiB; model ${model ? `${model.providerID}/${model.id}` : "remote default"}${input.preview ? "; preview requested" : ""}`

          // 1. A connected Railway account runs on Railway Sandboxes.
          const auth = await account().catch((error) => {
            running.delete(task)
            throw error instanceof SetupError ? error : new Error(`Railway account check failed: ${String(error)}`)
          })
          let run: ((progress: RunInput["progress"]) => Promise<RunResult>) | undefined
          let where = ""
          let anonymousRefusal: AnonymousUnavailable | undefined
          if (auth) {
            run = viaSandbox(auth)
            where = `a Railway sandbox in ${auth.describe}`
          } else if (options.anonymous !== false) {
            // 2. No account: try a free anonymous computer.
            const vm = await FreeVM.identity(STATE_DIR, parent.location.directory)
            const manifest = await FreeVM.probe(vm).catch((error) => {
              if (error instanceof AnonymousUnavailable) return error
              throw error
            })
            if (manifest instanceof AnonymousUnavailable) anonymousRefusal = manifest
            else {
              run = (progress) => FreeVM.runFreeVM(vm, runInput(progress), manifest)
              where = "a free anonymous Railway computer (ssh railway.new)"
            }
          }

          if (run) {
            if (input.wait) {
              try {
                return { content: await finish(await run((status, detail) => void context.progress({ status, ...detail }).catch(() => {}))), metadata: { task } }
              } finally {
                running.delete(task)
              }
            }
            return {
              content: background(
                [
                  `Task ${task} is starting on ${where} (${summary}).`,
                  "It runs in the background; you will receive a <railway_computer> message when it finishes.",
                  "DO NOT sleep, poll, or duplicate its work. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
                ].join("\n"),
                () => run(() => {}),
              ),
              metadata: { task, status: "running" },
            }
          }

          // 3. No account and no anonymous computer: hand off to Railway sign-in.
          const reason = anonymousRefusal
            ? `Free anonymous Railway computers are unavailable right now (${anonymousRefusal.message}).`
            : "No Railway account is connected."
          const attempt = await ctx.integration.oauth
            .connect({ integrationID: INTEGRATION_ID, methodID: OAUTH_METHOD_ID })
            .then((output) => output.data)
            .catch((error) => {
              running.delete(task)
              throw new Error(`${reason} Starting Railway sign-in failed: ${String(error)}. ${CONNECT_HINT}`)
            })
          if (input.wait) {
            running.delete(task)
            throw new Error(`${reason} Ask the user to sign in with Railway at ${attempt.url} and then retry. ${CONNECT_HINT}`)
          }
          return {
            content: background(
              [
                reason,
                `To continue on their own Railway account, the user must sign in with Railway here: ${attempt.url}`,
                "Relay that link to the user now. The link expires in 10 minutes.",
                `Task ${task} starts automatically as soon as they approve (${summary}); you will receive a <railway_computer> message when it finishes. Do not poll.`,
              ].join("\n"),
              async () => {
                while (true) {
                  if (controller.signal.aborted) throw controller.signal.reason
                  const status = await ctx.integration.oauth.status({ integrationID: INTEGRATION_ID, attemptID: attempt.attemptID })
                  if (status.data.status === "complete") break
                  if (status.data.status !== "pending") throw new Error(`Railway sign-in did not complete (${status.data.status}). ${CONNECT_HINT}`)
                  await sleep(2000)
                }
                const connected = await account()
                if (!connected) throw new Error(`Railway sign-in finished but no account is connected. ${CONNECT_HINT}`)
                return viaSandbox(connected)(() => {})
              },
            ),
            metadata: { task, status: "awaiting-sign-in", url: attempt.url },
          }
        },
      })

      editor.add({
        name: `${TOOL}_stop`,
        options: { codemode: false },
        description: "Stops a Railway sandbox started by railway_computer (for example to take a preview down early). Needs the sandbox ID from the <railway_computer> report.",
        input: {
          type: "object",
          properties: { computer: { type: "string", description: "The sandbox ID from the report's computer attribute" } },
          required: ["computer"],
          additionalProperties: false,
        },
        execute: async (raw) => {
          const auth = await account()
          if (!auth) throw new SetupError(`No Railway account is connected. ${CONNECT_HINT}`)
          await destroySandbox(auth, (raw as { computer: string }).computer)
          return { content: `Sandbox ${(raw as { computer: string }).computer} destroyed.` }
        },
      })
    })

    return async () => {
      OAuth.cancelPending(new Error("OpenCode plugin unloaded"))
      await Promise.all(
        [...running.values()].map(async (entry) => {
          entry.controller.abort(new Error("OpenCode plugin unloaded"))
          await entry.result?.dispose()
        }),
      )
    }
  },
})
