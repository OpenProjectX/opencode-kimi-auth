/**
 * @openprojectx/opencode-kimi-auth
 *
 * Adds "Sign in with Kimi Code (subscription)" OAuth login to opencode's
 * Kimi Code providers (Kimi K3 / K2.7 Code on https://api.kimi.com/coding/v1),
 * so a Kimi Code membership works via browser sign-in instead of a manually
 * generated API key.
 *
 * Design references (see docs/kimi-oauth-evaluation.md):
 * - opencode built-ins: github-copilot (device flow UX), openai/codex (refresh)
 * - pi: packages/ai/src/auth/oauth/kimi-coding.ts (flow + refresh policy)
 */
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import {
  describeApiAuthFailure,
  getOauthHost,
  needsRefresh,
  pollForToken,
  refreshToken,
  startDeviceAuthorization,
  RefreshUnauthorizedError,
  SubscriptionUnauthorizedError,
  type TokenResponse,
} from "./oauth.js"

/**
 * models.dev provider ids for the Kimi Code subscription product, by the
 * `region` claim carried in the OAuth access token.
 */
export const PROVIDER_IDS = {
  cn: "kimi-code-plan-cn",
  global: "kimi-code-plan-global",
} as const

/**
 * Retired models.dev id. Kept only so the rename is greppable: an auth.json
 * entry under this id crashes opencode at startup, because the server reads
 * `database[id].models` for every stored credential and the id no longer
 * resolves. Users upgrading from <=0.3.0 must re-login under the new id.
 */
export const LEGACY_PROVIDER_ID = "kimi-for-coding"

/** Kimi Code is CN-first; the global plan is opt-in via plugin options. */
export const DEFAULT_PROVIDER_ID = PROVIDER_IDS.cn

/**
 * Some ai-sdk clients require a non-empty apiKey to initialize; the custom
 * fetch below replaces auth headers on every request, so this never leaves
 * the process. Mirrors opencode core's OAUTH_DUMMY_KEY.
 */
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

type OauthCredential = { type: "oauth"; access: string; refresh: string; expires: number }

/**
 * Pick the models.dev provider id this plugin binds to.
 *
 * `AuthHook.provider` is a single id resolved before any credential is read,
 * so the region cannot be auto-detected from the token. Configure it in
 * opencode.jsonc:
 *
 *   "plugin": [["@openprojectx/opencode-kimi-auth", { "region": "global" }]]
 */
export function resolveProviderID(options?: PluginOptions): string {
  const provider = options?.["provider"]
  if (typeof provider === "string" && provider.trim()) return provider.trim()

  const region = options?.["region"]
  if (typeof region === "string") {
    const key = region.trim().toLowerCase()
    if (key === "cn" || key === "global") return PROVIDER_IDS[key]
    if (key) throw new Error(`Unknown Kimi Code region "${region}". Use "cn" or "global".`)
  }

  return DEFAULT_PROVIDER_ID
}

/** Replaying a request after a 401 is only safe for a buffered body. */
function isReplayable(request: RequestInfo | URL, init?: RequestInit): boolean {
  if (request instanceof Request) return true
  const body = init?.body
  if (body === undefined || body === null) return true
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof FormData
  )
}

export const KimiAuthPlugin: Plugin = async (input, options) => {
  const host = getOauthHost()
  const providerID = resolveProviderID(options)

  /** Single-flight refresh: concurrent requests share one token exchange. */
  let refreshing: Promise<OauthCredential> | undefined
  /**
   * A refresh token the server has rejected outright. Remembered so a retry
   * loop does not hammer the OAuth host once a subscription is cancelled or
   * the 30-day refresh token lapses; cleared automatically when a new login
   * writes a different refresh token.
   */
  let rejected: { refresh: string; error: RefreshUnauthorizedError } | undefined

  async function persist(tokens: TokenResponse): Promise<OauthCredential> {
    await input.client.auth.set({
      path: { id: providerID },
      body: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires },
    })
    return { type: "oauth", ...tokens }
  }

  /**
   * Exchange the refresh token, unless another opencode process already did.
   *
   * Kimi rotates the refresh token on every exchange, so two instances racing
   * with the same stored token means the loser gets `invalid_grant` and the
   * user is bounced to a login they did not need. The single-flight guard
   * above only covers this process, so re-read the credential first and adopt
   * a token someone else just wrote.
   */
  async function freshen(stale: OauthCredential, getAuth: () => Promise<unknown>): Promise<OauthCredential> {
    refreshing ??= (async () => {
      const latest = await getAuth()
      const current = latest as OauthCredential | undefined
      if (
        current?.type === "oauth" &&
        current.access !== stale.access &&
        !needsRefresh(current.expires)
      ) {
        return current
      }

      const source = current?.type === "oauth" ? current.refresh : stale.refresh
      try {
        return await persist(await refreshToken(host, source))
      } catch (error) {
        if (error instanceof RefreshUnauthorizedError) rejected = { refresh: source, error }
        throw error
      }
    })().finally(() => {
      refreshing = undefined
    })

    return refreshing
  }

  return {
    auth: {
      provider: providerID,
      methods: [
        {
          type: "oauth",
          label: "Sign in with Kimi Code (subscription)",
          async authorize() {
            const device = await startDeviceAuthorization(host)
            return {
              url: device.verificationUriComplete,
              instructions: `Enter code: ${device.userCode}`,
              method: "auto" as const,
              async callback() {
                try {
                  const { token } = await pollForToken(host, device)
                  rejected = undefined
                  return {
                    type: "success" as const,
                    access: token.access,
                    refresh: token.refresh,
                    expires: token.expires,
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        // Keep the API-key path visible in `opencode auth login`. Without this,
        // the single OAuth method would auto-select and shadow the generic
        // key prompt (cli/cmd/providers.ts skips it once a plugin handles the
        // provider). No `authorize`: the CLI stores the key as-is.
        {
          type: "api",
          label: "Manually enter API Key",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") return fetch(request, init)

            let credential = current as OauthCredential
            if (rejected && rejected.refresh === credential.refresh) throw rejected.error
            rejected = undefined

            function send(access: string): Promise<Response> {
              const headers = new Headers(
                init?.headers ?? (request instanceof Request ? request.headers : undefined),
              )
              // models.dev maps the Kimi Code providers to
              // @ai-sdk/openai-compatible, which already sends `authorization`;
              // an @ai-sdk/anthropic client sends `x-api-key` from the dummy key
              // instead. Drop it either way — the endpoint accepts Bearer only.
              headers.delete("x-api-key")
              headers.set("authorization", `Bearer ${access}`)
              const target = request instanceof Request ? request.clone() : request
              return fetch(target, { ...init, headers })
            }

            // Proactive refresh: access tokens live only ~15 minutes.
            if (needsRefresh(credential.expires)) credential = await freshen(credential, getAuth)

            const response = await send(credential.access)
            if (response.status !== 401 && response.status !== 403) return response

            // Reactive refresh: the proactive window is clock-based, so an
            // early server-side revocation or a skewed clock still lands here.
            // One forced exchange separates "stale token" from "no entitlement".
            if (!isReplayable(request, init)) return response

            const renewed = await freshen(credential, getAuth)
            if (renewed.access === credential.access) throw new SubscriptionUnauthorizedError(
              await describeApiAuthFailure(response),
            )

            const retried = await send(renewed.access)
            if (retried.status !== 401 && retried.status !== 403) return retried

            throw new SubscriptionUnauthorizedError(await describeApiAuthFailure(retried))
          },
        }
      },
    },
  }
}

export { RefreshUnauthorizedError, SubscriptionUnauthorizedError }

export default {
  id: "opencode-kimi-auth",
  server: KimiAuthPlugin,
}
