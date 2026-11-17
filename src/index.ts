import { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyPatch, patchFiles, rememberPreimages } from "./apply.ts"
import * as FreeVM from "./free-vm.ts"
import * as OAuth from "./oauth.ts"
import { listVariables, projectTokenScope, resolveEnvironment, SetupError, type RailwayAuth } from "./railway-auth.ts"
import { RailwaySandbox } from "./rpc.ts"
import { destroySandbox, Detached, followSandbox, inspectSandbox, messageSandbox, runSandbox, watchLink, type Activity, type Handle } from "./sandbox.ts"
import { createRegistry, isLive, type SandboxRecord } from "./state.ts"
import { AnonymousUnavailable, sleep, type ForwardedCredential, type ModelRef, type RunInput, type RunResult } from "./types.ts"
import { checkDirectory, pack } from "./workspace.ts"

export const INTEGRATION_ID = "railway-sandbox"
/** Public (native) OAuth client for "Railway Sandbox". PKCE only; there is no secret to protect. */
export const DEFAULT_OAUTH_CLIENT_ID = "rlwy_oaci_usmpkY8YlXHCXisdsEA1xmY4"
const OAUTH_METHOD_ID = "oauth"
const TOOL = "railway_sandbox"
const STATE_DIR = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode-railway-sandbox")
const PATCH_DIR = path.join(os.tmpdir(), "opencode-railway-sandbox")

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
  /** Try a free anonymous `ssh railway.new` sandbox before asking the user to sign in. Defaults to true. */
  readonly anonymous?: boolean
  /** Variables for every sandbox, e.g. { "DATABASE_URL": "${{Postgres.DATABASE_URL}}" }. Needs a Railway account. */
  readonly variables?: Record<string, string>
  readonly idleTimeoutMinutes?: number
  /** Hard cap on a sandbox task's runtime, enforced inside the VM. */
  readonly maxMinutes?: number
  /** How long a preview stays up. */
  readonly previewMinutes?: number
  /** Keep sandboxes running after non-preview tasks (until their idle timeout). */
  readonly keepSandbox?: boolean
  /** Upgrade the sandbox's OpenCode to the local version before starting. */
  readonly matchVersion?: boolean
  /** Extra file patterns never to upload, on top of the built-in secret patterns. */
  readonly uploadExclude?: readonly string[]
  /** Patterns to upload even though they match a built-in secret pattern, e.g. ".env.test". */
  readonly uploadInclude?: readonly string[]
  /**
   * "private" (default): sandboxes join the project's private network and publish their OpenCode server behind a
   * per-task password, so every task can be watched as a native Desktop tab. "isolated": no private network and no
   * public URL unless a task uses variables or a preview; the panel shows an Activity view instead of Watch live.
   */
  readonly network?: "private" | "isolated"
  /** Withhold files that look like secrets (.env*, keys, credentials) from uploads even when not gitignored. */
  readonly withholdSecrets?: boolean
}

const CONNECT_HINT =
  "Tell the user to connect Railway in OpenCode (`/connect` → Railway, or Settings → Integrations): sign in with Railway, paste a Railway project token, or set RAILWAY_TOKEN for the OpenCode server."

const parseModel = (value: string): ModelRef => {
  const [ref = "", variant] = value.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0) throw new Error(`Invalid model "${value}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) }
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Tasks some plugin instance in this process is following. A reload re-imports this module, so the set lives on
 * globalThis; it stops two instances (or an old and a new one) from following the same task.
 */
const following: Set<string> = ((globalThis as Record<string, unknown>).__railwaySandboxFollowing ??= new Set<string>()) as Set<string>
const handleKey = (task: string) => `handle/${task}`
/** When a follow-up was last sent to a task's remote agent. */
const steerKey = (task: string) => `steer/${task}`
/**
 * Plugin storage and sessions live in OpenCode's database, which every OpenCode process on the machine shares (for
 * example Desktop's service and a separate `opencode serve`). The process following a task holds a lease on it, so
 * another process only resumes a task whose follower has gone away.
 */
const leaseKey = (task: string) => `lease/${task}`
const deliveredKey = (task: string) => `delivered/${task}`
const LEASE_MS = 90_000
const PROCESS_ID: string = ((globalThis as Record<string, unknown>).__railwaySandboxProcess ??= crypto.randomUUID()) as string

export default Plugin.define({
  id: "railway-sandbox",
  async setup(ctx) {
    const options = ctx.options as Options
    const clientID = options.oauthClientId ?? process.env.OPENCODE_RAILWAY_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID
    const oauth = { clientID, port: options.oauthPort ?? 19876 }
    const maxMinutes = options.maxMinutes ?? 120
    const previewMinutes = options.previewMinutes ?? 60
    /** Tasks this instance is running, so they can be aborted; the registry holds every instance's tasks. */
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

    // The registration is created below; events emitted before it exists are simply dropped.
    let emit: (task: string) => Promise<void> = async () => {}
    const registry = createRegistry(ctx, (task) => emit(task))

    /** Resolves the connected Railway account, or undefined when none is connected. */
    const account = async (): Promise<RailwayAuth | undefined> => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (!connection || !value) return undefined
      if (value.type === "key" && !(connection.type === "env" && connection.name === "RAILWAY_API_TOKEN")) {
        const scope = await projectTokenScope(value.key).catch(() => undefined)
        return { token: value.key, authType: "project-token", ...scope, describe: "your Railway project (project token)" }
      }
      const token = value.type === "key" ? value.key : value.type === "oauth" ? value.access : undefined
      if (!token) throw new SetupError(`Unsupported Railway credential type "${value.type}". ${CONNECT_HINT}`)
      const placement = await resolveEnvironment(token, {
        project: options.project,
        environment: options.environment,
        environmentId: options.environmentId ?? (connection.type === "env" ? process.env.RAILWAY_ENVIRONMENT_ID : undefined),
      })
      return { token, authType: "bearer", ...placement }
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

    const patchPath = (task: string) => path.join(PATCH_DIR, `${task}.patch`)

    const savePatch = async (task: string, patch: string, directory: string) => {
      if (!patch.trim()) return undefined
      await mkdir(PATCH_DIR, { recursive: true })
      const file = patchPath(task)
      await writeFile(file, patch)
      await rememberPreimages(directory, file).catch(() => {})
      return file
    }

    /** Stops a task's sandbox: aborts it if this instance runs it, and destroys its sandbox. */
    const stopTask = async (task: string): Promise<{ stopped: boolean; message: string }> => {
      const record = await registry.get(task)
      if (!record) return { stopped: false, message: `Unknown task ${task}.` }
      const local = running.get(task)
      local?.controller.abort(new Error("Stopped by the user"))
      if (record.backend === "free-vm") {
        await registry.update(task, { status: "stopped", detail: "Stopped. Anonymous sandboxes end with their build window." })
        return { stopped: true, message: "Stopped tracking the anonymous sandbox; it shuts down when its build window ends." }
      }
      if (record.backend === "sandbox" && record.sandbox && isLive(record)) {
        const auth = await account()
        if (!auth) return { stopped: false, message: `No Railway account is connected. ${CONNECT_HINT}` }
        await destroySandbox(auth, record.sandbox).catch((error) => {
          // Already gone (expired or destroyed elsewhere) is the outcome the user wants.
          if (!/not found/i.test(String(error))) throw error
        })
      }
      await registry.update(task, { status: "stopped", detail: "Stopped by the user." })
      return { stopped: true, message: `Task ${task} stopped${record.sandbox ? ` and sandbox ${record.sandbox} destroyed` : ""}.` }
    }

    const notBefore = (task: string) => async () => (await ctx.storage.get(steerKey(task))) as number | undefined

    /** A running sandbox task with a live remote agent, or a SetupError saying why there is none. */
    const live = async (task: string) => {
      const record = await registry.get(task)
      if (!record) throw new SetupError(`Unknown task ${task}.`)
      const handle = (await ctx.storage.get(handleKey(task))) as Handle | undefined
      if (record.backend !== "sandbox" || record.status !== "running" || !handle)
        throw new SetupError(
          record.backend === "free-vm"
            ? `Task ${task} runs on an anonymous Railway VM, which has no live remote session to inspect or message.`
            : `Task ${task} has no live remote agent (status: ${record.status}${record.previewURL ? `, preview at ${record.previewURL}` : ""}).`,
        )
      const auth = await account()
      if (!auth) throw new SetupError(`No Railway account is connected. ${CONNECT_HINT}`)
      return { record, handle, auth }
    }

    const STATUS_COOLDOWN_MS = 30_000
    const REMINDER = "The report for each task arrives on its own and wakes you; don't check again unless the user asks."
    const lastChecks = new Map<string, number>()
    const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))}m`
    const describe = (record: SandboxRecord, activity?: Activity) => {
      const now = Date.now()
      return [
        `${record.task} — ${record.description} [${record.status}] (${record.directory.split("/").filter(Boolean).at(-1)})`,
        `  running for ${minutes(now - record.startedAt)}${record.expiresAt && isLive(record) ? `, ${minutes(record.expiresAt - now)} left before it shuts down` : ""}`,
        ...(record.previewURL ? [`  preview: ${record.previewURL}`] : []),
        ...(activity
          ? [
              `  remote agent: ${activity.busy ? "working" : "idle"}, ${activity.messages} messages`,
              ...(activity.todos?.length
                ? ["  todos:", ...activity.todos.map((todo) => `    [${todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " "}] ${todo.content}`)]
                : []),
              ...(activity.tools.length
                ? ["  recent tool calls:", ...activity.tools.map((tool) => `    ${tool.name} (${tool.status}) ${tool.input}${tool.output ? `\n      → ${tool.output}` : ""}`)]
                : []),
              ...(activity.said.length ? ["  latest from the remote agent:", ...activity.said.map((text) => `    ${text.replaceAll("\n", "\n    ")}`)] : []),
              `  files changed so far: ${activity.changes.length ? activity.changes.join(", ") : "none"}`,
            ]
          : record.detail
            ? [`  ${record.detail}`]
            : []),
      ].join("\n")
    }

    const rpc = await ctx.rpc.register(RailwaySandbox, {
      list: async () => ({ sandboxes: (await registry.list()) as never }),
      stop: async (input) => stopTask((input as { task: string }).task),
      // Running sandboxes as servers OpenCode Desktop can connect to, so their sessions open as native tabs. Only
      // clients of this (password-protected) local server can call it; they already hold full local access.
      servers: async () => ({
        servers: (
          await Promise.all(
            (await registry.list())
              .filter((record) => record.backend === "sandbox" && record.status === "running")
              .map(async (record) => {
                const handle = (await ctx.storage.get(handleKey(record.task))) as Handle | undefined
                return handle?.url
                  ? [{ task: record.task, description: record.description, url: handle.url, password: handle.password, sessionID: handle.sessionID }]
                  : []
              }),
          )
        ).flat(),
      }),
      // Live progress for the panel, which works for isolated sandboxes too (no public URL needed).
      activity: async (input, context) => {
        const task = (input as { task: string }).task
        const record = await registry.get(task)
        if (!record) return { text: `Unknown task ${task}.` }
        const target = await live(task).catch(() => undefined)
        const activity = target ? await inspectSandbox(target.auth, target.handle, context.signal).catch(() => undefined) : undefined
        return { text: describe(record, activity) }
      },
      watch: async (input, context) => {
        const { auth, handle } = await live((input as { task: string }).task)
        const link = await watchLink(auth, handle, context.signal)
        return { url: link.url, expiresIn: link.expiresIn }
      },
    })
    emit = (task) => rpc.events.emit("updated", { task })

    const report = (task: string, result: RunResult, patchFile: string | undefined, notes: readonly string[]) =>
      [
        ...(result.outcome === "failed" && /usage limit|quota|FreeUsageLimit/i.test(result.text)
          ? [
              "Hint: the remote model ran out of quota. Retry with `model` set to a model from a provider connected in OpenCode with an API key or OAuth, or set the plugin's \"model\" option.",
            ]
          : []),
        `<railway_sandbox task="${task}" backend="${result.backend}" outcome="${result.outcome}" sandbox="${result.sandbox}">`,
        result.text.trim(),
        "",
        result.diffstat ? `Changes made on the Railway sandbox:\n${result.diffstat}` : "No file changes were made on the Railway sandbox.",
        ...(patchFile
          ? [`The changes were NOT applied locally. Patch saved to ${patchFile}. Review it, then apply it with the railway_sandbox_apply tool (task "${task}") if appropriate.`]
          : []),
        ...(result.preview
          ? [
              "",
              `Preview URL: ${result.preview.url} (${result.preview.check}; ${result.preview.shareable ? "shareable" : "not shareable yet"})`,
              ...(result.preview.note ? [result.preview.note] : []),
            ]
          : []),
        ...notes,
        ...result.notes,
        result.running && result.backend === "sandbox"
          ? `The sandbox ${result.sandbox} is still running; stop it early with railway_sandbox_stop (task "${task}").`
          : result.backend === "sandbox"
            ? "The sandbox has been destroyed."
            : "",
        `</railway_sandbox>`,
      ]
        .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
        .join("\n")

    const deliver = (sessionID: string, description: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, description }).catch((error) => console.error("[railway-sandbox] delivery failed", error))

    /** Records a finished task, saves its patch, and returns the report for the parent session. */
    const complete = async (task: string, directory: string, startedAt: number, result: RunResult, notes: readonly string[]) => {
      const patchFile = await savePatch(task, result.patch, directory)
      const destroy = result.backend === "sandbox" && !result.preview && !options.keepSandbox
      if (destroy) await result.dispose()
      const live = !destroy && result.running
      await ctx.storage.remove(handleKey(task)).catch(() => {})
      await ctx.storage.remove(steerKey(task)).catch(() => {})
      await registry.update(task, {
        backend: result.backend,
        sandbox: result.sandbox,
        status: result.preview && live ? "previewing" : live && result.backend === "sandbox" ? "running" : "finished",
        detail: result.preview ? `Preview ${result.preview.check}` : `Finished: ${result.outcome}`,
        previewURL: result.preview?.url,
        shareable: result.preview?.shareable,
        patchFile,
        expiresAt: result.preview ? Date.now() + previewMinutes * 60_000 : live ? startedAt + maxMinutes * 60_000 : undefined,
      })
      return report(task, { ...result, running: live }, patchFile, notes)
    }

    /** Follows a task in the background and delivers its report; shared by new and resumed tasks. */
    const watch = (
      record: Pick<SandboxRecord, "task" | "description" | "sessionID">,
      controller: AbortController,
      work: () => Promise<string>,
      /** Whether another instance can pick the task up after a reload: true once its handle is stored. */
      resumable: () => boolean,
    ) => {
      following.add(record.task)
      const renew = () => ctx.storage.set(leaseKey(record.task), { owner: PROCESS_ID, until: Date.now() + LEASE_MS }).catch(() => {})
      void renew()
      const lease = setInterval(() => void renew(), LEASE_MS / 3)
      /** Delivers a task's report at most once, even if another process also finished following it. */
      const once = async (description: string, text: string) => {
        if (await ctx.storage.get(deliveredKey(record.task)).catch(() => undefined)) return
        await ctx.storage.set(deliveredKey(record.task), Date.now())
        await deliver(record.sessionID, description, text)
      }
      void work()
        .then(
          (output) => once(`Railway sandbox finished: ${record.description}`, output),
          async (error) => {
            // A reload detaches. A task that stored its handle is resumed (and reported) by the next instance, which may
            // already have finished it, so this instance must stay silent. Anything else, such as an anonymous
            // sandbox or a sandbox interrupted before it started, is lost, and the parent hears about it.
            if (controller.signal.reason instanceof Detached && resumable()) return
            const message = error instanceof Error ? error.message : String(error)
            await registry.update(record.task, { status: controller.signal.aborted ? "stopped" : "failed", detail: message }).catch(() => {})
            await once(
              `Railway sandbox failed: ${record.description}`,
              `<railway_sandbox task="${record.task}" outcome="failed">\n${message}\n</railway_sandbox>`,
            )
          },
        )
        .finally(() => {
          clearInterval(lease)
          following.delete(record.task)
          running.delete(record.task)
          // A detached task keeps its lease until it expires, which is when another process may take over; in this
          // process the next instance resumes it right away because the lease is its own.
          if (!(controller.signal.reason instanceof Detached)) void ctx.storage.remove(leaseKey(record.task)).catch(() => {})
        })
    }

    /** Picks up sandbox tasks of this directory that no instance is following, e.g. after a plugin reload. */
    const resume = async () => {
      for (const record of await registry.list()) {
        if (record.status !== "running" || record.backend !== "sandbox" || record.directory !== ctx.location.directory) continue
        if (following.has(record.task) || running.has(record.task)) continue
        const handle = (await ctx.storage.get(handleKey(record.task))) as Handle | undefined
        if (!handle) continue
        const held = (await ctx.storage.get(leaseKey(record.task))) as { owner: string; until: number } | undefined
        if (held && held.owner !== PROCESS_ID && held.until > Date.now()) continue
        // Claim, then confirm after a beat: if another process claimed at the same moment, the later write wins.
        await ctx.storage.set(leaseKey(record.task), { owner: PROCESS_ID, until: Date.now() + LEASE_MS })
        await sleep(750)
        if (((await ctx.storage.get(leaseKey(record.task))) as { owner?: string } | undefined)?.owner !== PROCESS_ID) continue
        if (following.has(record.task)) continue
        const auth = await account().catch(() => undefined)
        if (!auth) continue
        const controller = new AbortController()
        running.set(record.task, { controller })
        await registry.update(record.task, { detail: "Resumed (the previous follower reloaded or went away)" })
        watch(record, controller, async () =>
          complete(
            record.task,
            record.directory,
            record.startedAt,
            await followSandbox({ auth }, handle, {
              preview: Boolean(handle.previewDomain),
              previewMinutes,
              signal: controller.signal,
              notBefore: notBefore(record.task),
              progress: (status) => void registry.update(record.task, { detail: status }).catch(() => {}),
            }),
            [],
          ),
          () => true,
        )
      }
    }

    // These are direct tools. Agents that work mostly through Code Mode (for example with Railway's MCP installed) can
    // search only that catalog and conclude the tools are missing, so say where they are while they are available.
    const hint = (event: { tools: Record<string, unknown>; system: Array<{ type: "text"; text: string }> }) => {
      if (!event.tools[TOOL]) return
      event.system.push({
        type: "text",
        text: [
          "The Railway OpenCode plugin is installed. Its tools are direct tools, not part of the Code Mode catalog:",
          "railway_sandbox (run a task, or build and preview the app, on a Railway sandbox using a copy of this session's folder),",
          "railway_sandbox_status, railway_sandbox_message, railway_sandbox_apply, railway_sandbox_variables, railway_sandbox_stop.",
          "Use them when the user asks to run something on a Railway sandbox or remotely, or for a preview URL. They are different from Railway cloud agents in the Railway MCP.",
        ].join(" "),
      })
    }
    await ctx.session.hook("context", hint as never)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        options: { codemode: false },
        description: [
          "Gives a subagent its own Railway sandbox (a fresh Linux VM) and runs a task there instead of on this machine.",
          "The project's files (git-tracked and untracked, excluding ignored files) are copied over; a headless OpenCode agent does the task with full permissions on that VM.",
          "Use it for builds, installs, test suites, risky or long-running experiments, parallel work, and for live previews: set preview=true to have the app built and served on a public URL.",
          "To let the remote agent reach the Railway project's databases and services, pass `variables` with Railway references (find names with railway_sandbox_variables).",
          "File changes come back as a patch; apply it with railway_sandbox_apply. They are never applied automatically.",
          "Runs in the background by default: the call returns immediately and you receive a <railway_sandbox> message when it finishes. Do not poll.",
          "While it runs, railway_sandbox_status shows what the remote agent is doing (only when the user asks or you need it to decide what to do next) and railway_sandbox_message sends it follow-up instructions.",
          "Without a connected Railway account it uses a free anonymous Railway sandbox; if that is unavailable it returns a Railway sign-in link to relay to the user.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "A short 3-5 word label for the task" },
            prompt: { type: "string", description: "Complete, self-contained instructions. The remote agent cannot see this conversation." },
            preview: { type: "boolean", description: "Build the app and serve it on a preview URL that is returned when done. Defaults to false." },
            variables: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                'Environment variables for the remote sandbox, as NAME → value. Use Railway references instead of secret values, e.g. {"DATABASE_URL": "${{Postgres.DATABASE_URL}}"} or {"API_KEY": "${{shared.API_KEY}}"}; Railway resolves them inside the VM. Requires a Railway account; the sandbox joins the project\'s private network.',
            },
            live: {
              type: "boolean",
              description:
                'Only needed when the plugin is configured with network: "isolated" and the user wants to watch this task live in a Desktop tab.',
            },
            agent: { type: "string", description: 'Remote agent to use. Defaults to "build".' },
            model: { type: "string", description: 'Only if the user asks for a specific model: "providerID/modelID" or "providerID/modelID#variant".' },
            wait: { type: "boolean", description: "Block until the task finishes instead of running in the background. Defaults to false." },
          },
          required: ["description", "prompt"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as {
            description: string
            prompt: string
            preview?: boolean
            variables?: Record<string, string>
            live?: boolean
            agent?: string
            model?: string
            wait?: boolean
          }
          const parent = await ctx.session.get({ sessionID: context.sessionID })
          const directory = parent.location.directory
          await checkDirectory(directory, os.homedir())

          const variables = { ...options.variables, ...input.variables }
          const invalid = Object.keys(variables).filter((name) => !VARIABLE_NAME.test(name))
          if (invalid.length) throw new Error(`Invalid environment variable names: ${invalid.join(", ")}.`)
          const needsAccount = Object.keys(variables).length > 0
          // Isolated unless the task needs the private network: variables (internal services), a preview (public URL),
          // or a live view (public URL for Desktop). Public domains require the private network on Railway.
          const network: "isolated" | "private" =
            options.network !== "isolated" || needsAccount || input.preview || input.live ? "private" : "isolated"

          const requested = input.model || options.model
          let model: ModelRef | undefined = requested ? parseModel(requested) : parent.model
          let credentials = model ? await forward(model.providerID) : []
          const notes: string[] = []
          if (credentials === undefined) {
            if (requested) throw new Error(`Provider "${model!.providerID}" uses a login that only works on this machine, so it cannot run on a Railway sandbox. Pick a model from a provider connected with an API key or OAuth.`)
            notes.push(`The session's model (${model!.providerID}/${model!.id}) uses a login that only works on this machine, so the remote agent used OpenCode's default model instead.`)
            model = undefined
            credentials = []
          }
          if (needsAccount) notes.push(`Environment variables set on the sandbox: ${Object.keys(variables).join(", ")}.`)

          const archive = await pack(directory, {
            withholdSecrets: options.withholdSecrets === true,
            exclude: options.uploadExclude,
            include: options.uploadInclude,
          })
          if (archive.withheld.length)
            notes.push(
              `Not uploaded because they look like secrets: ${archive.withheld.join(", ")}. Add patterns to the plugin's "uploadInclude" option to send them.`,
            )
          const task = `rs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
          const controller = new AbortController()
          const entry: { controller: AbortController; result?: RunResult } = { controller }
          running.set(task, entry)
          const startedAt = Date.now()
          let handleSaved = false
          // Record the sandbox as soon as it exists, so the panel can stop a task that is still running.
          const track = (status: string, detail?: Record<string, unknown>) =>
            void registry
              .update(task, { detail: status, ...(typeof detail?.sandboxID === "string" ? { sandbox: detail.sandboxID } : {}) })
              .catch(() => {})
          const runInput = (progress: RunInput["progress"]): RunInput => ({
            archive: archive.archive,
            prompt: archive.withheld.length
              ? `${input.prompt}\n\n(These files exist in the user's project but were withheld because they may contain secrets: ${archive.withheld.join(", ")}. Do not recreate them; if the task needs their values, say so in your report.)`
              : input.prompt,
            title: input.description,
            agent: input.agent || options.agent || "build",
            model,
            credentials,
            variables,
            preview: input.preview === true,
            previewMinutes,
            signal: controller.signal,
            notBefore: notBefore(task),
            progress: (status, detail) => {
              track(status, detail)
              progress(status, detail)
            },
          })
          const viaSandbox = (auth: RailwayAuth) => (progress: RunInput["progress"]) =>
            runSandbox(
              {
                auth,
                // A running exec (the agent server or the preview) keeps a sandbox alive, so the idle timeout only decides
                // how long a finished sandbox lingers before Railway reclaims it.
                idleTimeoutMinutes: options.idleTimeoutMinutes ?? 10,
                maxMinutes,
                opencodeVersion: options.matchVersion ? ctx.app.version : undefined,
                network,
              },
              runInput(progress),
              async (handle) => {
                await ctx.storage.set(handleKey(task), handle as never)
                handleSaved = true
                // Desktop lists running sandboxes as servers; tell it this one is now reachable.
                await emit(task).catch(() => {})
              },
            )
          const finish = async (result: RunResult) => {
            entry.result = result
            return complete(task, directory, startedAt, result, notes)
          }
          const fail = async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            await registry.update(task, { status: controller.signal.aborted ? "stopped" : "failed", detail: message }).catch(() => {})
            return message
          }
          const record = (backend: SandboxRecord["backend"], status: SandboxRecord["status"], detail: string) =>
            registry.put({
              task,
              description: input.description,
              backend,
              status,
              detail,
              directory,
              sessionID: context.sessionID,
              startedAt,
              updatedAt: startedAt,
              ...(backend === "sandbox" ? { expiresAt: startedAt + maxMinutes * 60_000 } : {}),
              ...(needsAccount ? { variables: Object.keys(variables) } : {}),
              ...(backend === "sandbox" ? { network } : {}),
            })
          const background = (label: string, work: () => Promise<RunResult>) => {
            watch(
              { task, description: input.description, sessionID: context.sessionID },
              controller,
              async () => finish(await work()),
              () => handleSaved,
            )
            return label
          }
          const summary = `${network === "isolated" ? "isolated network" : "private network"}; ${archive.git ? `${archive.files} files` : "project directory"}, ${(archive.archive.byteLength / 1024).toFixed(0)} KiB; model ${model ? `${model.providerID}/${model.id}` : "remote default"}${input.preview ? "; preview requested" : ""}${needsAccount ? `; variables ${Object.keys(variables).join(", ")}` : ""}`

          // 1. A connected Railway account runs on Railway Sandboxes.
          const auth = await account().catch((error) => {
            running.delete(task)
            throw error instanceof SetupError ? error : new Error(`Railway account check failed: ${String(error)}`)
          })
          let run: ((progress: RunInput["progress"]) => Promise<RunResult>) | undefined
          let backend: SandboxRecord["backend"] = "pending"
          let where = ""
          let refusal: string | undefined
          if (auth) {
            run = viaSandbox(auth)
            backend = "sandbox"
            where = `a Railway sandbox in ${auth.describe}`
          } else if (needsAccount) {
            refusal = "Railway variables need a Railway account, and none is connected."
          } else if (options.anonymous !== false) {
            // 2. No account: try a free anonymous sandbox.
            const vm = await FreeVM.identity(STATE_DIR, directory)
            const manifest = await FreeVM.probe(vm).catch((error) => {
              if (error instanceof AnonymousUnavailable) return error
              throw error
            })
            if (manifest instanceof AnonymousUnavailable)
              refusal = `Free anonymous Railway sandboxes are unavailable right now (${manifest.message}).`
            else {
              run = (progress) => FreeVM.runFreeVM(vm, runInput(progress), manifest)
              backend = "free-vm"
              where = "a free anonymous Railway sandbox (ssh railway.new)"
            }
          }

          if (run) {
            await record(backend, "running", "Starting")
            if (input.wait) {
              try {
                return {
                  content: await finish(await run((status, detail) => void context.progress({ status, ...detail }).catch(() => {}))),
                  metadata: { task },
                }
              } catch (error) {
                throw new Error(await fail(error))
              } finally {
                running.delete(task)
              }
            }
            return {
              content: background(
                [
                  `Task ${task} is starting on ${where} (${summary}).`,
                  "It runs in the background; you will receive a <railway_sandbox> message when it finishes.",
                  "DO NOT sleep, poll, or duplicate its work. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
                ].join("\n"),
                () => run(() => {}),
              ),
              metadata: { task, status: "running" },
            }
          }

          // 3. No account and no anonymous sandbox: hand off to Railway sign-in.
          const reason = refusal ?? "No Railway account is connected."
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
          await record("pending", "awaiting-sign-in", "Waiting for Railway sign-in")
          return {
            content: background(
              [
                reason,
                `To continue on their own Railway account, the user must sign in with Railway here: ${attempt.url}`,
                "Relay that link to the user now. The link expires in 10 minutes.",
                `Task ${task} starts automatically as soon as they approve (${summary}); you will receive a <railway_sandbox> message when it finishes. Do not poll.`,
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
                await registry.update(task, { backend: "sandbox", network, status: "running", detail: "Signed in; starting", expiresAt: Date.now() + maxMinutes * 60_000 })
                return viaSandbox(connected)(() => {})
              },
            ),
            metadata: { task, status: "awaiting-sign-in", url: attempt.url },
          }
        },
      })

      editor.add({
        name: `${TOOL}_variables`,
        options: { codemode: false },
        description: [
          "Lists the Railway project's services and the NAMES of their environment variables (never values), so you can pass references to railway_sandbox's `variables`.",
          'Reference a service variable as ${{ServiceName.VARIABLE}} and a shared variable as ${{shared.VARIABLE}}, for example {"DATABASE_URL": "${{Postgres.DATABASE_URL}}"}.',
          "Requires a connected Railway account.",
        ].join("\n"),
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const auth = await account()
          if (!auth) throw new SetupError(`No Railway account is connected. ${CONNECT_HINT}`)
          const listing = await listVariables(auth)
          const lines = [
            `Railway project ${auth.describe}:`,
            ...listing.services.map((service) => `- ${service.service}: ${service.names.join(", ") || "(no variables)"}`),
            ...(listing.shared.length ? [`- shared: ${listing.shared.join(", ")}`] : []),
            "",
            "Pass references, not values: e.g. variables = {\"DATABASE_URL\": \"${{" + (listing.services[0]?.service ?? "Service") + "." + (listing.services[0]?.names[0] ?? "VARIABLE") + "}}\"}.",
          ]
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: `${TOOL}_status`,
        options: { codemode: false },
        description: [
          "Shows what railway_sandbox tasks are doing right now: the remote agent's todo list, recent tool calls with output, its latest messages, files changed so far, and time left.",
          "Without a task, summarizes every active task. Read-only.",
          "Use it when the user asks how a task is going, or when you need its progress to decide what to do next. Never call it in a loop or to wait for a task: you are notified with a <railway_sandbox> message when it finishes.",
          "Set watch=true to also get a single-use link (valid 5 minutes) that opens the remote OpenCode session live in a browser; give it to the user.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task ID from railway_sandbox. Omit to summarize all active tasks." },
            watch: { type: "boolean", description: "Also return a single-use link to watch the remote session in a browser. Requires task." },
          },
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as { task?: string; watch?: boolean }
          // Agents, weaker models especially, tend to poll despite the description. A repeat check soon after the last
          // one, with no new user message in between, gets a short nudge instead of the full (token-heavy) status.
          if (!input.watch) {
            const key = `${context.sessionID}:${input.task ?? "*"}`
            const last = lastChecks.get(key)
            const now = Date.now()
            const lastUser = await ctx.session
              .context({ sessionID: context.sessionID })
              .then((messages) =>
                Math.max(0, ...messages.filter((message) => message.type === "user").map((message) => message.time.created)),
              )
              .catch(() => now)
            if (last !== undefined && now - last < STATUS_COOLDOWN_MS && lastUser < last)
              return {
                content: [
                  `Checked ${Math.round((now - last) / 1000)}s ago; nothing worth reporting since.`,
                  "Do not check again: each task's <railway_sandbox> report arrives on its own and wakes you.",
                  "End your turn now unless you have other work to do.",
                ].join(" "),
                metadata: { throttled: true },
              }
            lastChecks.set(key, now)
            // Checking every task also counts as checking each one.
            if (!input.task) for (const record of await registry.list()) lastChecks.set(`${context.sessionID}:${record.task}`, now)
          }
          if (!input.task) {
            const active = (await registry.list()).filter(isLive)
            if (!active.length) return { content: "No Railway sandbox tasks are running." }
            const lines = await Promise.all(
              active.map(async (record) => {
                const target = await live(record.task).catch(() => undefined)
                const activity = target ? await inspectSandbox(target.auth, target.handle, context.signal).catch(() => undefined) : undefined
                return describe(record, activity && { ...activity, said: activity.said.slice(-1), tools: activity.tools.slice(-3) })
              }),
            )
            return { content: [...lines, REMINDER].join("\n\n") }
          }
          const record = await registry.get(input.task)
          if (!record) throw new SetupError(`Unknown task ${input.task}.`)
          const target = await live(input.task).catch((error) => {
            if (input.watch) throw error
            return undefined
          })
          const activity = target ? await inspectSandbox(target.auth, target.handle, context.signal) : undefined
          const link =
            target && input.watch && target.handle.url ? await watchLink(target.auth, target.handle, context.signal) : undefined
          const unwatchable = target && input.watch && !target.handle.url
          return {
            content: [
              describe(record, activity),
              ...(link ? ["", `Watch live (single use, expires in ${Math.round(link.expiresIn / 60)} minutes): ${link.url}`] : []),
              ...(unwatchable
                ? ["", "This sandbox is isolated (no public URL), so it cannot be watched in a browser or Desktop tab; the activity above is the live view. Start future tasks with live: true to watch them."]
                : []),
              ...(target ? ["", REMINDER] : []),
            ].join("\n"),
          }
        },
      })

      editor.add({
        name: `${TOOL}_message`,
        options: { codemode: false },
        description: [
          "Sends a follow-up instruction to a running railway_sandbox task's remote agent, like continuing a subagent.",
          'delivery "steer" (default) adds it to the current turn so the agent sees it at its next step; "queue" runs it after the current turn.',
          "The task's report still arrives as a single <railway_sandbox> message once the remote agent has finished everything, including this follow-up.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task ID from railway_sandbox" },
            message: { type: "string", description: "The instruction for the remote agent. It cannot see this conversation, so be specific." },
            delivery: { type: "string", enum: ["steer", "queue"], description: 'Defaults to "steer".' },
          },
          required: ["task", "message"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as { task: string; message: string; delivery?: "steer" | "queue" }
          const { auth, handle } = await live(input.task)
          // Recorded before sending, so the follower cannot mistake a pause right after this message for the end.
          await ctx.storage.set(steerKey(input.task), Date.now())
          await messageSandbox(auth, handle, input.message, input.delivery ?? "steer", context.signal)
          await registry.update(input.task, { detail: `Follow-up sent (${input.delivery ?? "steer"})` })
          return { content: `Sent to ${input.task} (${input.delivery ?? "steer"}). Its report arrives when the remote agent finishes, including this follow-up.` }
        },
      })

      editor.add({
        name: `${TOOL}_apply`,
        options: { codemode: false },
        description: [
          "Applies the patch from a finished railway_sandbox task to the local project and reports the outcome.",
          "Tries a clean apply, then a three-way merge (leaving conflict markers in conflicting files), then applies what it can and writes .rej files for the rest.",
          "Set check=true to only report whether it would apply cleanly.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task ID from the <railway_sandbox> report" },
            check: { type: "boolean", description: "Only check whether the patch applies cleanly. Defaults to false." },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as { task: string; check?: boolean }
          const record = await registry.get(input.task)
          const patchFile = record?.patchFile ?? patchPath(input.task)
          if (!existsSync(patchFile))
            throw new Error(`No patch for task ${input.task}: the task made no changes, or its patch file (${patchFile}) was removed.`)
          const directory = (await ctx.session.get({ sessionID: context.sessionID })).location.directory
          const files = await patchFiles(directory, patchFile)
          if (!input.check)
            // The same permission the edit tools ask for, so agents that may not edit (such as Plan) cannot apply.
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
              action: "edit",
              resources: files.map((file) => file.replaceAll("\\", "/")),
              save: ["*"],
            })
          const result = await applyPatch(directory, patchFile, { check: input.check })
          if (!input.check && result.status !== "failed") await registry.update(input.task, { applied: true })
          return {
            content: [
              `${input.check ? "Check" : "Apply"} of ${input.task}: ${result.status}. ${result.message}`,
              `Files in the patch: ${result.files.join(", ")}`,
              ...(result.conflicts.length ? [`Files with conflict markers: ${result.conflicts.join(", ")}`] : []),
              ...(result.rejects.length ? [`Rejected hunks written to: ${result.rejects.join(", ")}`] : []),
            ].join("\n"),
            metadata: { status: result.status },
          }
        },
      })

      editor.add({
        name: `${TOOL}_stop`,
        options: { codemode: false },
        description: "Stops a railway_sandbox task and destroys its sandbox, for example to take a preview down early. Takes the task ID from the report.",
        input: {
          type: "object",
          properties: { task: { type: "string", description: "The task ID from the <railway_sandbox> report" } },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (raw) => ({ content: (await stopTask((raw as { task: string }).task)).message }),
      })
    })

    // Resume shortly after load, then periodically, so a task orphaned by an overlapping reload is still picked up.
    const resumeSoon = setTimeout(() => void resume().catch(() => {}), 2000)
    const resumeLater = setInterval(() => void resume().catch(() => {}), 30_000)

    return async () => {
      clearTimeout(resumeSoon)
      clearInterval(resumeLater)
      OAuth.cancelPending(new Error("OpenCode plugin unloaded"))
      // Detach rather than destroy: sandbox tasks keep running and the next instance resumes them. Their in-VM time
      // caps still bound them if no instance ever comes back.
      for (const [task, entry] of running) {
        entry.controller.abort(new Detached("OpenCode plugin unloaded"))
        following.delete(task)
      }
    }
  },
})
