/**
 * opencode-kimi-auth
 *
 * Adds "Sign in with Kimi Code (subscription)" OAuth login to opencode's
 * built-in `kimi-for-coding` provider (Kimi K3 / K2.7 Code on
 * https://api.kimi.com/coding/v1), so a Kimi Code membership works via
 * browser sign-in instead of a manually generated API key.
 *
 * Design references (see docs/kimi-oauth-evaluation.md):
 * - opencode built-ins: github-copilot (device flow UX), openai/codex (refresh)
 * - pi: packages/ai/src/auth/oauth/kimi-coding.ts (flow + refresh policy)
 */
import type { Plugin } from "@opencode-ai/plugin"
import {
  getOauthHost,
  needsRefresh,
  pollForToken,
  refreshToken,
  startDeviceAuthorization,
  RefreshUnauthorizedError,
  type TokenResponse,
} from "./oauth.js"

const PROVIDER_ID = "kimi-for-coding"
/**
 * @ai-sdk/anthropic requires a non-empty apiKey to initialize; the custom
 * fetch below replaces auth headers on every request, so this never leaves
 * the process. Mirrors opencode core's OAUTH_DUMMY_KEY.
 */
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export const KimiAuthPlugin: Plugin = async (input) => {
  const host = getOauthHost()
  /** Single-flight refresh: concurrent requests share one token exchange. */
  let refreshing: Promise<string> | undefined

  async function refresh(refreshTokenValue: string): Promise<string> {
    const tokens: TokenResponse = await refreshToken(host, refreshTokenValue)
    await input.client.auth.set({
      path: { id: PROVIDER_ID },
      body: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires },
    })
    return tokens.access
  }

  return {
    auth: {
      provider: PROVIDER_ID,
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
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            let current = await getAuth()
            if (current.type !== "oauth") return fetch(request, init)

            // Proactive refresh: access tokens live only ~15 minutes.
            if (needsRefresh(current.expires)) {
              refreshing ??= refresh(current.refresh).finally(() => {
                refreshing = undefined
              })
              const access = await refreshing
              current = { ...current, access }
            }

            // The Anthropic client sets x-api-key from the dummy key; the
            // Kimi Code endpoint accepts Bearer only.
            const headers = new Headers(init?.headers)
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${current.access}`)

            return fetch(request, { ...init, headers })
          },
        }
      },
    },
  }
}

export { RefreshUnauthorizedError }

export default {
  id: "opencode-kimi-auth",
  server: KimiAuthPlugin,
}
