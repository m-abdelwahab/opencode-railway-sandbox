import { createSignal, For, onCleanup, Show } from "solid-js"
import { Schema } from "effect"
import { Command, MenuItem, Panel, Plugin, Store, Style, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { RailwayComputer } from "./rpc"
import type { ComputerRecord } from "./state"

const definition = Plugin.define({
  stores: {
    // "active" hides finished, failed, stopped, and expired computers.
    view: Store.global(Schema.Struct({ filter: Schema.Literals(["active", "all"]) }), { filter: "active" }),
  },
  i18n: {
    en: {
      title: "Railway computers",
      "command.toggle": "Show Railway computers",
      empty: "No Railway computers yet. Ask the agent to run something on a Railway computer, for example a build with a preview.",
      "empty.active": "Nothing is running on Railway computers right now.",
      "filter.label": "Show",
      "filter.active": "Active ({{count}})",
      "filter.all": "All ({{count}})",
      refresh: "Refresh",
      open: "Open preview",
      copy: "Copy preview URL",
      copied: "Preview URL copied",
      stop: "Stop and destroy",
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
.rc-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; font-size: 13px; line-height: 1.4; }
.rc-head { display: flex; align-items: center; justify-content: space-between; }
.rc-head h2 { font-size: 13px; font-weight: 600; margin: 0; flex: 1; }
.rc-actions { display: flex; align-items: center; gap: 4px; }
.rc-empty, .rc-muted { opacity: 0.65; }
.rc-row { border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.rc-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rc-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.rc-chip[data-status="running"], .rc-chip[data-status="previewing"] { color: #3fb950; }
.rc-chip[data-status="awaiting-sign-in"] { color: #d29922; }
.rc-chip[data-status="failed"] { color: #f85149; }
.rc-chip[data-status="finished"], .rc-chip[data-status="stopped"], .rc-chip[data-status="expired"] { opacity: 0.6; }
.rc-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; opacity: 0.75; }
.rc-detail { font-size: 12px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rc-preview { display: flex; align-items: center; gap: 4px; min-width: 0; }
.rc-preview a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; cursor: pointer; text-decoration: underline; }
`

const LIVE = new Set(["awaiting-sign-in", "running", "previewing"])

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

function ComputersView() {
  const ctx = usePlugin<typeof definition>()
  const ui = ctx.ui
  const [computers, setComputers] = createSignal<ComputerRecord[]>([])
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const rpc = () => ctx.client.rpc(RailwayComputer)

  const load = async () => {
    try {
      const result = (await rpc().list({})) as { computers: ComputerRecord[] }
      setComputers(result.computers)
      setError(false)
    } catch {
      setError(true)
    }
  }

  void load()
  const tick = setInterval(() => setNow(Date.now()), 1000)
  // Events keep the list current; the slow poll catches computers that expired while nobody was listening.
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

  const status = (computer: ComputerRecord) =>
    LIVE.has(computer.status) && computer.expiresAt !== undefined && computer.expiresAt < now() ? "expired" : computer.status
  const active = () => computers().filter((computer) => LIVE.has(status(computer)))
  const filter = () => ctx.stores.view.value.filter
  const shown = () => (filter() === "active" ? active() : computers())

  return (
    <div class="rc-panel">
      <div class="rc-head">
        <h2>{ctx.t("title")}</h2>
        <div class="rc-actions">
          <ui.Select
            label={ctx.t("filter.label")}
            options={[
              { value: "active", label: ctx.t("filter.active", { count: active().length }) },
              { value: "all", label: ctx.t("filter.all", { count: computers().length }) },
            ]}
            value={filter()}
            onChange={(value) => ctx.stores.view.set({ filter: value })}
          />
          <ui.Tooltip value={ctx.t("refresh")}>
            <ui.IconButton icon="refresh" label={ctx.t("refresh")} onClick={() => void load()} />
          </ui.Tooltip>
        </div>
      </div>
      <Show when={error()}>
        <div class="rc-muted">{ctx.t("unreachable")}</div>
      </Show>
      <Show
        when={shown().length > 0}
        fallback={<div class="rc-empty">{computers().length && filter() === "active" ? ctx.t("empty.active") : ctx.t("empty")}</div>}
      >
        <For each={shown()}>
          {(computer) => (
            <div class="rc-row" data-task={computer.task}>
              <div class="rc-top">
                <ui.Icon name={computer.backend === "free-vm" ? "outline-globe" : "server"} size="small" />
                <span class="rc-name" title={computer.description}>
                  {computer.description}
                </span>
                <span class="rc-chip" data-status={status(computer)}>
                  {status(computer)}
                </span>
              </div>
              <div class="rc-meta">
                <span>{computer.directory.split("/").filter(Boolean).at(-1)}</span>
                <span>{computer.backend === "free-vm" ? "anonymous" : computer.backend}</span>
                <span>started {ago(now() - computer.startedAt)}</span>
                <Show when={LIVE.has(status(computer)) && computer.expiresAt}>
                  {(expires) => <span>{ctx.t("left", { time: remaining(expires() - now()) })}</span>}
                </Show>
                <Show when={computer.patchFile}>
                  <span>{computer.applied ? ctx.t("applied") : ctx.t("patch")}</span>
                </Show>
                <Show when={computer.variables?.length}>
                  <span>env: {computer.variables!.join(", ")}</span>
                </Show>
              </div>
              <Show when={computer.detail}>
                <div class="rc-detail" title={computer.detail}>
                  {computer.detail}
                </div>
              </Show>
              <Show when={computer.previewURL && status(computer) === "previewing" ? computer.previewURL : undefined}>
                {(url) => (
                  <div class="rc-preview">
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
              <Show when={computer.previewURL && computer.shareable === false}>
                <div class="rc-muted">{ctx.t("private")}</div>
              </Show>
              <Show when={LIVE.has(status(computer)) && computer.backend === "sandbox"}>
                <div>
                  <ui.Button busy={busy() === computer.task} onClick={() => void stop(computer.task)}>
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
      render: () => <ComputersView />,
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
        keywords: "railway sandbox preview remote computer",
        enabled: !!ctx.sessions.current(),
        run: () => {
          const session = ctx.sessions.current()
          if (session) ctx.layout.toggle(key, session)
        },
      }),
    )
  },
})
