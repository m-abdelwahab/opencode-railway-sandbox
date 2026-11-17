// End-to-end: a local OpenCode session on a weaker model fans work out to Railway sandboxes and checks in on them.
//
// Requires a running OpenCode with this plugin loaded and Railway connected. Optionally set RAILWAY_API_TOKEN and
// RAILWAY_ENVIRONMENT_ID to also check Railway's own sandbox list.
//
//   bun scripts/e2e-subagents.ts [--model openai/gpt-5.6-luna] [--server http://127.0.0.1:4096]
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const MODEL = arg("model", "openai/gpt-5.6-luna")!
const SERVER = arg("server")
const t0 = Date.now()
const log = (...args: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...args)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const failures: string[] = []
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

// ---- OpenCode access through its CLI, which handles discovery and auth -----------------------------------------
const serverArgs = SERVER ? ["--server", SERVER] : []
function api(method: string, route: string, body?: unknown) {
  const result = spawnSync("opencode", ["api", method, route, ...serverArgs, ...(body ? ["--data", JSON.stringify(body)] : [])], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`opencode api ${method} ${route}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}
function run(directory: string, message: string, extra: string[] = []) {
  return new Promise<Array<Record<string, any>>>((resolve) => {
    // `opencode run` takes its directory from $PWD, not the process cwd, so set both.
    const child = spawn("opencode", ["run", ...serverArgs, "--format", "json", "--model", MODEL, ...extra, message], {
      cwd: directory,
      env: { ...process.env, PWD: directory },
    })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk))
    child.on("close", () =>
      resolve(
        out
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .flatMap((line) => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          }),
      ),
    )
  })
}
// The task registry is shared by every location, so read it from the default one and filter by session.
const allTasks = () => api("post", "/api/rpc/railway-sandbox/list", { input: {} }).output.sandboxes as Array<Record<string, any>>
let sessionID = ""
const tasks = (_directory: string) => allTasks().filter((task) => task.sessionID === sessionID)
const messages = (sessionID: string) =>
  (api("get", `/api/session/${sessionID}/message`).data as Array<Record<string, any>>).toSorted((a, b) => a.time.created - b.time.created)
const toolCalls = (sessionID: string) =>
  messages(sessionID)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part: any) => part.type === "tool").map((part: any) => ({ ...part, at: message.time.created })))

// ---- Fixture: three independent broken modules ---------------------------------------------------------------------
// Sessions record the resolved path (/private/var on macOS), so compare against the same.
const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rs-e2e-")))
mkdirSync(path.join(directory, "src"))
mkdirSync(path.join(directory, "test"))
const files: Record<string, string> = {
  "package.json": JSON.stringify({ name: "rs-e2e", private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2),
  ".gitignore": "node_modules\n",
  "src/math.js": "// TODO: implement\nexport function sum(numbers) {\n  return 0\n}\n",
  "src/strings.js": "// TODO: implement\nexport function slugify(text) {\n  return text\n}\n",
  "src/dates.js": "// TODO: implement\nexport function daysBetween(a, b) {\n  return 0\n}\n",
  "test/math.test.js":
    'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { sum } from "../src/math.js"\n\ntest("sum", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 45_000)) // keeps the task running long enough to check in on\n \n  assert.equal(sum([1, 2, 3]), 6)\n  assert.equal(sum([]), 0)\n  assert.equal(sum([-1, 1.5]), 0.5)\n})\n',
  "test/strings.test.js":
    'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { slugify } from "../src/strings.js"\n\ntest("slugify", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 45_000)) // keeps the task running long enough to check in on\n \n  assert.equal(slugify("Hello World"), "hello-world")\n  assert.equal(slugify("  Railway  Sandboxes! "), "railway-sandboxes")\n  assert.equal(slugify("Ünïcode & Co"), "unicode-co")\n})\n',
  "test/dates.test.js":
    'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { daysBetween } from "../src/dates.js"\n\ntest("daysBetween", async () => {\n  await new Promise((resolve) => setTimeout(resolve, 45_000)) // keeps the task running long enough to check in on\n \n  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30)\n  assert.equal(daysBetween("2026-03-31", "2026-03-01"), 30)\n  assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2)\n})\n',
}
for (const [file, content] of Object.entries(files)) writeFileSync(path.join(directory, file), content)
spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.name=e2e -c user.email=e2e@example.com commit -qm fixture"], { cwd: directory })

log(`fixture at ${directory}; model ${MODEL}`)

// ---- 1. Fan out ----------------------------------------------------------------------------------------------------
const kickoff = await run(
  directory,
  [
    "This project has three independent modules with failing tests: src/math.js, src/strings.js, src/dates.js (tests in test/).",
    "Fix them in parallel: start one railway_sandbox task per module, in the background, each told to implement only its module and run `npm test` (its own test must pass; ignore the other modules' failures).",
    "Once all three are started, check in on them once with railway_sandbox_status and tell me where each one is.",
    "When each report arrives, apply its patch with railway_sandbox_apply. When all three are applied, run npm test locally and tell me the result.",
  ].join(" "),
  ["--title", "E2E: weak model fans out to Railway sandboxes"],
)
sessionID = kickoff.find((event) => event.sessionID)?.sessionID as string
log(`session ${sessionID}`)
if (!sessionID) throw new Error("no session was created")
// Safety: the agent must only ever touch the fixture. Abort everything if a task recorded another folder.
const wrong = tasks(directory).filter((task) => task.directory !== directory)
if (wrong.length) {
  api("post", `/api/session/${sessionID}/interrupt`, { resume: false })
  for (const task of wrong) api("post", "/api/rpc/railway-sandbox/stop", { input: { task: task.task } })
  throw new Error(`tasks ran in ${wrong[0]!.directory} instead of the fixture ${directory}; session interrupted and tasks stopped`)
}

// ---- 2. A user check-in mid-run --------------------------------------------------------------------------------------
// Ask as soon as all three sandboxes exist and their agents are working (the slow tests keep them busy).
for (let waited = 0; waited < 180_000; waited += 3_000) {
  const current = tasks(directory)
  if (current.length >= 3 && current.every((task) => task.status === "running" && task.sandbox && /running \(/.test(task.detail ?? ""))) break
  await sleep(3_000)
}
const live = tasks(directory).filter((task) => task.status === "running")
log(`${live.length} task(s) running; asking for a check-in`)
// Railway's own view while they run: the plugin's records should match real, running sandboxes.
let railwayRunning: Set<string> | undefined
let railwayNetworks: Map<string, { isolation?: string; domains: number }> | undefined
if (process.env.RAILWAY_API_TOKEN && process.env.RAILWAY_ENVIRONMENT_ID) {
  const { Sandbox } = await import("railway")
  const listed = await Sandbox.list()
  railwayRunning = new Set(listed.filter((sandbox) => sandbox.status === "RUNNING").map((sandbox) => sandbox.id))
  railwayNetworks = new Map(listed.map((sandbox) => [sandbox.id, { isolation: sandbox.networkIsolation, domains: sandbox.domains?.length ?? 0 }]))
  log(`Railway reports ${railwayRunning.size} running sandbox(es)`)
}
const liveSandboxes = tasks(directory).filter((task) => task.status === "running" && task.sandbox).map((task) => task.sandbox as string)
const checkinStarted = Date.now()
await run(directory, "How are my sandboxes doing?", ["--session", sessionID])

// ---- 3. Wait for every report and the agent's wrap-up ------------------------------------------------------------
const deadline = Date.now() + 15 * 60_000
let reports: Array<Record<string, any>> = []
while (Date.now() < deadline) {
  const all = tasks(directory)
  reports = messages(sessionID).filter((message) => message.type === "synthetic")
  const done = all.length > 0 && all.every((task) => !["running", "awaiting-sign-in"].includes(task.status))
  const idle = (api("get", `/api/session/active`).data ?? {})[sessionID] === undefined
  log(`tasks: ${all.map((task) => `${task.task}=${task.status}`).join(", ")}; reports: ${reports.length}`)
  if (done && reports.length >= all.length && idle) break
  await sleep(15_000)
}
await sleep(10_000)

// ---- 4. Verify ---------------------------------------------------------------------------------------------------
console.log("\nResults")
const all = tasks(directory)
const calls = toolCalls(sessionID)
const starts = calls.filter((call) => call.name === "railway_sandbox")
const statuses = calls.filter((call) => call.name === "railway_sandbox_status")
const applies = calls.filter((call) => call.name === "railway_sandbox_apply" && call.state?.input?.check !== true)

check(starts.length >= 3, "the main agent started a sandbox task per module", `${starts.length} railway_sandbox calls`)
check(all.length >= 3 && all.every((task) => task.backend === "sandbox" && task.sandbox), "each task ran on its own Railway sandbox", all.map((task) => task.sandbox?.slice(0, 8)).join(", "))
check(new Set(all.map((task) => task.sandbox)).size === all.length, "sandboxes are distinct")

if (railwayRunning)
  check(
    liveSandboxes.length >= 3 && liveSandboxes.every((id) => railwayRunning!.has(id)),
    "mid-run, Railway itself reported every task's sandbox as RUNNING",
    `${liveSandboxes.filter((id) => railwayRunning!.has(id)).length}/${liveSandboxes.length}`,
  )

if (railwayNetworks)
  check(
    liveSandboxes.every((id) => railwayNetworks!.get(id)?.isolation === "PRIVATE" && railwayNetworks!.get(id)?.domains === 1),
    "sandboxes run with the default network: private, server published for Watch live",
    liveSandboxes.map((id) => `${railwayNetworks!.get(id)?.isolation}/${railwayNetworks!.get(id)?.domains} domains`).join(", "),
  )

const statusOutputs = statuses.map((call) => JSON.stringify(call.state?.content ?? call.state?.output ?? ""))
check(statuses.length >= 1, "the main agent checked in with railway_sandbox_status", `${statuses.length} call(s)`)
check(
  statusOutputs.some((output) => /remote agent: (working|idle)/.test(output) && /recent tool calls|files changed so far/.test(output)),
  "a check-in returned live remote progress (agent state, tool calls, changed files)",
)
check(
  statuses.some((call) => call.at >= checkinStarted),
  'the user\'s "How are my sandboxes doing?" was answered with a fresh check-in',
)
const throttled = statuses.filter((call) => /^"?\[?.*Checked \d+s ago/.test(JSON.stringify(call.state?.content ?? "")))
check(
  statuses.length - throttled.length <= 5,
  "no polling loop: at most 5 full status replies",
  `${statuses.length - throttled.length} full, ${throttled.length} throttled`,
)

const perTask = all.map((task) => reports.filter((report) => String(report.text).includes(`task="${task.task}"`)).length)
check(perTask.every((count) => count === 1), "exactly one report per task", perTask.join(", "))
check(all.every((task) => task.status === "finished"), "every task finished", all.map((task) => task.status).join(", "))
check(applies.length >= 3, "the main agent applied every patch", `${applies.length} apply calls`)

const local = spawnSync("npm", ["test"], { cwd: directory, encoding: "utf8" })
check(local.status === 0, "npm test passes locally after applying the patches", (local.stdout + local.stderr).match(/# (pass|fail) \d+/g)?.join(" ") ?? "")

console.log(`\nSession ${sessionID}; fixture ${directory}`)
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed")
process.exit(failures.length ? 1 : 0)
