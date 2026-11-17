# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/m-abdelwahab/opencode-railway-sandbox/security/advisories/new)
rather than in a public issue. Include steps to reproduce and the plugin and OpenCode versions. You should hear back
within a few days.

## What leaves your machine

Running a `railway_sandbox` task sends data to Railway. Know what that is before you use it.

| Data | Where it goes | Notes |
|---|---|---|
| **Your project files** | The Railway VM running the task | Git-tracked and untracked files that are **not** ignored (outside a git repo: everything except `node_modules`, `.git`, `.DS_Store`). Files that look like secrets are **withheld even when not ignored**: `.env`, `.env.*` (except `.env.example` and similar templates), `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH keys, `.netrc`, `.git-credentials`, `*.tfstate`, `credentials.json`, `.aws/*`, `.ssh/*`, and more. The report lists what was withheld; `uploadInclude`/`uploadExclude` adjust the list. |
| **Model credentials** | The remote OpenCode inside that VM | The provider of the remote model only. API keys are forwarded as-is. OAuth logins are forwarded as an **access token only**; the refresh token never leaves your machine. Machine-bound logins (such as Claude Agent) are never forwarded. |
| **Railway variable references** | Railway, resolved inside the VM | You pass references such as `${{Postgres.DATABASE_URL}}`; values are resolved by Railway and never pass through your machine or the conversation. `railway_sandbox_variables` returns variable **names** only. |
| **Your prompt** | The remote OpenCode and its model provider | Same as any OpenCode session. |
| **Anonymous tier** | `ssh railway.new` | A per-project SSH key generated in `~/.local/share/opencode-railway-sandbox/free-vm/`. Railway identifies the box by that key. |

## Upload guard

Before anything is packed, the plugin refuses the filesystem root, your home folder, any folder that contains your
home folder, and folders with more than 20,000 files to upload; archives over 200 MB are refused too. The agent is told
to move the session to the project's folder instead.

## How the remote side is protected

- **Remote agents run without approval prompts.** The VM is disposable, so the remote OpenCode allows every tool
  except `question`. Treat anything you send to a Railway sandbox as runnable by an autonomous agent with full access
  to that VM, its network, and any variables you injected.
- **Isolated by default.** Sandboxes do not join the project's private network and have no public URL unless the task
  uses `variables`, `preview`, or `live`. The remote OpenCode then listens on `127.0.0.1` inside the VM and is reached
  only through Railway's authenticated exec channel.
- **When a task does join the private network**, the remote agent can reach that environment's services. Use a dedicated
  project or environment if that is too broad. The remote OpenCode is then published on a Railway HTTPS domain,
  protected by a random per-task password, and stopped before a preview starts.
- **Lifetimes are enforced inside the VM** (`timeout`), so a task or preview cannot outlive its cap even if your machine
  goes away. Railway's idle timeout then reclaims the sandbox.
- **Desktop connects to running sandboxes directly.** To open remote sessions as native tabs, the plugin hands each running
  sandbox's address and password to OpenCode Desktop through your local OpenCode server, which only you can reach
  (it is password-protected and already has full access to your machine).
- **Previews are public URLs** on sandbox tasks. Anonymous-tier previews answer only your IP until the box is claimed.

## Local side

- **Patches are validated before they are applied.** Absolute paths, `..` segments, anything under `.git/`, symbolic
  links, and writes through a symlinked directory that leaves the project are refused, so a compromised remote agent
  cannot plant files outside your project or in git hooks.
- **Changes are never applied automatically.** Patches are written to `$TMPDIR/opencode-railway-sandbox/` and applied
  only through `railway_sandbox_apply`, which asks for OpenCode's `edit` permission on the affected files.
- **Railway credentials** are stored in OpenCode's credential store. Sign in with Railway uses OAuth 2.0 with PKCE and a
  public client (no client secret); the loopback callback listens on `127.0.0.1` only and checks `state`.
- **Resumable task handles** (in OpenCode's plugin storage) include each running task's remote server password, so a
  reloaded plugin can resume the task. They are deleted when the task finishes.
