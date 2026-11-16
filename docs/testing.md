# Testing

## Unit tests

```bash
bun install
bun test        # anonymous-tier refusal parsing, workspace packing
bunx tsc -p .   # typecheck
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
   { "plugins": [{ "package": "/path/to/opencode-railway-computer", "options": { "project": "my-project" } }] }
   ```

2. Check that the plugin loaded and the integration registered:

   ```bash
   opencode api get '/api/plugin?location[directory]=/tmp/e2e/app'       # railway-computer: active
   opencode api get '/api/integration?location[directory]=/tmp/e2e/app'  # "Railway" with oauth, key, env
   ```

3. Drive the scenario with `opencode run` from the project directory:

   ```bash
   opencode run --format json "I'm working on X. Run the build remotely and give me a preview URL I can share. Use the Railway Computer plugin."
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
| 5 | Signed-in scenario: agent edits code locally, calls `railway_computer(preview: true)` in the background; the report arrives about 83s later and wakes the parent agent | ✅ |
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
