# Use cases

Each of these is a prompt you can give your OpenCode agent once the plugin is installed. The agent decides when to
call `railway_sandbox`; mentioning "on a Railway sandbox" or "remotely" makes it explicit.

## Share your work

**1. Shareable preview of what you're building.**
"I'm working on the pricing page. Build it remotely and give me a preview URL I can send to design."
→ `preview: true`. Public HTTPS URL with a Railway account; with the anonymous tier, a claim link makes it shareable.

**2. Preview a branch for a PR review.**
"Spin up a preview of this branch and add the URL to the PR description."
→ Pair with the GitHub CLI locally; the preview lives for `previewMinutes`.

**3. Demo a prototype from a laptop that's about to close.**
"Put this prototype on a Railway sandbox so I can demo it from my phone in 20 minutes."
→ The preview's lifetime is enforced inside the VM, so it doesn't depend on your laptop staying awake.

## Offload heavy or slow work

**4. Run the full test suite without melting your laptop.**
"Run the entire test suite remotely and tell me what fails, with a patch for anything obvious."

**5. Clean-room builds.**
"Do a fresh install and production build on a clean machine. Does it work without my local caches?"
→ Catches undeclared dependencies, missing env defaults, and "works on my machine" issues.

**6. Dependency upgrades.**
"Upgrade React to the latest major on a Railway sandbox, fix what breaks, and give me the patch."
→ Installs and codemods happen remotely; you review one patch.

**7. Long-running jobs.**
"Profile the build on a Railway sandbox and report the slowest steps."
→ Background by default; your session stays usable.

## Parallelize

**8. Fan out independent tasks.**
"In parallel on Railway sandboxes: fix the flaky auth test, add pagination to /api/users, and write docs for the CLI."
→ One VM per task; each comes back as its own patch.

**9. Try several approaches and keep the best.**
"Try three different caching strategies for the search endpoint on separate Railway sandboxes and compare benchmarks."

**10. Multi-model bake-off.**
"Have one Railway sandbox solve this with GPT and another with Claude, then compare the patches."
→ Use the `model` input; credentials are forwarded per run.

## Isolate risk

**11. Run untrusted code.**
"Clone this repo from the issue and reproduce the bug on a Railway sandbox, not on my machine."

**12. Risky migrations and scripts.**
"Run the data migration against a copy on a Railway sandbox and show me the before/after."

**13. Agents with full permissions, safely.**
Remote agents run without approval prompts because the VM is disposable. Use this for exploratory refactors you would
not let an agent do unattended on your laptop.

## Use Railway infrastructure

**14. Test against real services.**
With a Railway account, sandboxes join the environment's private network, so a remote agent can reach
`postgres.railway.internal` and other services in the project. (Pass connection details in the prompt or bake them into
the sandbox `env`; see the roadmap.)

**15. Reproduce production issues.**
"Reproduce the 500 from the logs against staging's database on a Railway sandbox."

## Get unstuck

**16. Different OS or toolchain.**
"Does this build on Linux? Check on a Railway sandbox." Ubuntu, Node, Python, Docker, and Chromium/Playwright are
available.

**17. Headless browser tasks.**
"Take screenshots of every page in the app on a Railway sandbox and tell me which ones have layout bugs."

**18. Onboarding a new repo.**
"Set up this project from scratch on a Railway sandbox and write down every step that was needed."
→ The report becomes your setup guide; the patch adds any missing scripts.

## Roadmap ideas

- Checkpoint the prepared workspace (dependencies installed) per project and fork it for each task.
- Pass Railway variable references (for example `${{Postgres.DATABASE_URL}}`) into the sandbox `env`.
- Native child sessions once OpenCode exposes remote workspaces to plugins.
- A TUI/Desktop panel listing running sandboxes, previews, and their remaining time.
- `railway_sandbox_apply` to apply a task's patch with conflict reporting.
