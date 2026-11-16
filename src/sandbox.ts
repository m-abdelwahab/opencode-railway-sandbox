import { Sandbox } from "railway"
import type { RailwayAuth } from "./railway-auth.ts"
import {
  checkPreview,
  PREVIEW_COMMAND_FILE,
  PREVIEW_PORT,
  quote,
  remoteInstructions,
  sleep,
  type RunInput,
  type RunResult,
} from "./types.ts"

export const REMOTE_DIR = "/root/workspace"
const SERVER_PORT = 4096

export interface SandboxOptions {
  readonly auth: RailwayAuth
  readonly idleTimeoutMinutes: number
  /** Hard cap on how long the remote OpenCode server may run, enforced inside the VM. */
  readonly maxMinutes: number
  /** Upgrade the sandbox's OpenCode to this version when it differs. */
  readonly opencodeVersion?: string
}

const sh = (script: string) => `bash -lc ${quote(script)}`

class HttpError extends Error {}

/**
 * Talks to the sandbox's OpenCode server. Requests go through the sandbox's public domain; when that path fails at the
 * network level (a timeout or a refused connection, not an HTTP error), the same request is made with `curl` inside the
 * VM over Railway's exec channel, which does not depend on the public route.
 */
export class Remote {
  constructor(
    readonly base: string,
    private readonly password: string,
    private readonly signal: AbortSignal,
    private readonly sandbox?: Sandbox,
  ) {}

  private parse<T>(method: string, route: string, status: number, text: string): T {
    if (status < 200 || status >= 300) throw new HttpError(`${method} ${route} -> ${status}: ${text.slice(0, 500)}`)
    const json = (text ? JSON.parse(text) : undefined) as { data: T } | T
    return json !== null && typeof json === "object" && "data" in json ? json.data : (json as T)
  }

  private async viaExec<T>(method: string, route: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? "" : Buffer.from(JSON.stringify(body)).toString("base64")
    const result = await this.sandbox!.exec(
      sh(
        `curl -sS -m 30 -X ${method} -u "opencode:$OPENCODE_PASSWORD" ` +
          (payload ? `-H 'content-type: application/json' --data-binary "$(printf %s ${payload} | base64 -d)" ` : "") +
          `-w '\\n%{http_code}' ${quote(`http://127.0.0.1:${SERVER_PORT}${route}`)}`,
      ),
      { ephemeral: true, timeoutSec: 45, signal: this.signal },
    )
    if (result.exitCode !== 0) throw new Error(`curl in the sandbox failed (${result.exitCode}): ${result.stderr.trim()}`)
    const split = result.stdout.lastIndexOf("\n")
    return this.parse(method, route, Number(result.stdout.slice(split + 1)), result.stdout.slice(0, split))
  }

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.base}${route}`, {
        method,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
        headers: {
          authorization: "Basic " + btoa(`opencode:${this.password}`),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return this.parse(method, route, response.status, await response.text())
    } catch (error) {
      if (error instanceof HttpError || this.signal.aborted || !this.sandbox) throw error
      return this.viaExec(method, route, body)
    }
  }
}

interface RemoteSession {
  readonly id: string
  readonly outcome?: string
  readonly time: { readonly idle?: number }
}

interface RemoteMessage {
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly content?: ReadonlyArray<{
    readonly type: string
    readonly text?: string
    readonly name?: string
    readonly state?: { readonly status?: string; readonly input?: unknown; readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
  }>
  readonly error?: unknown
}

/** The message list is newest-first; sort explicitly so ordering changes across versions do not matter. */
const chronological = (messages: ReadonlyArray<RemoteMessage>) =>
  messages.toSorted((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

/**
 * Abort reason meaning "stop watching, keep the sandbox": used when the plugin reloads, so a new instance can resume
 * following the task instead of the work being thrown away.
 */
export class Detached extends Error {}

/** Everything needed to follow a started task again from another plugin instance. Contains the server password. */
export interface Handle {
  readonly sandboxID: string
  readonly url: string
  readonly password: string
  readonly sessionID: string
  readonly previewDomain?: string
}

type FollowInput = Pick<RunInput, "preview" | "previewMinutes" | "signal" | "progress"> & {
  /**
   * When a follow-up was last sent to the remote agent. An idle session counts as finished only if it went idle after
   * this, so a message sent just as the agent paused is not lost.
   */
  readonly notBefore?: () => Promise<number | undefined>
}

const connectOptions = (auth: RailwayAuth) => ({
  token: auth.token,
  authType: auth.authType,
  ...(auth.environmentId ? { environmentId: auth.environmentId } : {}),
})

/** Provisions the sandbox, uploads the project, starts the remote agent, and returns a resumable handle. */
export async function startSandbox(options: SandboxOptions, input: RunInput): Promise<{ sandbox: Sandbox; handle: Handle }> {
  const password = crypto.randomUUID()
  input.progress("provisioning Railway sandbox")
  const sandbox = await Sandbox.create({
    token: options.auth.token,
    authType: options.auth.authType,
    ...(options.auth.environmentId ? { environmentId: options.auth.environmentId } : {}),
    idleTimeoutMinutes: options.idleTimeoutMinutes,
    networkIsolation: "PRIVATE",
    domains: [{ port: SERVER_PORT }, ...(input.preview ? [{ port: PREVIEW_PORT }] : [])],
    // User variables first so they can never replace the server's password or the preview port.
    env: { ...input.variables, OPENCODE_PASSWORD: password, PORT: String(PREVIEW_PORT) },
  })
  const dispose = () => sandbox.destroy().then(() => {}, () => {})
  try {
    const domainFor = (port: number) => sandbox.domains?.find((entry) => entry.port === port)?.domain
    const serverDomain = domainFor(SERVER_PORT)
    if (!serverDomain) throw new Error(`Sandbox ${sandbox.id} has no public domain for port ${SERVER_PORT}`)
    const url = `https://${serverDomain}`

    input.progress("uploading workspace", { sandboxID: sandbox.id, bytes: input.archive.byteLength })
    await sandbox.files.write("/root/.workspace.tgz", input.archive)
    const setup = await sandbox.exec(
      sh(
        [
          "set -e",
          `mkdir -p ${REMOTE_DIR}`,
          `tar -xzf /root/.workspace.tgz -C ${REMOTE_DIR} --warning=no-unknown-keyword`,
          "rm -f /root/.workspace.tgz",
          `cd ${REMOTE_DIR}`,
          // A fresh baseline commit lets us hand back exactly what the remote agent changed.
          "git init -q",
          "git add -A",
          "git -c user.name=opencode -c user.email=opencode@localhost commit -q --allow-empty -m baseline",
          ...(options.opencodeVersion
            ? [
                `if [ "$(opencode --version | sed 's/^opencode v//')" != ${quote(options.opencodeVersion)} ]; then opencode upgrade ${quote(options.opencodeVersion)} >/tmp/opencode-upgrade.log 2>&1 || echo "upgrade failed, using bundled version" >&2; fi`,
              ]
            : []),
          "opencode --version",
        ].join("\n"),
      ),
      { ephemeral: true, timeoutSec: 300, signal: input.signal },
    )
    if (setup.exitCode !== 0) throw new Error(`Workspace setup failed (${setup.exitCode}): ${setup.stderr || setup.stdout}`)

    input.progress("starting remote OpenCode", { version: setup.stdout.trim().split("\n").at(-1) })
    // `timeout` makes the VM enforce the lifetime cap even if this machine goes away mid-run: once the server exits,
    // nothing keeps the sandbox busy and Railway's idle timeout destroys it.
    const server = sandbox.exec(
      sh(`cd ${REMOTE_DIR} && exec timeout ${options.maxMinutes}m opencode serve --hostname 0.0.0.0 --port ${SERVER_PORT}`),
      { captureOutput: false },
    )
    await server.sessionName
    await server.detach()

    const remote = new Remote(url, password, input.signal, sandbox)
    const ready = Date.now() + 120_000
    while (!(await remote.request("GET", "/api/info").then(() => true, () => false))) {
      if (Date.now() > ready) throw new Error("Remote OpenCode server did not become ready within 120s")
      if (input.signal.aborted) throw input.signal.reason
      await sleep(1000)
    }

    for (const credential of input.credentials)
      await remote.request("POST", "/api/credential", {
        integrationID: credential.integrationID,
        label: "Forwarded from local OpenCode",
        value: credential.value,
        activate: true,
      })

    const session = await remote.request<RemoteSession>("POST", "/api/session", {
      title: input.title,
      agent: input.agent,
      ...(input.model ? { model: input.model } : {}),
      location: { directory: REMOTE_DIR },
      // The sandbox is disposable and isolated, so the remote agent runs without approval prompts.
      // Nobody is attached to answer questions, so that tool is denied instead of blocking forever.
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
      ],
    })
    const previewDomain = input.preview ? domainFor(PREVIEW_PORT) : undefined
    await remote.request("POST", `/api/session/${session.id}/prompt`, {
      text: remoteInstructions(input, previewDomain ? `https://${previewDomain}` : undefined),
    })
    input.progress("running", { sessionID: session.id })
    return { sandbox, handle: { sandboxID: sandbox.id, url, password, sessionID: session.id, previewDomain } }
  } catch (error) {
    // Nothing can resume a task that never started, so the sandbox goes even when detaching.
    await dispose()
    throw error
  }
}

/** Waits for a started task, collects its patch, and starts its preview. Resumable from a stored handle. */
export async function followSandbox(
  options: Pick<SandboxOptions, "auth">,
  handle: Handle,
  input: FollowInput,
  connected?: Sandbox,
): Promise<RunResult> {
  const sandbox = connected ?? (await Sandbox.connect(handle.sandboxID, connectOptions(options.auth)))
  const dispose = () => sandbox.destroy().then(() => {}, () => {})
  try {
    const remote = new Remote(handle.url, handle.password, input.signal, sandbox)
    const session = { id: handle.sessionID }
    const previewDomain = handle.previewDomain
    let final: RemoteSession = { id: handle.sessionID, time: {} }
    let lastStatus = ""
    let lostSince: number | undefined
    while (true) {
      await sleep(2500)
      if (input.signal.aborted) throw input.signal.reason
      let polled: [Record<string, unknown>, RemoteSession, RemoteMessage[]]
      try {
        polled = await Promise.all([
          remote.request<Record<string, unknown>>("GET", "/api/session/active"),
          remote.request<RemoteSession>("GET", `/api/session/${session.id}`),
          remote.request<RemoteMessage[]>("GET", `/api/session/${session.id}/message`),
        ])
        lostSince = undefined
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason
        lostSince ??= Date.now()
        if (Date.now() - lostSince > 180_000)
          throw new Error(`Lost contact with the remote OpenCode server for 3 minutes: ${error instanceof Error ? error.message : String(error)}`)
        input.progress("reconnecting to the remote OpenCode server")
        lastStatus = ""
        continue
      }
      const [active, current, messages] = polled
      final = current
      const lastTool = chronological(messages)
        .flatMap((message) => message.content ?? [])
        .filter((part) => part.type === "tool")
        .at(-1)?.name
      const status = `running (${messages.length} messages${lastTool ? `, last tool: ${lastTool}` : ""})`
      if (status !== lastStatus) input.progress(status, { sessionID: session.id })
      lastStatus = status
      // The session was created fresh for this prompt, so an outcome plus an idle time means this run finished.
      if (!Object.hasOwn(active ?? {}, session.id) && current.outcome !== undefined && current.time.idle !== undefined) {
        const sent = await input.notBefore?.().catch(() => undefined)
        if (sent === undefined || current.time.idle >= sent) break
      }
    }

    const lastAssistant = chronological(await remote.request<RemoteMessage[]>("GET", `/api/session/${session.id}/message`))
      .filter((message) => message.type === "assistant")
      .at(-1)
    const text =
      lastAssistant?.content
        ?.filter((part) => part.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n\n") || (lastAssistant?.error ? `Remote agent error: ${JSON.stringify(lastAssistant.error)}` : "")

    input.progress("collecting changes")
    const diff = await sandbox.exec(
      sh(`cd ${REMOTE_DIR} && git add -A && git diff --cached --stat HEAD && echo ---PATCH--- && git diff --cached --binary HEAD`),
      { ephemeral: true, timeoutSec: 120 },
    )
    const [diffstat = "", patch = ""] = diff.stdout.split("---PATCH---\n")
    const base = {
      backend: "sandbox" as const,
      sandbox: sandbox.id,
      outcome: final.outcome ?? "unknown",
      text: text || "Remote subagent finished without a text response.",
      patch,
      diffstat: diffstat.trim(),
      dispose,
    }
    if (!input.preview) return { ...base, notes: [], running: true }

    const command = await sandbox.files.read(PREVIEW_COMMAND_FILE).then(
      (value) => String(value).trim(),
      () => "",
    )
    if (!previewDomain || !command)
      return {
        ...base,
        notes: [`No preview was started: the remote agent did not write a start command to ${PREVIEW_COMMAND_FILE}.`],
        running: true,
      }

    input.progress("starting preview", { command })
    // Swap the agent server for the app: the preview becomes the only thing keeping the VM alive, and `timeout`
    // bounds it, after which Railway's idle timeout reclaims the sandbox.
    // A plain exec instead of reattaching to the server's session: a reattached handle holds a stream open.
    await sandbox.exec("pkill -f 'opencode serve' || true", { ephemeral: true, timeoutSec: 30 })
    const app = sandbox.exec(
      sh(`cd ${REMOTE_DIR} && export PORT=${PREVIEW_PORT} HOST=0.0.0.0 && exec timeout ${input.previewMinutes}m bash -lc ${quote(command)}`),
      { captureOutput: false },
    )
    await app.sessionName
    await app.detach()
    const previewURL = `https://${previewDomain}`
    return {
      ...base,
      preview: {
        url: previewURL,
        check: await checkPreview(previewURL, 90_000),
        shareable: true,
        note: `Public HTTPS URL. It stays up for about ${input.previewMinutes} minutes, then the sandbox shuts down (start command: \`${command}\`).`,
      },
      notes: [],
      running: true,
    }
  } catch (error) {
    if (!(input.signal.reason instanceof Detached)) await dispose()
    throw error
  }
}

export async function runSandbox(options: SandboxOptions, input: RunInput, onStarted?: (handle: Handle) => Promise<void>) {
  const { sandbox, handle } = await startSandbox(options, input)
  await onStarted?.(handle)
  return followSandbox(options, handle, input, sandbox)
}

/** Destroys a sandbox started by an earlier run, for example to take a preview down early. */
export async function destroySandbox(auth: RailwayAuth, id: string) {
  const sandbox = await Sandbox.connect(id, connectOptions(auth))
  await sandbox.destroy()
}

// ---- Live access to a running task: status, follow-up messages, and a watch link -------------------------------

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** The most telling field of a tool call's input: the command, path, pattern, or URL. */
function describeInput(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const value = ["command", "path", "filePath", "pattern", "url", "query", "description"].map((key) => record[key]).find((v) => typeof v === "string")
  return typeof value === "string" ? clip(oneLine(value), 160) : ""
}

export interface Activity {
  readonly messages: number
  readonly busy: boolean
  /** The remote agent's most recent text, newest last. */
  readonly said: readonly string[]
  readonly tools: ReadonlyArray<{ readonly name: string; readonly status: string; readonly input: string; readonly output: string }>
  readonly todos?: ReadonlyArray<{ readonly content: string; readonly status: string }>
  /** `git status --porcelain` lines: files changed so far. */
  readonly changes: readonly string[]
}

const remoteFor = async (auth: RailwayAuth, handle: Handle, signal: AbortSignal) => {
  const sandbox = await Sandbox.connect(handle.sandboxID, connectOptions(auth))
  return { sandbox, remote: new Remote(handle.url, handle.password, signal, sandbox) }
}

/** Reads what a running task's remote agent is doing right now. Read-only. */
export async function inspectSandbox(auth: RailwayAuth, handle: Handle, signal: AbortSignal): Promise<Activity> {
  const { sandbox, remote } = await remoteFor(auth, handle, signal)
  const [active, messages, status] = await Promise.all([
    remote.request<Record<string, unknown>>("GET", "/api/session/active"),
    remote.request<RemoteMessage[]>("GET", `/api/session/${handle.sessionID}/message`).then(chronological),
    sandbox.exec(sh(`cd ${REMOTE_DIR} && git -c core.quotepath=off status --porcelain | head -40`), { ephemeral: true, timeoutSec: 30, signal }),
  ])
  const parts = messages.filter((message) => message.type === "assistant").flatMap((message) => message.content ?? [])
  const tools = parts.filter((part) => part.type === "tool")
  const todo = tools.filter((part) => part.name === "todowrite").at(-1)?.state?.input as { todos?: Array<{ content: string; status: string }> } | undefined
  return {
    messages: messages.length,
    busy: Object.hasOwn(active ?? {}, handle.sessionID),
    said: parts
      .filter((part) => part.type === "text" && part.text?.trim())
      .slice(-3)
      .map((part) => clip(part.text!.trim(), 600)),
    tools: tools.slice(-8).map((part) => ({
      name: part.name ?? "tool",
      status: part.state?.status ?? "unknown",
      input: describeInput(part.state?.input),
      output: clip(
        oneLine(
          (part.state?.content ?? [])
            .map((item) => item.text ?? "")
            .join(" ")
            .slice(-300),
        ),
        300,
      ),
    })),
    ...(todo?.todos ? { todos: todo.todos.map((item) => ({ content: item.content, status: item.status })) } : {}),
    changes: status.stdout.split("\n").filter(Boolean),
  }
}

/** Sends a follow-up to the remote agent: "steer" joins the current turn, "queue" runs after it. */
export async function messageSandbox(auth: RailwayAuth, handle: Handle, text: string, delivery: "steer" | "queue", signal: AbortSignal) {
  const { remote } = await remoteFor(auth, handle, signal)
  await remote.request("POST", `/api/session/${handle.sessionID}/prompt`, { text, delivery })
}

/**
 * Mints a single-use, short-lived link that signs a browser into the remote OpenCode's web UI, the way
 * `opencode pair` does, so the server password never appears in a URL.
 */
export async function watchLink(auth: RailwayAuth, handle: Handle, signal: AbortSignal) {
  const { remote } = await remoteFor(auth, handle, signal)
  const pairing = await remote.request<{ code: string; expires_in: number }>("POST", "/api/pair")
  return { url: `${handle.url}/auth/connect/${pairing.code}`, expiresIn: pairing.expires_in, sessionID: handle.sessionID }
}
