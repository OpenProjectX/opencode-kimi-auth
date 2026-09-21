/**
 * Kimi Code (subscription) OAuth flow.
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding/v1 as an `Authorization: Bearer` header.
 *
 * Reference implementations:
 * - MoonshotAI/kimi-cli: src/kimi_cli/auth/oauth.py (official client)
 * - earendil-works/pi: packages/ai/src/auth/oauth/kimi-coding.ts
 */

export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const DEFAULT_OAUTH_HOST = "https://auth.kimi.com"
export const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
export const DEFAULT_POLL_INTERVAL_SECONDS = 5
export const REQUEST_TIMEOUT_MS = 30 * 1000
export const REFRESH_MAX_RETRIES = 3
/** Refresh proactively when less than this remains (matches pi / kimi-cli). */
export const PROACTIVE_REFRESH_MS = 5 * 60 * 1000

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type SleepLike = (ms: number) => Promise<void>

export type DeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  intervalSeconds: number
  expiresInSeconds: number
}

export type TokenResponse = {
  access: string
  refresh: string
  /** Epoch milliseconds at which the access token expires. */
  expires: number
}

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function getOauthHost(env: Record<string, string | undefined> = process.env): string {
  const override = env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST
  return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "")
}

function formUrlEncode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json = await response.json()
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.href
  } catch {
    return null
  }
}

function parseTokenResponse(json: Record<string, unknown> | null, operation: string): TokenResponse {
  const accessToken = json?.access_token
  const refreshToken = json?.refresh_token
  const expiresIn = json?.expires_in
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`)
  }
  return { access: accessToken, refresh: refreshToken, expires: Date.now() + expiresIn * 1000 }
}

export async function startDeviceAuthorization(
  oauthHost: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<DeviceAuthorization> {
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)

  const response = await fetchImpl(`${oauthHost}/api/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formUrlEncode({ client_id: CLIENT_ID }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`)
  }

  const json = await readJson(response)
  const deviceCode = json?.device_code
  const userCode = json?.user_code
  const verificationUri = json?.verification_uri
  const verificationUriComplete = json?.verification_uri_complete
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof verificationUriComplete !== "string" ||
    !trustedHttpUrl(verificationUriComplete) ||
    !trustedHttpUrl(verificationUri)
  ) {
    throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`)
  }

  const interval = json?.interval
  const expiresIn = json?.expires_in
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds:
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds:
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn
        : DEVICE_CODE_TIMEOUT_SECONDS,
  }
}

type PollResult = { type: "success"; token: TokenResponse }

/**
 * Poll the token endpoint until the user completes browser authorization.
 * Handles authorization_pending / slow_down per RFC 8628 §3.5.
 */
export async function pollForToken(
  oauthHost: string,
  device: DeviceAuthorization,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike; sleep?: SleepLike } = {},
): Promise<PollResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const deadline = Date.now() + device.expiresInSeconds * 1000
  let intervalMs = Math.max(1000, Math.floor(device.intervalSeconds * 1000))

  // Wait before the first poll; the user needs time to open the URL.
  await sleep(intervalMs)

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Kimi Code login cancelled")

    const response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: formUrlEncode({
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: options.signal,
    })

    if (response.status >= 500) {
      const text = await response.text().catch(() => "")
      throw new Error(`Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`)
    }

    const json = await readJson(response)
    if (response.ok && typeof json?.access_token === "string") {
      return { type: "success", token: parseTokenResponse(json, "poll") }
    }

    const error = json?.error
    const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
    if (error === "authorization_pending") {
      await sleep(intervalMs)
      continue
    }
    if (error === "slow_down") {
      // RFC 8628 §3.5: add 5s, but honor a server-provided interval.
      const serverInterval = json?.interval
      intervalMs =
        typeof serverInterval === "number" && Number.isFinite(serverInterval) && serverInterval > 0
          ? Math.max(1000, Math.floor(serverInterval * 1000))
          : intervalMs + 5000
      await sleep(intervalMs)
      continue
    }
    if (error === "expired_token") {
      throw new Error("Kimi Code device authorization expired. Please restart login.")
    }
    if (error === "access_denied") {
      throw new Error("Kimi Code login was denied.")
    }
    throw new Error(
      `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
    )
  }

  throw new Error("Kimi Code device flow timed out")
}

export class RefreshUnauthorizedError extends Error {}

/** Exchange the refresh token. Retries 429/5xx with backoff; 401/403/invalid_grant is fatal. */
export async function refreshToken(
  oauthHost: string,
  refreshTokenValue: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike; sleep?: SleepLike } = {},
): Promise<TokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    if (options.signal?.aborted) throw new Error("Kimi Code token refresh aborted")

    let response: Response
    try {
      response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formUrlEncode({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
        }),
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      continue
    }

    const json = await readJson(response)
    if (response.ok) return parseTokenResponse(json, "refresh")

    if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
      const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
      throw new RefreshUnauthorizedError(
        `Kimi Code token refresh unauthorized (status ${response.status})${description}. Please run "opencode auth login" again.`,
      )
    }

    if ((response.status === 429 || response.status >= 500) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`)
      continue
    }

    throw new Error(`Kimi Code token refresh failed with status ${response.status}: ${JSON.stringify(json)}`)
  }

  throw lastError ?? new Error("Kimi Code token refresh failed")
}

/**
 * True when the access token is expired or inside the proactive-refresh window.
 *
 * A missing or non-numeric `expires` (hand-edited auth.json, or a record written
 * by an older release) is treated as "refresh now" rather than "never refresh":
 * the arithmetic would otherwise yield NaN, and `NaN <= now` is false, leaving
 * the loader pinned to a stale token forever.
 */
export function needsRefresh(expires: number, now = Date.now()): boolean {
  if (!Number.isFinite(expires)) return true
  return expires - PROACTIVE_REFRESH_MS <= now
}

/**
 * The API rejected a request that carried a freshly refreshed access token.
 *
 * OAuth identity and Kimi Code entitlement are separate systems: a lapsed or
 * cancelled membership still refreshes tokens happily, while
 * `api.kimi.com/coding/v1` answers 401/403. Without this distinction the
 * failure surfaces as a bare `AI_APICallError: Unauthorized`, which reads like
 * a broken login and sends people back through a sign-in that cannot help.
 */
export class SubscriptionUnauthorizedError extends Error {}

/** Upper bound on server text echoed into an error message. */
const ERROR_BODY_LIMIT = 500

/**
 * Build the message for a 401/403 that survived a token refresh. Reads a clone
 * so the caller's response body stays intact.
 */
export async function describeApiAuthFailure(response: Response): Promise<string> {
  const raw = await response
    .clone()
    .text()
    .catch(() => "")
  const body = raw.trim().slice(0, ERROR_BODY_LIMIT)
  const detail = body ? ` Server said: ${body}` : ""
  return (
    `Kimi Code rejected the request with status ${response.status} even after a successful token refresh, ` +
    `so the OAuth credentials are valid and the Kimi Code entitlement is not. ` +
    `This usually means the subscription has expired, been cancelled, or does not cover this model.${detail} ` +
    `Check the membership at https://www.kimi.com/code, or switch to a platform provider ` +
    `(moonshotai / moonshotai-cn) with a platform API key.`
  )
}
