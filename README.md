# Railway Computer for OpenCode

Give your OpenCode agents a computer of their own. `opencode-railway-computer` adds a `railway_computer` tool that runs
a subagent on a fresh Railway VM instead of your laptop: it copies your project over, runs a headless OpenCode agent
there with full permissions, and hands back a report, a reviewable patch, and (optionally) a live preview URL.

```text
You: I'm working on the launch board. Add a "Preview URLs" item, run the build remotely,
     and give me a preview URL I can share.

Agent: [edits src/main.js] → railway_computer(preview: true)
       ... Railway sandbox: npm install, vite build, vite preview ...
       Preview URL: https://opencode-remote-agents-8080-….up.railway.app (HTTP 200, shareable)
```

> **Status:** early prototype. Tested end to end with OpenCode 2.3.0 and Railway Sandboxes (see [Testing](#testing)).

## How it works

```text
OpenCode (your machine)                         Railway
┌──────────────────────────┐                    ┌───────────────────────────────────┐
│ parent agent             │  railway_computer  │ VM (Sandbox or free railway.new)   │
│  └─ railway-computer ────┼──── tarball ──────►│  /root/workspace (baseline commit) │
│     plugin               │                    │  opencode serve / opencode run     │
│                          │◄─── report+patch ──┤  headless agent, all permissions   │
│  <railway_computer> msg  │◄─── preview URL ───┤  app on $PORT=8080 → public HTTPS  │
└──────────────────────────┘                    └───────────────────────────────────┘
```

1. **Pack.** Git-tracked and untracked-but-not-ignored files (exactly what your local agent sees, minus `.git` and
   ignored output such as `node_modules`). Non-git directories are tarred without `node_modules`/`.git`.
2. **Pick a computer** (see [Tiers](#tiers)).
3. **Run.** The remote OpenCode starts from a baseline commit, so its changes come back as an exact `git diff`.
   It runs without approval prompts (the VM is disposable) and the `question` tool is denied (nobody is attached).
4. **Report.** By default the tool returns immediately and the result arrives later as a `<railway_computer>` message,
   like OpenCode's built-in subagents. The patch is saved to `$TMPDIR/opencode-railway-computer/<task>.patch` and is
   **never applied automatically**.
5. **Preview** (`preview: true`). The remote agent is told the public URL, makes the app serve on `0.0.0.0:$PORT`
   (8080), verifies it through the public URL, and writes its start command. The plugin then swaps the agent server
   for the app and checks the URL answers.

## Tiers

| | Anonymous | Railway account |
|---|---|---|
| Backend | `ssh railway.new` free VM | [Railway Sandboxes](https://docs.railway.com/sandboxes) |
| Needs | nothing (an SSH key is generated per project) | Sign in with Railway, project token, or `RAILWAY_TOKEN` |
| Size | 2 vCPU / 2 GB | plan default (Hobby 4/4, Pro 8/8, up to 32/32) |
| Limits | 60 min build window, 3 boxes per IP per day | per-environment sandbox caps |
| Preview URL | only from your IP until you claim the box | public HTTPS, shareable |
| Model | box's included AI budget, or your forwarded login | your forwarded login, or OpenCode's free default |

Selection order:

1. A connected Railway account always wins (bigger machines, shareable previews).
2. Otherwise the plugin tries an **anonymous** computer.
3. If Railway refuses the anonymous box (capacity, daily limit), the plugin starts **Sign in with Railway**, returns the
   link for the agent to relay, and starts the task automatically once you approve.

## Install

```jsonc
// opencode.jsonc (project) or ~/.config/opencode/opencode.jsonc (global)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-railway-computer",
      "options": {
        // Optional; see Options below.
        "project": "my-railway-project",
      },
    },
  ],
}
```

During development, point `package` at a local checkout (`"/path/to/opencode-railway-computer"`). OpenCode reloads
plugins when config files change.

## Connect Railway

Any one of these works; OpenCode stores credentials in its own credential store.

- **Sign in with Railway** (recommended): `/connect` → Railway → Sign in with Railway. Uses OAuth 2.0 + PKCE with a
  public client (no secret). On the consent screen, pick the project(s) OpenCode may create sandboxes in.
  Requested scopes: `openid email profile offline_access project:member`.
- **Project token**: `/connect` → Railway → Railway project token. Scoped to one project and environment.
- **Environment**: set `RAILWAY_TOKEN` (project token) or `RAILWAY_API_TOKEN` + `RAILWAY_ENVIRONMENT_ID` for the
  OpenCode server process.

If nothing is connected and the anonymous tier is unavailable, the agent will tell you and hand you a sign-in link.

## Tools

### `railway_computer`

| Input | Description |
|---|---|
| `description` | 3–5 word label |
| `prompt` | Self-contained instructions; the remote agent cannot see your conversation |
| `preview` | Build the app and serve it on a preview URL |
| `agent` | Remote agent (default `build`) |
| `model` | `provider/model#variant`, only when you ask for a specific model |
| `wait` | Block until finished instead of running in the background |

### `railway_computer_stop`

Destroys a sandbox early (for example, to take a preview down). Takes the `computer` ID from the report.

## Options

| Option | Default | Description |
|---|---|---|
| `project` | — | Railway project (name or ID) when your credential can see several |
| `environment` | `production` | Environment name or ID |
| `environmentId` | — | Skip discovery entirely |
| `model` | parent session's model | Default remote model |
| `agent` | `build` | Default remote agent |
| `anonymous` | `true` | Try a free `railway.new` computer when no account is connected |
| `previewMinutes` | `60` | How long a preview stays up before the VM shuts itself down |
| `maxMinutes` | `120` | Hard cap on a sandbox task, enforced inside the VM |
| `idleTimeoutMinutes` | `30` | Railway sandbox idle timeout |
| `keepSandbox` | `false` | Keep non-preview sandboxes running after the task |
| `matchVersion` | `false` | Upgrade the sandbox's OpenCode to your local version first |
| `oauthClientId` | built-in | Override the Railway OAuth client |
| `oauthPort` | `19876` | Loopback port registered as `http://127.0.0.1:<port>/callback` |

## Credentials and security

- **Model credentials.** The remote agent uses the same provider as your session when that login can travel: API keys
  are forwarded as-is; OAuth logins are forwarded as a short-lived **access token only** (the refresh token never
  leaves your machine, so the VM cannot rotate your login). Machine-bound logins such as Claude Agent cannot be
  forwarded; the remote agent then uses OpenCode's default model, and the report says so.
- **Forwarded credentials live only inside that VM**, which is destroyed after non-preview tasks.
- **Remote server.** The sandbox's OpenCode server is published on a Railway HTTPS domain protected by a random
  per-task password, and is stopped before a preview starts.
- **Lifetimes are enforced inside the VM** with `timeout`, so a task or preview cannot outlive its cap even if your
  laptop sleeps or OpenCode restarts; Railway's idle timeout then reclaims the sandbox.
- **Your code is copied to Railway.** Ignored files (for example `.env` when it is in `.gitignore`) are not uploaded.
  Untracked files that are not ignored are.

## Limitations

- Changes come back as a patch to review; they are not merged automatically.
- The remote copy has a fresh one-commit history, not your git history.
- Background tasks are not resumed if the OpenCode server restarts mid-task (the VM shuts itself down via its caps).
- The anonymous tier is driven over SSH by parsing Railway's welcome manifest; its format is not a stable API.
- OpenCode V2 does not yet let plugins place a child session on a remote workspace, so the remote run is not shown as
  a native child session. See [docs/architecture.md](docs/architecture.md).

## Testing

See [docs/testing.md](docs/testing.md) for the end-to-end checklist and the results of the last run.

## License

MIT
