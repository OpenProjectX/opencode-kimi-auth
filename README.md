# @openprojectx/opencode-kimi-auth

OAuth login for [Kimi Code](https://www.kimi.com/code) (subscription) in
[opencode](https://opencode.ai) — use **Kimi K3** / **K2.7 Code** via
`opencode auth login` browser sign-in, no manual API key needed.

## Why

opencode's built-in Kimi Code providers only support API keys. If you have a
**Kimi Code membership** (subscription), your sign-in is OAuth-based — pasting a
Moonshot *platform* key gets you `401 Unauthorized` (see
[docs/kimi-opencode-troubleshooting.md](docs/kimi-opencode-troubleshooting.md)).

This plugin adds the same OAuth device flow that `kimi` CLI and
[pi](https://github.com/earendil-works/pi) use:

```
opencode auth login → Kimi For Coding → Sign in with Kimi Code (subscription)
→ open URL, enter code → done
```

> **Upgrading from 0.3.0 or earlier?** The provider id changed — see
> [Migrating from `kimi-for-coding`](#migrating-from-kimi-for-coding).

## Install

```jsonc
// opencode.jsonc (project) or ~/.config/opencode/opencode.jsonc (global)
{
  "plugin": ["@openprojectx/opencode-kimi-auth"]
}
```

Kimi Code sells a CN plan and a global plan on separate endpoints. The plugin
binds to the CN plan (`kimi-code-plan-cn`, `api.kimi.com`) by default; select the
global plan (`kimi-code-plan-global`, `api.kimi.ai`) with a plugin option:

```jsonc
{
  "plugin": [["@openprojectx/opencode-kimi-auth", { "region": "global" }]]
}
```

Then:

```bash
opencode auth login   # → Kimi For Coding → "Sign in with Kimi Code (subscription)"
opencode models       # → kimi-code-plan-cn/k3, kimi-code-plan-cn/kimi-for-coding, …
```

## Models

Model ids below are shown for the CN plan; the global plan exposes the same
four models under `kimi-code-plan-global/`.

| Model | Description | Context |
|---|---|---|
| `kimi-code-plan-cn/k3` | **Kimi K3** — flagship, reasoning (recommended) | **1M tokens** |
| `kimi-code-plan-cn/k3-256k` | Kimi K3, smaller context variant | 256K |
| `kimi-code-plan-cn/kimi-for-coding` | Kimi K2.7 Code | 1M tokens |
| `kimi-code-plan-cn/kimi-for-coding-highspeed` | K2.7 Code, faster/more expensive | 256K |

Select interactively with `/models` in the TUI, or set a default:

```jsonc
{
  "plugin": ["@openprojectx/opencode-kimi-auth"],
  "model": "kimi-code-plan-cn/k3"
}
```

## Migrating from `kimi-for-coding`

models.dev retired the `kimi-for-coding` provider id and replaced it with
`kimi-code-plan-cn` / `kimi-code-plan-global`. A credential left behind under the
old id **stops opencode from starting at all**:

```
Error: Unexpected server error          # in the TUI
undefined is not an object (evaluating '$.models')   # with --print-logs
```

opencode reads `database[id].models` for every stored credential, and the retired
id no longer resolves. To recover:

```bash
opencode auth logout   # → Kimi For Coding (the stale kimi-for-coding entry)
opencode auth login    # → Kimi For Coding → "Sign in with Kimi Code (subscription)"
```

Then update any pinned `model` in your config from `kimi-for-coding/…` to
`kimi-code-plan-cn/…`. If opencode will not start long enough to run
`opencode auth logout`, delete the `kimi-for-coding` key from
`~/.local/share/opencode/auth.json` by hand.

## How it works

| Step | Detail |
|---|---|
| Login | RFC 8628 device authorization grant against `https://auth.kimi.com` (`/api/oauth/device_authorization` → poll `/api/oauth/token`). Official public client ID (same as MoonshotAI's `kimi-cli`). |
| Token use | `Authorization: Bearer <access_token>` against `https://api.kimi.com/coding/v1`. The plugin's custom fetch strips the `x-api-key` placeholder and injects the Bearer header. |
| Refresh | Access tokens live **~15 minutes**. The plugin refreshes proactively when <5 min remain, single-flights concurrent refreshes, retries 429/5xx with backoff, and persists rotated tokens back to opencode's auth store. |
| Concurrent instances | Kimi rotates the refresh token on every exchange, so two opencode processes racing would hand one of them `invalid_grant`. Before exchanging, the plugin re-reads the auth store and adopts a token a sibling process just wrote. |
| Unexpected 401/403 | The proactive window is clock-based, so early revocation or clock skew still reaches the API. The plugin forces one refresh and replays the request once. |
| Expired subscription | A lapsed membership still refreshes tokens happily while the API keeps answering 401 — otherwise surfacing as a bare `AI_APICallError: Unauthorized`. When a request fails auth *after* a successful refresh, the plugin raises a `SubscriptionUnauthorizedError` naming the entitlement (not the login) as the cause and echoing the server's text. |
| Expired refresh token | `invalid_grant`/401/403 → error tells you to run `opencode auth login` again, and the dead token is remembered so a retry loop stops hammering the OAuth host. |

API keys still work — the plugin registers both login methods, so
`opencode auth login` → Kimi For Coding shows a menu:
"Sign in with Kimi Code (subscription)" or "Manually enter API Key".
The `KIMI_API_KEY` env var also keeps working independently of both.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KIMI_CODE_OAUTH_HOST` | `https://auth.kimi.com` | Override OAuth host (also reads `KIMI_OAUTH_HOST`) |
| `KIMI_API_KEY` | — | Built-in API-key auth (unchanged, no plugin needed) |

| Plugin option | Default | Purpose |
|---|---|---|
| `region` | `cn` | `cn` → `kimi-code-plan-cn`, `global` → `kimi-code-plan-global` |
| `provider` | — | Bind to an explicit models.dev provider id (wins over `region`) |

## Develop

```bash
bun install
bun test          # unit tests (device flow, polling, refresh retry logic)
bun run typecheck
```

Release flow: [changesets](https://github.com/changesets/changesets) —
`bunx changeset` to add a changeset; merge to `master` and the
[release workflow](.github/workflows/release.yml) opens a version PR / publishes
to npm (requires `NPM_TOKEN` secret).

## References

- Technical evaluation & design: [docs/kimi-oauth-evaluation.md](docs/kimi-oauth-evaluation.md)
- Raw endpoint probes: [docs/kimi.http](docs/kimi.http)
- Official flow source: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) `src/kimi_cli/auth/oauth.py`
- pi implementation: `packages/ai/src/auth/oauth/kimi-coding.ts`

## License

MIT
