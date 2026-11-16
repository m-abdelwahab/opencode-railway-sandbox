import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"

const ISSUER = "https://backboard.railway.com"
export const AUTHORIZE_URL = `${ISSUER}/oauth/auth`
export const TOKEN_URL = `${ISSUER}/oauth/token`
const USERINFO_URL = `${ISSUER}/oauth/me`
// project:member lets the user pick which projects OpenCode may create sandboxes in on the consent screen.
export const SCOPES = ["openid", "email", "profile", "offline_access", "project:member"]

export interface OAuthConfig {
  readonly clientID: string
  readonly port: number
}

export interface OAuthCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly metadata?: Record<string, unknown>
}

const base64url = (buffer: Buffer) => buffer.toString("base64url")

export const redirectURI = (config: OAuthConfig) => `http://127.0.0.1:${config.port}/callback`

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
  readonly error_description?: string
}

async function token(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  })
  const json = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || !json.access_token)
    throw new Error(`Railway token request failed (${response.status}): ${json.error_description ?? json.error ?? "no access token"}`)
  return json
}

const credential = (methodID: string, json: TokenResponse, previousRefresh = "", metadata?: Record<string, unknown>) =>
  ({
    type: "oauth",
    methodID,
    access: json.access_token,
    refresh: json.refresh_token ?? previousRefresh,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    ...(metadata ? { metadata } : {}),
  }) satisfies OAuthCredential

async function userinfo(access: string) {
  const response = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${access}` } })
  if (!response.ok) return undefined
  return (await response.json()) as { sub?: string; email?: string; name?: string }
}

/** The pending attempt's loopback listener. Only one can own the registered port, so a new attempt replaces it. */
let pending: { readonly cancel: (reason: Error) => void } | undefined

/** Closes the pending attempt's listener, e.g. when the plugin unloads. */
export function cancelPending(reason = new Error("Railway sign-in was cancelled")) {
  pending?.cancel(reason)
}

/**
 * Starts a PKCE authorization-code flow for a Railway native (public) OAuth app. A one-shot loopback server on
 * 127.0.0.1 receives the redirect; `submit` accepts a pasted redirect URL when the browser runs elsewhere.
 */
export async function authorize(config: OAuthConfig, methodID: string) {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const state = base64url(randomBytes(16))
  const redirect = redirectURI(config)

  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientID,
    redirect_uri: redirect,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Required for Railway to issue a refresh token, and lets the user revisit which projects they share.
    prompt: "consent",
  }).toString()

  let settle!: { resolve: (value: OAuthCredential) => void; reject: (error: unknown) => void }
  const callback = new Promise<OAuthCredential>((resolve, reject) => (settle = { resolve, reject }))
  // Avoid an unhandled rejection if OpenCode cancels the attempt before awaiting it.
  callback.catch(() => {})

  const exchange = async (redirected: URL) => {
    const error = redirected.searchParams.get("error")
    if (error) throw new Error(`Railway authorization failed: ${redirected.searchParams.get("error_description") ?? error}`)
    if (redirected.searchParams.get("state") !== state) throw new Error("Railway authorization failed: state mismatch")
    const code = redirected.searchParams.get("code")
    if (!code) throw new Error("Railway authorization failed: missing code")
    const json = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: config.clientID,
      code_verifier: verifier,
    })
    const user = await userinfo(json.access_token).catch(() => undefined)
    return credential(methodID, json, "", user ? { email: user.email, name: user.name, sub: user.sub } : undefined)
  }

  const server = createServer(async (request, response) => {
    const redirected = new URL(request.url ?? "/", redirect)
    if (redirected.pathname !== "/callback") {
      response.writeHead(404).end()
      return
    }
    try {
      const result = await exchange(redirected)
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<h1>Connected to Railway</h1><p>You can close this tab and return to OpenCode.</p>")
      settle.resolve(result)
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(String(error))
      settle.reject(error)
    } finally {
      server.close()
    }
  })
  cancelPending(new Error("Superseded by a newer Railway sign-in attempt"))
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${config.port} is in use; set the plugin's oauthPort option to the port registered on your Railway OAuth app`)
          : error,
      ),
    )
    server.listen(config.port, "127.0.0.1", resolve)
  })
  const expiresAt = Date.now() + 10 * 60_000
  const timer = setTimeout(() => {
    server.close()
    settle.reject(new Error("Railway authorization timed out"))
  }, expiresAt - Date.now())
  const self = {
    cancel: (reason: Error) => {
      server.close()
      settle.reject(reason)
    },
  }
  pending = self
  callback
    .finally(() => {
      clearTimeout(timer)
      if (pending === self) pending = undefined
    })
    .catch(() => {})

  return {
    url: url.toString(),
    instructions: "Approve OpenCode in your browser and choose the Railway project(s) it may create sandboxes in.",
    expiresAt,
    mode: "auto" as const,
    callback,
    submit: async (pasted: string) => {
      const result = await exchange(new URL(pasted))
      server.close()
      settle.resolve(result)
    },
  }
}

export async function refresh(config: OAuthConfig, current: OAuthCredential): Promise<OAuthCredential> {
  if (!current.refresh) throw new Error("Railway credential has no refresh token; reconnect Railway (`/connect` → Railway)")
  const json = await token({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: config.clientID })
  return credential(current.methodID, json, current.refresh, current.metadata)
}
