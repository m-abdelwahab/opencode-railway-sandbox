export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface ForwardedCredential {
  readonly integrationID: string
  readonly value: Record<string, unknown>
}

export type Progress = (status: string, detail?: Record<string, unknown>) => void

/** What both backends need to run one remote task. */
export interface RunInput {
  readonly archive: Buffer
  readonly prompt: string
  readonly title: string
  readonly agent: string
  readonly model?: ModelRef
  readonly credentials: ReadonlyArray<ForwardedCredential>
  /** Build the app and leave it serving on $PORT, then return a preview URL. */
  readonly preview: boolean
  /** How long a preview stays up before the computer shuts itself down. */
  readonly previewMinutes: number
  readonly signal: AbortSignal
  readonly progress: Progress
}

export interface Preview {
  readonly url: string
  /** HTTP status of the preview when last checked, or the failure reason. */
  readonly check: string
  readonly shareable: boolean
  readonly note?: string
}

export interface RunResult {
  readonly backend: "sandbox" | "free-vm"
  /** Sandbox ID, or a description of the anonymous box. */
  readonly computer: string
  readonly outcome: string
  readonly text: string
  readonly patch: string
  readonly diffstat: string
  readonly preview?: Preview
  /** Extra lines for the report, such as a claim link or the remote session URL. */
  readonly notes: ReadonlyArray<string>
  /** Whether the computer is still running after the task. */
  readonly running: boolean
  readonly dispose: () => Promise<void>
}

/** The anonymous tier refused this run (capacity, daily limits, or the agent path being disabled). */
export class AnonymousUnavailable extends Error {
  constructor(
    message: string,
    readonly signupURL?: string,
  ) {
    super(message)
  }
}

export const PREVIEW_PORT = 8080
export const PREVIEW_COMMAND_FILE = "/root/.preview-command"

export const remoteInstructions = (input: Pick<RunInput, "prompt" | "preview">, previewURL?: string) =>
  [
    "You are a subagent running headless on a disposable Railway computer (a Linux VM), working on a copy of the user's project.",
    "Nobody can answer questions: make reasonable assumptions and finish the task autonomously.",
    "Your file changes are returned to the parent agent as a patch. End with a concise report of what you did and found.",
    ...(input.preview
      ? [
          "",
          `The user wants a live preview of the app. Install dependencies and build it so it runs here. The app must listen on 0.0.0.0 and the port in the PORT environment variable (${PREVIEW_PORT}).`,
          ...(previewURL
            ? [
                `It will be served publicly at ${previewURL}, which proxies to port ${PREVIEW_PORT} here. Dev and preview servers that check the Host header (for example Vite's allowedHosts) must accept that hostname.`,
                `Verify through the public URL, not only localhost: start the app in the background, check that \`curl -s -o /dev/null -w '%{http_code}' ${previewURL}\` returns 200, then stop it.`,
              ]
            : []),
          `When it works, write the single shell command that starts the app in the foreground from the project root (no trailing &, no nohup) to ${PREVIEW_COMMAND_FILE}.`,
          "Stop any server you started yourself before finishing; the preview is started for you from that file.",
        ]
      : []),
    "",
    input.prompt,
  ].join("\n")

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Shell-escapes a value for single-quoted interpolation. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Polls a preview URL until it answers with something other than a gateway error. */
export async function checkPreview(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = "no response"
  while (Date.now() < deadline) {
    const status = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then(
      (response) => response.status,
      (error: unknown) => String(error),
    )
    last = String(status)
    if (typeof status === "number" && status < 500) return `HTTP ${status}`
    await sleep(3000)
  }
  return `not answering yet (${last})`
}
