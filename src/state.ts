import type { Plugin } from "@opencode/plugin"

/** A task's computer as the panel shows it. Stored in plugin storage, which every location's instance shares. */
export interface ComputerRecord {
  readonly task: string
  readonly description: string
  readonly backend: "sandbox" | "free-vm" | "pending"
  /** Sandbox ID, or a description of the anonymous box. */
  readonly computer?: string
  readonly status: "awaiting-sign-in" | "running" | "previewing" | "finished" | "failed" | "stopped" | "expired"
  /** Latest progress line or error. */
  readonly detail?: string
  readonly directory: string
  readonly sessionID: string
  readonly startedAt: number
  readonly updatedAt: number
  /** When the computer shuts itself down: the preview's end, or the task's runtime cap. */
  readonly expiresAt?: number
  readonly previewURL?: string
  readonly shareable?: boolean
  readonly patchFile?: string
  readonly applied?: boolean
  /** Names of the environment variables injected into the computer. */
  readonly variables?: readonly string[]
}

type Context = Plugin.Context

const PREFIX = "computer/"
/** Finished records stay listed for a day so their patches can still be applied from the report. */
const RETAIN_MS = 24 * 60 * 60_000
const LIVE = new Set<ComputerRecord["status"]>(["awaiting-sign-in", "running", "previewing"])

export const isLive = (record: ComputerRecord) => LIVE.has(record.status)

export function createRegistry(ctx: Context, emit: (task: string) => Promise<void>) {
  const get = async (task: string) => (await ctx.storage.get(PREFIX + task)) as ComputerRecord | undefined

  const put = async (record: ComputerRecord) => {
    await ctx.storage.set(PREFIX + record.task, record as never)
    await emit(record.task).catch(() => {})
    return record
  }

  // Updates are read-modify-write, and progress lines are fired without awaiting; chaining them per task keeps a late
  // progress line from overwriting the final state.
  const queues = new Map<string, Promise<unknown>>()
  // Progress arrives every few seconds; only persist when the visible line changes.
  const update = (task: string, patch: Partial<Omit<ComputerRecord, "task">>) => {
    const next = (queues.get(task) ?? Promise.resolve()).then(
      async () => {
        const current = await get(task)
        if (!current) return undefined
        // Progress lines (detail only) apply while the task works; once it settles or previews they are stale.
        if (current.status !== "running" && current.status !== "awaiting-sign-in" && Object.keys(patch).every((key) => key === "detail"))
          return current
        if (Object.entries(patch).every(([key, value]) => current[key as keyof ComputerRecord] === value)) return current
        return put({ ...current, ...patch, updatedAt: Date.now() })
      },
    )
    const settled = next.catch(() => undefined)
    queues.set(task, settled)
    void settled.then(() => {
      if (queues.get(task) === settled) queues.delete(task)
    })
    return next
  }

  const list = async () => {
    const records: ComputerRecord[] = []
    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix: PREFIX, after, limit: 100 })
      records.push(...page.entries.map((entry: { value: unknown }) => entry.value as ComputerRecord))
      after = page.next
    } while (after)
    const now = Date.now()
    const kept: ComputerRecord[] = []
    for (const record of records) {
      if (!isLive(record) && now - record.updatedAt > RETAIN_MS) {
        await ctx.storage.remove(PREFIX + record.task)
        continue
      }
      // A computer past its cap has shut itself down even if no instance was around to see it.
      kept.push(isLive(record) && record.expiresAt !== undefined && record.expiresAt < now ? { ...record, status: "expired" } : record)
    }
    return kept.toSorted((a, b) => b.startedAt - a.startedAt)
  }

  return { get, put, update, list }
}

export type Registry = ReturnType<typeof createRegistry>
