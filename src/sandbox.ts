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

class Remote {
  constructor(
    readonly base: string,
    private readonly authorization: string,
    private readonly signal: AbortSignal,
  ) {}

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${route}`, {
      method,
      signal: this.signal,
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 500)}`)
    const json = (text ? JSON.parse(text) : undefined) as { data: T } | T
    return json !== null && typeof json === "object" && "data" in json ? json.data : (json as T)
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
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string }>
  readonly error?: unknown
}

/** The message list is newest-first; sort explicitly so ordering changes across versions do not matter. */
const chronological = (messages: ReadonlyArray<RemoteMessage>) =>
  messages.toSorted((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

export async function runSandbox(options: SandboxOptions, input: RunInput): Promise<RunResult> {
  const password = crypto.randomUUID()
  input.progress("provisioning Railway sandbox")
  const sandbox = await Sandbox.create({
    token: options.auth.token,
    authType: options.auth.authType,
    ...(options.auth.environmentId ? { environmentId: options.auth.environmentId } : {}),
    idleTimeoutMinutes: options.idleTimeoutMinutes,
    networkIsolation: "PRIVATE",
    domains: [{ port: SERVER_PORT }, ...(input.preview ? [{ port: PREVIEW_PORT }] : [])],
    env: { OPENCODE_PASSWORD: password, PORT: String(PREVIEW_PORT) },
  })
  const dispose = () => sandbox.destroy().catch(() => {})
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

    const remote = new Remote(url, "Basic " + btoa(`opencode:${password}`), input.signal)
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
    let final = session
    let lastStatus = ""
    while (true) {
      await sleep(2500)
      if (input.signal.aborted) throw input.signal.reason
      const [active, current, messages] = await Promise.all([
        remote.request<Record<string, unknown>>("GET", "/api/session/active"),
        remote.request<RemoteSession>("GET", `/api/session/${session.id}`),
        remote.request<RemoteMessage[]>("GET", `/api/session/${session.id}/message`),
      ])
      final = current
      const lastTool = chronological(messages)
        .flatMap((message) => message.content ?? [])
        .filter((part) => part.type === "tool")
        .at(-1)?.name
      const status = `running (${messages.length} messages${lastTool ? `, last tool: ${lastTool}` : ""})`
      if (status !== lastStatus) input.progress(status, { sessionID: session.id })
      lastStatus = status
      // The session was created fresh for this prompt, so an outcome plus an idle time means this run finished.
      if (!Object.hasOwn(active ?? {}, session.id) && current.outcome !== undefined && current.time.idle !== undefined) break
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
      computer: sandbox.id,
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
    await dispose()
    throw error
  }
}

/** Destroys a sandbox started by an earlier run, for example to take a preview down early. */
export async function destroySandbox(auth: RailwayAuth, id: string) {
  const sandbox = await Sandbox.connect(id, {
    token: auth.token,
    authType: auth.authType,
    ...(auth.environmentId ? { environmentId: auth.environmentId } : {}),
  })
  await sandbox.destroy()
}
