import { createSignal, For, onCleanup, Show } from "solid-js"
import { Schema } from "effect"
import { Command, MenuItem, Panel, Plugin, Server, Store, Style, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { RailwaySandbox } from "./rpc"
import type { SandboxRecord } from "./state"

const definition = Plugin.define({
  stores: {
    // "active" hides finished, failed, stopped, and expired sandboxes.
    view: Store.global(Schema.Struct({ filter: Schema.Literals(["active", "all"]) }), { filter: "active" }),
  },
  i18n: {
    en: {
      title: "Railway Sandboxes",
      "command.toggle": "Show Railway Sandboxes",
      empty: "No Railway sandboxes yet. Ask the agent to run something on a Railway sandbox, for example a build with a preview.",
      "empty.active": "No sandboxes are running right now.",
      "filter.label": "Filter sandboxes",
      "filter.active": "Active",
      "filter.all": "All",
      refresh: "Refresh",
      open: "Open preview",
      copy: "Copy preview URL",
      copied: "Preview URL copied",
      stop: "Stop and destroy",
      watch: "Watch live",
      "watch.failed": "Could not open the live session",
      "watch.pending": "The sandbox's session is still starting. Try again in a few seconds.",
      stopped: "Stopped",
      left: "{{time}} left",
      expired: "shut down",
      patch: "patch ready",
      applied: "patch applied",
      private: "only from your IP until claimed",
      unreachable: "Could not reach the OpenCode server",
    },
  },
})

const css = `
.rs-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; font-size: 13px; line-height: 1.4; }
.rs-head { display: flex; align-items: center; justify-content: space-between; }
.rs-head h2 { font-size: 13px; font-weight: 600; margin: 0; flex: 1; }
.rs-tabs { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: rgba(127,127,127,0.12); }
.rs-tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 10px; border: 0;
  border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 12px; opacity: 0.7; cursor: pointer; }
.rs-tab:hover { opacity: 1; }
.rs-tab[aria-selected="true"] { opacity: 1; background: rgba(127,127,127,0.22); font-weight: 600; }
.rs-tab:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
.rs-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
.rs-count { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.rs-empty, .rs-muted { opacity: 0.65; }
.rs-row { border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.rs-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rs-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.rs-chip[data-status="running"], .rs-chip[data-status="previewing"] { color: #3fb950; }
.rs-chip[data-status="awaiting-sign-in"] { color: #d29922; }
.rs-chip[data-status="failed"] { color: #f85149; }
.rs-chip[data-status="finished"], .rs-chip[data-status="stopped"], .rs-chip[data-status="expired"] { opacity: 0.6; }
.rs-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; opacity: 0.75; }
.rs-detail { font-size: 12px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rs-preview { display: flex; align-items: center; gap: 4px; min-width: 0; }
.rs-preview a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; cursor: pointer; text-decoration: underline; }
`

const LIVE = new Set(["awaiting-sign-in", "running", "previewing"])
const FILTERS = ["active", "all"] as const

const remaining = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

interface RemoteServer {
  readonly task: string
  readonly description: string
  readonly url: string
  readonly password: string
  readonly sessionID: string
}

/** Running sandboxes, registered as servers in setup; the view asks for one to open its session. */
let openServer: (task: string) => Promise<{ key: string; sessionID: string } | undefined> = async () => undefined

function SandboxesView() {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const [sandboxes, setSandboxes] = createSignal<SandboxRecord[]>([])
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const rpc = () => ctx.client.rpc(RailwaySandbox)

  const load = async () => {
    try {
      const result = (await rpc().list({})) as { sandboxes: SandboxRecord[] }
      setSandboxes(result.sandboxes)
      setError(false)
    } catch {
      setError(true)
    }
  }

  void load()
  const tick = setInterval(() => setNow(Date.now()), 1000)
  // Events keep the list current; the slow poll catches sandboxes that expired while nobody was listening.
  const poll = setInterval(() => void load(), 15_000)
  const unsubscribe = rpc().events.on("updated", () => void load())
  onCleanup(() => {
    clearInterval(tick)
    clearInterval(poll)
    unsubscribe()
  })

  const stop = async (task: string) => {
    setBusy(task)
    try {
      const result = (await rpc().stop({ task })) as { stopped: boolean; message: string }
      ctx.toast.show({ title: result.stopped ? ctx.t("stopped") : result.message, variant: result.stopped ? "success" : "error" })
    } finally {
      setBusy(undefined)
      void load()
    }
  }

  // Opens the remote agent's session as a native Desktop tab, through the temporary server registered for the sandbox.
  // Outside Desktop (or if that fails) fall back to a single-use link in the browser.
  const watch = async (task: string) => {
    setBusy(`watch:${task}`)
    try {
      const server = await openServer(task)
      if (server) ctx.tabs.open({ server: server.key, id: server.sessionID }, { focus: true })
      else {
        const result = (await rpc().watch({ task })) as { url: string }
        ctx.system.openExternal(result.url)
      }
    } catch (error) {
      ctx.toast.show({ title: ctx.t("watch.failed"), description: error instanceof Error ? error.message : String(error), variant: "error" })
    } finally {
      setBusy(undefined)
    }
  }

  const status = (sandbox: SandboxRecord) =>
    LIVE.has(sandbox.status) && sandbox.expiresAt !== undefined && sandbox.expiresAt < now() ? "expired" : sandbox.status
  const active = () => sandboxes().filter((sandbox) => LIVE.has(status(sandbox)))
  const filter = () => ctx.stores.view.value.filter
  const shown = () => (filter() === "active" ? active() : sandboxes())

  return (
    <div class="rs-panel">
      <div class="rs-head">
        <h2>{ctx.t("title")}</h2>
        <ui.Tooltip value={ctx.t("refresh")}>
          <ui.IconButton icon="refresh" label={ctx.t("refresh")} onClick={() => void load()} />
        </ui.Tooltip>
      </div>
      <div
        class="rs-tabs"
        role="tablist"
        aria-label={ctx.t("filter.label")}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          const next = filter() === "active" ? "all" : "active"
          ctx.stores.view.set({ filter: next })
          ;(event.currentTarget.querySelector(`[data-filter="${next}"]`) as HTMLElement | null)?.focus()
        }}
      >
        <For each={FILTERS}>
          {(value) => (
            <button
              type="button"
              class="rs-tab"
              role="tab"
              data-filter={value}
              aria-selected={filter() === value}
              tabIndex={filter() === value ? 0 : -1}
              onClick={() => ctx.stores.view.set({ filter: value })}
            >
              {ctx.t(`filter.${value}`)}
              <span class="rs-count">{value === "active" ? active().length : sandboxes().length}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={error()}>
        <div class="rs-muted">{ctx.t("unreachable")}</div>
      </Show>
      <Show
        when={shown().length > 0}
        fallback={<div class="rs-empty">{sandboxes().length && filter() === "active" ? ctx.t("empty.active") : ctx.t("empty")}</div>}
      >
        <For each={shown()}>
          {(sandbox) => (
            <div class="rs-row" data-task={sandbox.task}>
              <div class="rs-top">
                <ui.Icon name={sandbox.backend === "free-vm" ? "outline-globe" : "server"} size="small" />
                <span class="rs-name" title={sandbox.description}>
                  {sandbox.description}
                </span>
                <span class="rs-chip" data-status={status(sandbox)}>
                  {status(sandbox)}
                </span>
              </div>
              <div class="rs-meta">
                <span>{sandbox.directory.split("/").filter(Boolean).at(-1)}</span>
                <span>{sandbox.backend === "free-vm" ? "anonymous" : sandbox.backend}</span>
                <span>started {ago(now() - sandbox.startedAt)}</span>
                <Show when={LIVE.has(status(sandbox)) && sandbox.expiresAt}>
                  {(expires) => <span>{ctx.t("left", { time: remaining(expires() - now()) })}</span>}
                </Show>
                <Show when={sandbox.patchFile}>
                  <span>{sandbox.applied ? ctx.t("applied") : ctx.t("patch")}</span>
                </Show>
                <Show when={sandbox.variables?.length}>
                  <span>env: {sandbox.variables!.join(", ")}</span>
                </Show>
              </div>
              <Show when={sandbox.detail}>
                <div class="rs-detail" title={sandbox.detail}>
                  {sandbox.detail}
                </div>
              </Show>
              <Show when={sandbox.previewURL && status(sandbox) === "previewing" ? sandbox.previewURL : undefined}>
                {(url) => (
                  <div class="rs-preview">
                    <a onClick={() => ctx.system.openExternal(url())} title={ctx.t("open")}>
                      {url().replace(/^https:\/\//, "")}
                    </a>
                    <ui.Tooltip value={ctx.t("copy")}>
                      <ui.IconButton
                        icon="copy"
                        label={ctx.t("copy")}
                        onClick={() => void ctx.system.copy(url()).then(() => ctx.toast.show({ title: ctx.t("copied") }))}
                      />
                    </ui.Tooltip>
                    <ui.Tooltip value={ctx.t("open")}>
                      <ui.IconButton icon="square-arrow-top-right" label={ctx.t("open")} onClick={() => ctx.system.openExternal(url())} />
                    </ui.Tooltip>
                  </div>
                )}
              </Show>
              <Show when={sandbox.previewURL && sandbox.shareable === false}>
                <div class="rs-muted">{ctx.t("private")}</div>
              </Show>
              <Show when={LIVE.has(status(sandbox)) && sandbox.backend === "sandbox"}>
                <div class="rs-buttons">
                  <Show when={status(sandbox) === "running"}>
                    <ui.Button variant="contrast" busy={busy() === `watch:${sandbox.task}`} onClick={() => void watch(sandbox.task)}>
                      {ctx.t("watch")}
                    </ui.Button>
                  </Show>
                  <ui.Button busy={busy() === sandbox.task} onClick={() => void stop(sandbox.task)}>
                    {ctx.t("stop")}
                  </ui.Button>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

export default Plugin.define({
  ...definition,
  setup(ctx) {
    const key = `${ctx.id}:main`

    // Each running sandbox becomes a temporary server in Desktop, so the remote agent's session opens in a native tab,
    // like a local session. Entries disappear when their task stops running.
    const [servers, setServers] = createSignal<RemoteServer[]>([])
    const [loaded, setLoaded] = createSignal(false)
    const refresh = async () => {
      try {
        const result = (await ctx.client.rpc(RailwaySandbox).servers({})) as { servers: RemoteServer[] }
        setServers(result.servers)
      } catch {
        // The OpenCode server is restarting; keep the last list until the next refresh.
      } finally {
        setLoaded(true)
      }
      return servers()
    }
    void refresh()
    const poll = setInterval(() => void refresh(), 15_000)
    const unsubscribe = ctx.client.rpc(RailwaySandbox).events.on("updated", () => void refresh())
    openServer = async (task) => {
      const found = servers().find((item) => item.task === task) ?? (await refresh()).find((item) => item.task === task)
      if (!found || !ctx.desktop) return undefined
      return { key: `${ctx.id}:${task}`, sessionID: found.sessionID }
    }
    ctx.add(
      Server,
      (): Server => ({
        ready: loaded(),
        entries: servers().map((item) => ({
          id: item.task,
          name: item.description,
          label: "Railway",
          state: "ready",
          http: { url: item.url, password: item.password },
          reconnect: async () => {
            const fresh = (await refresh()).find((entry) => entry.task === item.task)
            if (!fresh) throw new Error("The sandbox is no longer running.")
            return { url: fresh.url, password: fresh.password }
          },
        })),
      }),
    )

    const tab: PanelTab = {
      id: "main",
      get title() {
        return ctx.t("title")
      },
      closable: "compact",
      fallback: true,
    }

    ctx.add(Style, css)
    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: 380,
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: () => <SandboxesView />,
    })
    ctx.add(
      MenuItem,
      (): MenuItem => {
        const session = ctx.sessions.current()
        return {
          menu: "session.panel",
          id: "open",
          title: ctx.t("title"),
          icon: "server",
          keybind: `${ctx.id}.toggle`,
          opened: !!session && ctx.layout.state(key, session) !== "closed",
          run: () => {
            if (session) ctx.layout.open(key, session)
          },
        }
      },
    )
    ctx.add(
      Command,
      (): Command => ({
        id: "toggle",
        title: ctx.t("command.toggle"),
        keywords: "railway sandbox preview remote sandbox",
        enabled: !!ctx.sessions.current(),
        run: () => {
          const session = ctx.sessions.current()
          if (session) ctx.layout.toggle(key, session)
        },
      }),
    )

    return () => {
      clearInterval(poll)
      unsubscribe()
      openServer = async () => undefined
    }
  },
})
