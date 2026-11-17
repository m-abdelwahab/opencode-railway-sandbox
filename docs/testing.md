# Testing

## Unit tests

```bash
bun install
bun test        # anonymous-tier refusal parsing, workspace packing
bunx tsc -p .   # typecheck
```

## Subagent fan-out end to end (`scripts/e2e-subagents.ts`)

A local OpenCode session on a weaker model (`openai/gpt-5.6-luna` by default) fixes three broken modules in parallel on
three Railway sandboxes, checks in on them, gets asked "How are my sandboxes doing?" mid-run, applies every patch, and
runs the tests. The script checks the plugin's task list, Railway's own sandbox list (mid-run), the session's tool calls
and reports, and the fixture's final test run. Needs a running OpenCode with the plugin and Railway connected:

```bash
RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... bun scripts/e2e-subagents.ts [--model provider/model] [--server url]
```

## Standalone sandbox run (no OpenCode)

Exercises `src/sandbox.ts` directly against a Railway environment:

```bash
RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... \
  bun scripts/run-remote.ts /path/to/project "Run the tests and fix any failures."

# With a preview; KEEP=1 leaves the sandbox running so you can open the URL
KEEP=1 RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... \
  bun scripts/run-remote.ts /path/to/app "Build it and make sure it serves." --preview
```

## End-to-end in OpenCode

1. Put a config that loads the plugin in an **ancestor** directory of a test project, so the config itself is not
   packed and uploaded:

   ```jsonc
   // /tmp/e2e/opencode.jsonc
   { "plugins": [{ "package": "/path/to/opencode-railway-sandbox", "options": { "project": "my-project" } }] }
   ```

2. Check that the plugin loaded and the integration registered:

   ```bash
   opencode api get '/api/plugin?location[directory]=/tmp/e2e/app'       # railway-sandbox: active
   opencode api get '/api/integration?location[directory]=/tmp/e2e/app'  # "Railway" with oauth, key, env
   ```

3. Drive the scenario with `opencode run` from the project directory:

   ```bash
   opencode run --format json "I'm working on X. Run the build remotely and give me a preview URL I can share. Use the Railway Sandbox plugin."
   ```

4. Background results arrive as a synthetic message. Read them with
   `opencode api get /api/session/<id>/message`.

## Results of the last run (2026-11-16, OpenCode 2.3.0, sandbox image OpenCode 2.0.29)

| # | Scenario | Result |
|---|---|---|
| 1 | Plugin loads from a local path; integration "Railway" lists OAuth, project token, and env methods | ✅ |
| 2 | No account connected and anonymous tier capped ("The agent path is temporarily unavailable") → tool starts Railway OAuth and the agent relays the sign-in link | ✅ |
| 3 | Sign in with Railway (public client + PKCE, loopback `127.0.0.1:19876`) stores a credential labelled with the account email | ✅ |
| 4 | OAuth token with `project:member` resolves the shared project/environment via `externalWorkspaces` | ✅ (after fix: `me.workspaces` is not authorized for project-scoped tokens) |
| 5 | Signed-in scenario: agent edits code locally, calls `railway_sandbox(preview: true)` in the background; the report arrives about 83s later and wakes the parent agent | ✅ |
| 6 | Remote agent installs, builds, sets Vite `allowedHosts`, verifies via the public URL; plugin swaps the server for the app | ✅ HTTP 200, rendered in a real browser with the new item |
| 7 | Returned patch applies cleanly to the local checkout (`git apply --check`) | ✅ |
| 8 | Standalone: test-fix task (sandbox ready in 2.7s, OpenCode serving in ~10s, done in 31s) | ✅ |
| 9 | Anonymous happy path (`ssh railway.new` with a manifest) | ⚠️ Not exercised: anonymous trials were capacity-capped during testing. Refusal parsing is covered by unit tests using the captured responses |
| 10 | Preview self-shutdown after `previewMinutes` (in-VM `timeout`, exit 124) | ✅ observed for the preview process; sandbox reclamation then depends on Railway's idle timeout |

### Bugs found and fixed during E2E

- Completion detection assumed `time.busy`, which OpenCode 2.0.29 doesn't report. It now uses `outcome` + `time.idle`
  and absence from `/api/session/active`.
- Remote message lists are newest-first; results are now sorted chronologically.
- Multi-line setup scripts were mangled by double-quote escaping; scripts are now single-quote escaped.
- Vite's preview rejected the public host (HTTP 403). The remote agent is now told the public URL and must verify
  through it.
- A reattached exec handle neither killed the server nor released its WebSocket; the server is now stopped with
  `pkill`.
- A second OAuth attempt failed with `EADDRINUSE` while the first was pending; new attempts now supersede pending ones
  and plugin unload closes the listener.

## Results of the second run (2026-11-17): apply, variables, Desktop panel, resilience

| # | Scenario | Result |
|---|---|---|
| 11 | `railway_sandbox_variables` lists the project's services and variable names (no values) with an OAuth token | ✅ Postgres: DATABASE_URL, PGHOST, … |
| 12 | Agent passes `{"DATABASE_URL": "${{Postgres.DATABASE_URL}}"}`; the remote agent reaches the private Postgres, creates a table, inserts rows, prints `count: 3` | ✅ |
| 13 | `railway_sandbox_apply` check + apply; an unrelated uncommitted local edit is preserved | ✅ |
| 14 | Unit: clean apply, check-only, three-way merge keeping nearby local edits (index untouched), real conflict markers, `.rej` outside git | ✅ 10 tests |
| 15 | Forced plugin reload mid-task: new instance logs "Resumed after a plugin reload", finishes, and exactly one report is delivered | ✅ |
| 16 | OpenAI OAuth login forwarded as an access token; the remote run succeeds on `openai/gpt-6.1-terra-fast` | ✅ |
| 17 | Public sandbox URL unreachable: requests fall back to `curl` in the VM over the exec channel (GET, POST with body, HTTP errors preserved) | ✅ (forced with an invalid URL) |
| 18 | Desktop panel: rows, countdown, preview links, Stop and destroy | ✅ verified by hand in OpenCode Desktop 2.3.0 |
| 19 | Panel Active/All filter | ✅ verified by hand; switched to tabs with counts and renamed the panel "Railway Sandboxes" on feedback |
| 20 | Free default model when no forwardable login: quota exhaustion is reported with a hint | ✅ (quota was exhausted during testing) |

### Bugs found and fixed in this round

- A plugin reload (OpenCode also watches a local plugin's **source**) aborted running tasks and destroyed their
  sandboxes. Tasks now detach and resume.
- After a resume, the old instance raced the new one and marked a live preview `stopped`. Detached tasks with a stored
  handle now never report from the old instance.
- A single timed-out poll through the public domain failed a whole task. Requests now fall back to the exec channel,
  and polling tolerates 3 minutes without contact.
- Late progress writes overwrote a task's final state. Registry writes are serialized per task, and progress lines are
  ignored once a task settles.
- `git apply --3way` refuses files with uncommitted changes ("does not match index"), which is the normal case here. The
  merge now uses `git merge-file` per file against the saved preimage.
- The sandbox ID was recorded only at the end, so a running task could not be stopped from the panel. It is now recorded
  as soon as the sandbox exists.

## Results of the third run (2026-11-17): live status, steering, watch links, multiple processes

Run against an isolated `opencode serve` (`XDG_CONFIG_HOME` pointing at a config that loads the local checkout), sharing
the machine's credentials.

| # | Scenario | Result |
|---|---|---|
| 21 | "How's the sandbox doing? Give me a link to watch it live." → `railway_sandbox_status(watch: true)` mid-run: todo checklist, recent tool calls (including `sleep 90` still running), changed files, time left | ✅ |
| 22 | Watch link: single-use pairing code from the sandbox's OpenCode 2.0.29; redeems with 302 + session cookie, web UI loads, second use 401 | ✅ (probe) |
| 23 | "Tell it to also add a Testing section to the README" → `railway_sandbox_message` (steer) mid-run; the final patch includes `README.md` | ✅ |
| 24 | Two OpenCode processes on one database: B leaves A's task alone while A's lease is fresh; A is killed mid-task; B takes over after the lease lapses and delivers exactly one report with the right patch | ✅ |

### Bug found and fixed

- A report was delivered twice: a second OpenCode process (the machine's regular service, which shares the database)
  resumed a task another process was still following. Fixed with a cross-process lease and an idempotent delivery marker.

## Results of the fourth run (2026-11-17): folder guard and discoverability

| # | Scenario | Result |
|---|---|---|
| 25 | Session in `~`: `railway_sandbox` refuses before packing ("The session's folder is the home folder … nothing was uploaded"); the agent moves the session to a project folder and retries | ✅ |
| 26 | Unit: refuses `/`, the home folder, and ancestors of home; refuses >20,000 files outside git; counts only what git would upload in a repo | ✅ 4 tests |
| 27 | With the Railway MCP installed and the plugin not named in the prompt, the agent finds and calls `railway_sandbox` directly | ✅ |
| 28 | Non-git folder from macOS: extraction no longer keeps the local uid, so git in the sandbox accepts the tree | ✅ (was failing with "dubious ownership") |
| 29 | Desktop: a running sandbox registers as a temporary "Railway" server; Watch live opens the remote session as a native tab | ✅ verified by hand in OpenCode Desktop 2.3.0 against a sandbox running OpenCode 2.0.29 |
| 30 | The `servers` RPC returns every running sandbox's address, password and session; each remote server answers `/api/info` and the session | ✅ |

## Results of the fifth run (2026-11-17): weak-model fan-out (`scripts/e2e-subagents.ts`, `openai/gpt-5.6-luna`)

All 12 checks pass: three `railway_sandbox` calls on three distinct sandboxes, all RUNNING in Railway's own list mid-run;
live check-ins with remote progress, including a fresh one for the user's mid-run question; exactly one report per task;
three clean applies; the fixture's tests pass locally.

Findings fixed along the way:

- **The weak model polled.** After each report it kept calling `railway_sandbox_status` (10 calls in 90s) instead of
  ending its turn. Repeat checks within 30s with no new user message now get a one-line nudge instead of the full status,
  and every status reply ends with a reminder that reports arrive on their own. Next run: 4 full replies, 1 nudge.
- **Harness:** `opencode run` takes its directory from `$PWD`, not the process cwd; the script sets both, and aborts
  (interrupting the session and stopping its tasks) if a task ever records a folder other than the fixture.

## Results of the sixth run (2026-11-17): secure by default

| # | Scenario | Result |
|---|---|---|
| 31 | Weak-model fan-out (`scripts/e2e-subagents.ts`, 14 checks): every sandbox `ISOLATED` with no domains per Railway; status, messages, and reports over the exec channel; untracked `.env.local` withheld and reported | ✅ all 14 |
| 32 | `live: true` task: `PRIVATE` with the server published on 4096, offered to Desktop as a server; a default task alongside it stays `ISOLATED`, is not offered, and its panel Activity shows live progress | ✅ |
| 33 | Railway rejects a public domain on an isolated sandbox ("Public domains require PRIVATE network isolation"), so isolated sandboxes have no URL at all | ✅ (probe) |
| 34 | Unit: patches with `../`, `.git/` (any case), symlinks, or writes through a symlinked directory leaving the project are refused before git runs; ordinary patches still apply | ✅ 5 tests |
| 35 | Unit: secret patterns withheld in git and non-git folders, templates kept, `uploadInclude`/`uploadExclude` honored | ✅ 2 tests |
