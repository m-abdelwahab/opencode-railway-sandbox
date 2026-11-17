// Standalone exercise of the sandbox backend, outside OpenCode.
// Usage: RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... bun scripts/run-remote.ts <dir> "<prompt>" [--preview]
import { runSandbox } from "../src/sandbox.ts"
import { pack } from "../src/workspace.ts"

const args = process.argv.slice(2)
const preview = args.includes("--preview")
const [dir = ".", prompt = "Run the tests and fix any failures."] = args.filter((arg) => arg !== "--preview")
const t0 = Date.now()
const packed = await pack(dir)
console.log(`packed ${packed.files} files, ${packed.archive.byteLength} bytes`)
const result = await runSandbox(
  {
    auth: { token: process.env.RAILWAY_API_TOKEN!, authType: "bearer", environmentId: process.env.RAILWAY_ENVIRONMENT_ID!, describe: "test" },
    idleTimeoutMinutes: 10,
    maxMinutes: 30,
    opencodeVersion: process.env.MATCH_VERSION,
    network: preview ? "private" : "isolated",
  },
  {
    archive: packed.archive,
    prompt,
    title: "standalone test",
    agent: "build",
    credentials: [],
    variables: {},
    preview,
    previewMinutes: 10,
    signal: AbortSignal.timeout(20 * 60_000),
    progress: (status, detail) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${status} ${detail ? JSON.stringify(detail) : ""}`),
  },
)
console.log("outcome:", result.outcome, "sandbox:", result.sandbox)
console.log("text:\n" + result.text)
console.log("diffstat:\n" + result.diffstat)
console.log("preview:", JSON.stringify(result.preview, null, 2))
if (!process.env.KEEP) await result.dispose()
process.exit(0)
