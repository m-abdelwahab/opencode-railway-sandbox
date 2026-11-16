# Architecture

## OpenCode surfaces used

The plugin is a single OpenCode V2 **server plugin** (`Plugin.define` from `@opencode/plugin`). It uses:

| Surface | Use |
|---|---|
| `ctx.integration.transform` | Registers the `railway-computer` integration ("Railway") with three methods: OAuth (`authorize` + `refresh`), project-token key, and `RAILWAY_TOKEN`/`RAILWAY_API_TOKEN` env |
| `ctx.integration.connection.active/resolve` | Reads the Railway credential (refreshing OAuth tokens when needed) and the model provider's credential for forwarding |
| `ctx.integration.oauth.connect/status` | Starts Railway sign-in from inside a tool call when the anonymous tier is unavailable, and waits for it to complete |
| `ctx.tool.transform` | Adds `railway_computer` and `railway_computer_stop` |
| `ctx.session.get` | Reads the parent session's model and directory |
| `ctx.session.synthetic` | Delivers background results to the parent session, which wakes the parent agent (the same mechanism OpenCode's built-in subagents use) |

## Remote execution

### Railway account → Railway Sandboxes (`src/sandbox.ts`)

1. `Sandbox.create` with `networkIsolation: "PRIVATE"` and public domains for port 4096 (remote OpenCode) and, for
   previews, 8080. `OPENCODE_PASSWORD` is a random per-task value.
2. Upload the tarball with `sandbox.files.write`, extract, and create a baseline commit.
3. Start `timeout <maxMinutes>m opencode serve` as a detached exec.
4. Drive the remote server over HTTP:
   - `POST /api/credential` forwards the model credential
   - `POST /api/session` sets permissions to allow everything except `question`
   - `POST /api/session/:id/prompt`
   - poll `/api/session/active`, `/api/session/:id`, and `/api/session/:id/message` until `outcome` and `time.idle`
     are set
5. Collect `git diff --cached --binary HEAD`.
6. Preview: `pkill` the server, start `timeout <previewMinutes>m <start command>` as a detached exec, and poll the
   public URL.

Measured: sandbox ready in ~2.7s, remote OpenCode answering in ~10s, a test-fix task in ~31s, and an
install + build + preview of a Vite app in ~70s.

### Anonymous → `ssh railway.new` (`src/free-vm.ts`)

- One ed25519 key per project directory under `~/.local/share/opencode-railway-computer/free-vm/`. Railway maps a
  key to a box, so a project keeps its computer across runs.
- Upload: the tarball is piped over SSH stdin to `tar -x`.
- Run: `opencode run --format json --auto` over SSH, parsing its JSON event stream.
- Railway's welcome manifest (JSON on stderr) supplies the preview URL, the build deadline, and the claim link.
- A refusal (`{"status":"error"}` or "Anonymous trials are unavailable") raises `AnonymousUnavailable`, which
  triggers the OAuth handoff.

### Why not OpenCode's native workspaces?

OpenCode core has a `WorkspaceDriver` abstraction (`packages/core/src/workspace/driver.ts`): `create`, `connect`
(returning a process spawner), `suspendForIdle`, and `destroy`. When a session's location has a `workspaceID`, the
shell, read, edit, grep, and patch tools run in that workspace while the agent loop stays local. Railway Sandboxes
map onto it almost one to one.

Today it is only reachable from the embedded SDK (`OpenCode.create({ workspaceProviders })`), and `workspaceID` is
stripped from the public API (`Location.PublicRef`). A plugin can therefore neither register a driver nor place a
child session in a workspace. If OpenCode exposes `ctx.workspace.transform(...)` and lets the `subagent` tool target
a workspace, this plugin can become a ~150-line driver, and remote subagents would show up as native child sessions.
