import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  AnonymousUnavailable,
  checkPreview,
  PREVIEW_COMMAND_FILE,
  PREVIEW_PORT,
  quote,
  remoteInstructions,
  type RunInput,
  type RunResult,
} from "./types.ts"

/**
 * Anonymous tier: `ssh railway.new` gives a free 2 vCPU / 2 GB VM with coding agents and a preview URL, no account
 * needed. Railway identifies the box by SSH key, so each project gets its own key and therefore its own sandbox.
 * Limits: 60 minutes to build, 3 boxes per IP per day, preview reachable only from the creating IP until claimed.
 */
const HOST = "railway.new"
const WORKSPACE = "~/workspace"

export interface SSHResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface FreeVM {
  readonly keyFile: string
  readonly knownHosts: string
}

/** Returns the per-project SSH identity, creating it on first use. */
export async function identity(stateDir: string, projectDirectory: string): Promise<FreeVM> {
  const dir = path.join(stateDir, "free-vm")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = createHash("sha256").update(projectDirectory).digest("hex").slice(0, 16)
  const keyFile = path.join(dir, `${id}.key`)
  if (!existsSync(keyFile)) {
    const result = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `opencode-railway-sandbox:${id}`, "-f", keyFile])
    if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`)
  }
  return { keyFile, knownHosts: path.join(dir, "known_hosts") }
}

function run(cmd: string, args: string[], stdin?: Buffer | string, onStdout?: (chunk: string) => void, signal?: AbortSignal) {
  return new Promise<SSHResult>((resolve, reject) => {
    const child = spawn(cmd, args, { signal })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      onStdout?.(chunk.toString())
    })
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

const ssh = (vm: FreeVM, command: string, options: { stdin?: Buffer | string; onStdout?: (chunk: string) => void; signal?: AbortSignal } = {}) =>
  run(
    "ssh",
    [
      "-F", "/dev/null",
      "-i", vm.keyFile,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${vm.knownHosts}`,
      "-o", "ConnectTimeout=20",
      "-o", "ServerAliveInterval=30",
      HOST,
      `bash -lc ${quote(command)}`,
    ],
    options.stdin,
    options.onStdout,
    options.signal,
  )

/** JSON objects Railway writes to stderr: the welcome manifest, or a refusal. */
const manifests = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })

/** Finds URL-valued fields anywhere in the manifest, keyed by their JSON path. */
const urls = (value: unknown, prefix = ""): Array<[string, string]> =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([key, inner]) => urls(inner, prefix ? `${prefix}.${key}` : key))
    : typeof value === "string" && /^https?:\/\//.test(value)
      ? [[prefix, value]]
      : []

const MARKER = "__railway_sandbox_ready__"

/** Throws AnonymousUnavailable when Railway refuses the anonymous box; returns the manifest otherwise. */
export function classify(result: SSHResult) {
  const found = manifests(result.stderr)
  const refusal = found.find((manifest) => manifest.status === "error")
  const signup = result.stderr.match(/https:\/\/railway\.com\/ssh-signup\S*/)?.[0] ?? result.stdout.match(/https:\/\/railway\.com\/ssh-signup\S*/)?.[0]
  if (refusal) throw new AnonymousUnavailable(String(refusal.description ?? "Anonymous Railway sandboxes are unavailable."), signup)
  if (!result.stdout.includes(MARKER)) {
    const text = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, " ").trim()
    if (/unavailable|sign up|limit|try again/i.test(text)) throw new AnonymousUnavailable(text.slice(0, 300), signup)
    throw new Error(`Could not reach ${HOST} (exit ${result.code}): ${text.slice(0, 300)}`)
  }
  return found
}

/** Cheap availability probe; also surfaces the manifest (preview URL, deadline, claim link) on early connects. */
export async function probe(vm: FreeVM) {
  return classify(await ssh(vm, `echo ${MARKER}`))
}

export async function runFreeVM(vm: FreeVM, input: RunInput, known: ReadonlyArray<Record<string, unknown>> = []): Promise<RunResult> {
  input.progress("uploading workspace to anonymous Railway sandbox", { bytes: input.archive.byteLength })
  const setup = await ssh(
    vm,
    [
      "set -e",
      `rm -rf ${WORKSPACE} && mkdir -p ${WORKSPACE}`,
      `tar -xzf - -C ${WORKSPACE} --warning=no-unknown-keyword`,
      `cd ${WORKSPACE}`,
      "git init -q && git add -A",
      "git -c user.name=opencode -c user.email=opencode@localhost commit -q --allow-empty -m baseline",
      `echo ${MARKER}`,
    ].join("\n"),
    { stdin: input.archive, signal: input.signal },
  )
  const manifest = [...known, ...classify(setup)]

  for (const credential of input.credentials) {
    const body = Buffer.from(JSON.stringify({ ...credential, label: "Forwarded from local OpenCode", activate: true })).toString("base64")
    const result = await ssh(vm, `opencode api post /api/credential --data "$(printf %s ${body} | base64 -d)" >/dev/null && echo ${MARKER}`, {
      signal: input.signal,
    })
    classify(result)
  }

  const links = manifest.flatMap((entry) => urls(entry))
  const claim = links.find(([key, url]) => /claim/i.test(key) || /claim/i.test(url))?.[1]
  const previewURL = links.find(([key, url]) => /preview/i.test(key) || /\.up\.railway\.app/.test(url))?.[1]

  input.progress("running on anonymous Railway sandbox")
  const prompt = Buffer.from(remoteInstructions(input, previewURL)).toString("base64")
  const args = [
    "--format json",
    "--auto",
    "--archived",
    `--title ${quote(input.title)}`,
    `--agent ${quote(input.agent)}`,
    ...(input.model ? [`--model ${quote(`${input.model.providerID}/${input.model.id}${input.model.variant ? `#${input.model.variant}` : ""}`)}`] : []),
  ].join(" ")
  let tools = 0
  let buffer = ""
  const texts: string[] = []
  const errors: string[] = []
  const handle = (line: string) => {
    if (!line.startsWith("{")) return
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string; tool?: string }; error?: { message?: string } }
      if (event.type === "text" && event.part?.text) texts.push(event.part.text)
      if (event.type === "error") errors.push(event.error?.message ?? JSON.stringify(event.error))
      if (event.type?.startsWith("tool")) input.progress(`running (${++tools} tool calls)`)
    } catch {}
  }
  const ran = await ssh(vm, `cd ${WORKSPACE} && opencode run ${args} "$(printf %s ${prompt} | base64 -d)"`, {
    signal: input.signal,
    onStdout: (chunk) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      lines.forEach(handle)
    },
  })
  handle(buffer.trim())
  if (ran.code !== 0 && texts.length === 0) classify(ran)

  input.progress("collecting changes")
  const diff = await ssh(vm, `cd ${WORKSPACE} && git add -A && git diff --cached --stat HEAD && echo ---PATCH--- && git diff --cached --binary HEAD`)
  const [diffstat = "", patch = ""] = diff.stdout.split("---PATCH---\n")

  const deadline = manifest.flatMap((entry) => Object.entries(entry)).find(([key]) => /deadline|expires/i.test(key))?.[1]
  const notes = [
    "Ran on an anonymous Railway sandbox (free, no account). It is tied to this project's SSH key, so later runs reuse the same box.",
    ...(deadline ? [`Build window ends: ${String(deadline)}.`] : []),
    ...(claim ? [`Claim link (sign up to keep the box and make its URL shareable): ${claim}`] : []),
    ...(manifest.length ? [] : ["Railway did not include a welcome manifest on this connection; the preview URL and claim link are in the first connect's output."]),
  ]
  const base = {
    backend: "free-vm" as const,
    sandbox: "anonymous railway.new box",
    outcome: errors.length && !texts.length ? "failed" : "succeeded",
    text: texts.join("").trim() || errors.join("\n") || "Remote subagent finished without a text response.",
    patch,
    diffstat: diffstat.trim(),
    notes,
    running: true,
    dispose: async () => {},
  }
  if (!input.preview) return base

  const command = (await ssh(vm, `cat ${PREVIEW_COMMAND_FILE} 2>/dev/null || true`)).stdout.trim()
  if (!command || !previewURL) return { ...base, notes: [...notes, `No preview was started (${!command ? "no start command written" : "no preview URL in the manifest"}).`] }
  await ssh(
    vm,
    `cd ${WORKSPACE} && PORT=${PREVIEW_PORT} HOST=0.0.0.0 nohup setsid timeout ${input.previewMinutes}m bash -lc ${quote(command)} > /tmp/preview.log 2>&1 < /dev/null & echo started`,
  )
  return {
    ...base,
    preview: {
      url: previewURL,
      check: await checkPreview(previewURL, 90_000),
      shareable: false,
      note: claim
        ? `Only reachable from this machine's IP until the box is claimed. Claim it to make the URL shareable: ${claim}`
        : "Only reachable from this machine's IP until the box is claimed via the link in Railway's welcome message.",
    },
  }
}
