---
"@openprojectx/opencode-kimi-auth": major
---

Bind to the current Kimi Code provider ids and handle subscription expiry distinctly from token expiry.

**Breaking:** the plugin now registers against `kimi-code-plan-cn` (default) or `kimi-code-plan-global`, selectable with a `region` / `provider` plugin option. models.dev retired `kimi-for-coding`, and a credential left under that id makes opencode fail to start entirely (`undefined is not an object (evaluating '$.models')`, surfaced in the TUI as `Unexpected server error`), because the server reads `database[id].models` for every stored credential. Run `opencode auth logout` then `opencode auth login`, and repoint any pinned `model` from `kimi-for-coding/…` to `kimi-code-plan-cn/…`.

- Distinguish an expired **subscription** from an expired **token**. A lapsed membership still refreshes OAuth tokens successfully while the API keeps returning 401, which previously surfaced as a bare `AI_APICallError: Unauthorized`. A request that fails auth after a successful refresh now raises `SubscriptionUnauthorizedError`, naming the entitlement as the cause and echoing the server's message.
- Force one refresh and replay the request on an unexpected 401/403, so early server-side revocation or clock skew recovers instead of failing the turn.
- Adopt a refresh token a sibling opencode process just rotated instead of exchanging a stale one. Kimi rotates refresh tokens on every exchange, so concurrent instances could previously knock each other out with `invalid_grant` and force a needless re-login.
- Remember a refresh token the server has rejected and fail fast, so an agent retry loop no longer hammers the OAuth host once a subscription is cancelled or the 30-day refresh token lapses. The memo clears itself when a new login writes a different token.
- Treat a missing or non-numeric `expires` as due for refresh. The previous arithmetic produced `NaN`, and `NaN <= now` is false, pinning the loader to a stale token forever.
