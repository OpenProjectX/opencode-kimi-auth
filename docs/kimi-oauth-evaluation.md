# Evaluation: Supporting Kimi Code OAuth in opencode

**Date:** 2026-08-28 · **Repo:** /data/Git/opencode (opencode 1.18.x source) · **Related:** `kimi-opencode-troubleshooting.md`, `kimi.http`

---

## 1. Background

Today opencode supports `kimi-for-coding` (Kimi K3 / K2.7 Code on
`https://api.kimi.com/coding/v1`) via **API key only** — the credential must be
generated manually at kimi.com/code. Users of the Kimi Code *subscription* who
signed in with a browser (the flow pi, kimi-cli, and other agents use) cannot
reuse that login and hit `401 Unauthorized` when they paste a Moonshot
**platform** key instead (see `kimi-opencode-troubleshooting.md`).

**Goal:** let users run `opencode auth login` → "Kimi For Coding" → browser
device-code login, with automatic token refresh — identical UX to GitHub
Copilot / ChatGPT login in opencode.

## 2. The Kimi Code OAuth flow (verified against 3 implementations)

It is a standard **OAuth 2.0 Device Authorization Grant (RFC 8628)** against
`https://auth.kimi.com`. The client ID is **public and official** — it is
hardcoded in MoonshotAI's own open-source `kimi-cli`
(`MoonshotAI/kimi-cli: src/kimi_cli/auth/oauth.py`) and reused by pi and other
agents, so opencode can use the same one.

| Constant | Value |
|---|---|
| OAuth host | `https://auth.kimi.com` (env override: `KIMI_CODE_OAUTH_HOST`) |
| Client ID | `17e5f671-d194-4dfb-9706-5516cb48c098` |
| Device authorization | `POST {host}/api/oauth/device_authorization` |
| Token / refresh | `POST {host}/api/oauth/token` |
| Content type | `application/x-www-form-urlencoded` (JSON responses) |
| Access-token TTL | **~900 s (15 min)** → refresh is mandatory |
| API auth | `Authorization: Bearer {access_token}` only (no `x-api-key`) |
| API endpoint | `https://api.kimi.com/coding/v1` (Anthropic Messages API) |

**Flow:**
1. `POST /api/oauth/device_authorization` body `client_id=…` →
   `{device_code, user_code, verification_uri, verification_uri_complete, interval≈5, expires_in≈900}`
2. User opens `verification_uri_complete` and confirms `user_code`.
3. Poll `POST /api/oauth/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, `device_code`
   every `interval` s until success. Handle `authorization_pending`,
   `slow_down` (use returned `interval`), `expired_token`, `access_denied`.
4. Success → `{access_token, refresh_token, expires_in}` → store
   `{type:"oauth", access, refresh, expires: Date.now()+expires_in*1000}`.
5. **Refresh:** `POST /api/oauth/token` with `grant_type=refresh_token`,
   `client_id`, `refresh_token`. Retry ≤3× with backoff on 429/5xx; on
   401/403/`invalid_grant` the credential is dead → require re-login.
   (kimi-cli additionally refreshes *proactively*: when <300 s remain or >50 %
   of TTL elapsed, and serializes refreshes with a cross-process lock.)

## 3. opencode auth architecture (what we plug into)

Everything needed already exists; Kimi OAuth is a **new auth plugin**, not a
core change.

| Piece | Location | Role |
|---|---|---|
| Plugin hooks contract | `@opencode-ai/plugin` (`Hooks.auth`) | `{provider, methods[], loader(getAuth)}` |
| Built-in plugin registry | `packages/opencode/src/plugin/index.ts` → `internalPlugins()` | Codex, Copilot, GitLab, Poe, xAI, … live here |
| Auth method orchestration | `packages/opencode/src/provider/auth.ts` | `methods()` / `authorize()` / `callback()`; persists result via `Auth.set` |
| Credential store | `packages/opencode/src/auth/index.ts` | `~/.local/share/opencode/auth.json`; OAuth schema `{type, access, refresh, expires, accountId?, enterpriseUrl?}` — already fits Kimi 1:1 |
| Device-flow precedent | `src/plugin/github-copilot/copilot.ts` | `authorize()` → `{url, instructions, method:"auto", callback()}` polling loop with `authorization_pending` / `slow_down` handling |
| Token-refresh precedent | `src/plugin/openai/codex.ts` (loader, ~L338-400) | deduplicated `refreshPromise`, `expires < Date.now()` check, persists via `input.client.auth.set`, strips stale auth headers |
| Model/provider wiring | `src/provider/provider.ts` (~L1450-1475) | plugin `provider.models()` hook optional; models otherwise come from models.dev (`kimi-for-coding` → npm `@ai-sdk/anthropic`, baseURL `https://api.kimi.com/coding/v1`) |

**Key mechanics for the loader:** when a plugin `auth.loader` returns a custom
`fetch`, that fetch is used for all requests to the provider. It must:
- delete `x-api-key` / stale `authorization` headers set by `@ai-sdk/anthropic`,
- set `Authorization: Bearer {access}`,
- refresh first if `expires` is near/past (Codex pattern),
- return `apiKey: OAUTH_DUMMY_KEY` (`"opencode-oauth-dummy-key"`, exported from
  `src/auth/index.ts`) so the ai-sdk Anthropic client initializes.

## 4. Gap analysis

| Requirement | Exists in opencode? |
|---|---|
| OAuth method type in `auth login` flow | ✅ (`Method.type = "oauth"`, `method: "auto"` callback) |
| Device-code UX (show URL + user code, poll in background) | ✅ proven by Copilot plugin |
| OAuth credential schema incl. expiry | ✅ `Auth.Oauth` |
| Refresh-on-expiry inside request path | ✅ pattern proven by Codex plugin |
| Provider definition for kimi-for-coding | ✅ models.dev (models `k3`, `k3-256k`, …) |
| **Kimi plugin implementing the flow** | ❌ — this is the work |
| Proactive refresh (15-min TTL is aggressive) | ⚠️ Codex refreshes reactively; Kimi should copy kimi-cli's proactive threshold |

## 5. Implementation options

**Option 1 — built-in plugin (upstream PR).**
New `packages/opencode/src/plugin/kimi/kimi.ts` + one line in
`internalPlugins()`. Best UX (works out of the box), follows the Copilot/Codex
precedent exactly. Requires upstream review/merge. **~250 LoC.**

**Option 2 — external npm plugin (`@openprojectx/opencode-kimi-auth`).**
Same code shipped as an npm package; users add `"plugin": ["@openprojectx/opencode-kimi-auth"]`
to `opencode.jsonc`. No upstream dependency — can ship today; precedents:
`opencode-gitlab-auth`, `opencode-poe-auth` (note: these got absorbed into
`internalPlugins()` later, so external-first → upstream is a proven path).

**Recommendation:** build as external plugin first (unblocks immediately, real
user feedback), then PR it as a built-in.

## 6. Implementation sketch

```ts
// packages/opencode/src/plugin/kimi/kimi.ts
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
const HOST = (process.env.KIMI_CODE_OAUTH_HOST ?? "https://auth.kimi.com").replace(/\/+$/, "")
const PROACTIVE_REFRESH_MS = 5 * 60 * 1000   // refresh when <5 min remain (kimi-cli behavior)

export async function KimiAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "kimi-for-coding",           // must match models.dev provider id
      methods: [{
        type: "oauth",
        label: "Sign in with Kimi Code (subscription)",
        async authorize() {
          const r = await fetch(`${HOST}/api/oauth/device_authorization`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({ client_id: CLIENT_ID }),
          }).then(r => r.json())
          return {
            url: r.verification_uri_complete,           // TUI shows this
            instructions: `Enter code: ${r.user_code}`,
            method: "auto",
            async callback() {                          // poll loop (copilot.ts shape)
              while (true) {
                const t = await fetch(`${HOST}/api/oauth/token`, { /* device_code grant */ }).then(r => r.json())
                if (t.access_token) return {
                  type: "success",
                  access: t.access_token,
                  refresh: t.refresh_token,
                  expires: Date.now() + t.expires_in * 1000,
                }
                if (t.error === "authorization_pending") { await sleep(r.interval * 1000); continue }
                if (t.error === "slow_down") { /* +5s per RFC 8628 §3.5 */ continue }
                return { type: "failed" }
              }
            },
          }
        },
        { type: "api", label: "Kimi For Coding API key" },  // keep key path working
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        let refreshing: Promise<string> | undefined
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(req, init) {
            let cur = await getAuth()
            if (cur.expires - PROACTIVE_REFRESH_MS < Date.now()) {
              refreshing ??= refreshToken(cur.refresh)     // dedup concurrent refreshes
                .then(t => input.client.auth.set({        // persist (codex.ts pattern)
                  path: { id: "kimi-for-coding" },
                  body: { type: "oauth", access: t.access_token, refresh: t.refresh_token,
                          expires: Date.now() + t.expires_in * 1000 },
                }).then(() => t.access_token))
                .finally(() => (refreshing = undefined))
              cur.access = await refreshing
            }
            const headers = new Headers(init?.headers)
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${cur.access}`)
            return fetch(req, { ...init, headers })
          },
        }
      },
    },
  }
}
```

## 6a. Cross-check against pi source (/data/Git/pi)

Verified against `packages/ai/src/auth/oauth/kimi-coding.ts`,
`packages/ai/src/auth/resolve.ts`, and `packages/ai/src/api/anthropic-messages.ts`.

**Confirmed accurate:**
- Flow spec (device grant, endpoints, form encoding, `client_id`, 15-min TTL)
  matches §2 exactly.
- Bearer-only auth: pi's `toAuth` sets **only** `Authorization` — stripping
  `x-api-key` in the opencode loader is correct and sufficient.
- Refresh policy: pi refreshes when **<5 min** remain
  (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`), retries 429/5xx ≤3× with backoff,
  treats 401/403/`invalid_grant` as dead credential. Matches §2/§7.
- No Kimi-specific request identity needed: pi's "Claude Code" system-prompt
  injection is gated on the `sk-ant-oat` token prefix (Anthropic OAuth only)
  and does **not** apply to Kimi JWTs.

**Refinements learned from pi (stronger than opencode's Codex pattern):**
1. **Double-checked locking on refresh** (`resolveStoredOAuth`): optimistic
   expiry check → acquire credential-store lock → re-check expiry *under the
   lock* ("another process/request refreshed") → refresh once → persist rotated
   token before release. Codex's in-memory `refreshPromise` only dedups within
   one process; for `opencode serve` multi-instance setups, pi's file-locked
   `credentials.modify()` is the reference design (kimi-cli uses a
   cross-process lock too).
2. **Refresh timeout + validity assertion:** 15 s timeout on the refresh call
   (`DEFAULT_OAUTH_REFRESH_TIMEOUT_MS`) and an error if the rotated token still
   expires inside the required window.
3. **Endpoint quirks to validate in E2E** (pi compensates via model `compat`
   flags that plain `@ai-sdk/anthropic` lacks):
   - `forceAdaptiveThinking` — k3 uses effort-based adaptive thinking; pi skips
     the `interleaved-thinking-2025-05-14` beta header for it.
   - `allowEmptySignature` — Kimi may return thinking blocks with empty
     signatures; replaying them strictly can 400.
   Basic chat works without these (proven by `kimi.http` #6 → 200), but long
   agentic sessions with thinking-block replay should be validated; if needed,
   add `chat.params`/`chat.headers` hooks to the plugin (precedent: Copilot
   plugin's `toolStreaming = false` fix for its Anthropic shim).
4. pi's `packages/ai/test/kimi-coding-oauth.test.ts` is a ready-made fixture
   set for §8's unit tests.

## 7. Edge cases & risks

| Risk | Mitigation |
|---|---|
| 15-min TTL, long sessions | proactive refresh when <5 min remain — matches pi (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`) and kimi-cli (300 s threshold) |
| Concurrent requests racing refresh | in-process single-flight `refreshPromise` (Codex pattern) for the TUI; for multi-instance `opencode serve`, follow pi's locked `credentials.modify()` design (§6a) — re-check expiry under the lock, persist before release |
| Refresh failure 429/5xx | ≤3 retries, exponential backoff (pi behavior) |
| `invalid_grant` / revoked refresh token | surface "please run `opencode auth login` again"; delete stored credential |
| Clock skew (WSL/VM) | pi observed this causing slow_down loops — margin on poll interval (copilot adds 3 s safety margin) |
| `@ai-sdk/anthropic` sends `x-api-key` | loader strips it; `OAUTH_DUMMY_KEY` keeps client init happy |
| Region | tokens are issued for `region: cn`; host override via `KIMI_CODE_OAUTH_HOST` (pi convention) |
| Client ID legitimacy | ✅ public, from MoonshotAI's own `kimi-cli`; still polite to mention in PR |
| models.dev metadata | no change needed (plugin supplies methods; baseURL/npm already correct). Optionally add `oauth: true` upstream to models.dev for docs |

## 8. Test plan

1. **Unit:** mocked fetch — device_authorization → pending → slow_down → success;
   refresh path; `invalid_grant` → error surfaces.
2. **E2E with real subscription:** `opencode auth login` → Kimi For Coding →
   device code → send message on `kimi-for-coding/k3` → 200.
   **Status 2026-08-28: PASSED** — device flow completed against
   `https://auth.kimi.com`, OAuth credential stored, live call to
   `https://api.kimi.com/coding/v1/messages` (model `k3`) returned 200.
3. **Expiry:** hand-edit `auth.json` `expires` to the past → next request
   transparently refreshes (check file rewritten).
4. **Regression:** API-key method still works (keep both methods listed).
5. Requests from `kimi.http` #1/#6 serve as raw endpoint fixtures.

## 9. Effort estimate

- Plugin code: ~250 LoC (≈ 1 day incl. tests) — Copilot `authorize` + Codex
  `loader` are 90 % of the design.
- External plugin packaging: ~½ day.
- Upstream PR + review: days–weeks (external plugin covers the gap meanwhile).

## 10. References

- Flow source of truth: `MoonshotAI/kimi-cli` → `src/kimi_cli/auth/oauth.py` (official)
- pi implementation (local clone `/data/Git/pi`): `packages/ai/src/auth/oauth/kimi-coding.ts`, refresh locking in `packages/ai/src/auth/resolve.ts`, endpoint quirks in `packages/ai/src/api/anthropic-messages.ts`, tests in `packages/ai/test/kimi-coding-oauth.test.ts`
- opencode templates: `src/plugin/github-copilot/copilot.ts`, `src/plugin/openai/codex.ts`
- Kimi docs: "Using Kimi in OpenCode" (API-key path, current), kimi.com/code/docs
- RFC 8628 (Device Authorization Grant)
