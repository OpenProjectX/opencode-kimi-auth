# opencode-kimi-auth

OAuth login for [Kimi Code](https://www.kimi.com/code) (subscription) in
[opencode](https://opencode.ai) — use **Kimi K3** / **K2.7 Code** via
`opencode auth login` browser sign-in, no manual API key needed.

## Why

opencode's built-in `kimi-for-coding` provider only supports API keys. If you
have a **Kimi Code membership** (subscription), your sign-in is OAuth-based —
pasting a Moonshot *platform* key gets you `401 Unauthorized` (see
[docs/kimi-opencode-troubleshooting.md](docs/kimi-opencode-troubleshooting.md)).

This plugin adds the same OAuth device flow that `kimi` CLI and
[pi](https://github.com/earendil-works/pi) use:

```
opencode auth login → Kimi For Coding → Sign in with Kimi Code (subscription)
→ open URL, enter code → done
```

## Install

```jsonc
// opencode.jsonc (project) or ~/.config/opencode/opencode.jsonc (global)
{
  "plugin": ["opencode-kimi-auth"]
}
```

Then:

```bash
opencode auth login   # → Kimi For Coding → "Sign in with Kimi Code (subscription)"
opencode models       # → kimi-for-coding/k3, kimi-for-coding/kimi-for-coding, …
```

## Models

| Model | Description | Context |
|---|---|---|
| `kimi-for-coding/k3` | **Kimi K3** — flagship, reasoning (recommended) | **1M tokens** |
| `kimi-for-coding/k3-256k` | Kimi K3, smaller context variant | 256K |
| `kimi-for-coding/kimi-for-coding` | Kimi K2.7 Code | 256K |
| `kimi-for-coding/kimi-for-coding-highspeed` | K2.7 Code, faster/more expensive | 256K |

Select interactively with `/models` in the TUI, or set a default:

```jsonc
{
  "plugin": ["opencode-kimi-auth"],
  "model": "kimi-for-coding/k3"
}
```

## How it works

| Step | Detail |
|---|---|
| Login | RFC 8628 device authorization grant against `https://auth.kimi.com` (`/api/oauth/device_authorization` → poll `/api/oauth/token`). Official public client ID (same as MoonshotAI's `kimi-cli`). |
| Token use | `Authorization: Bearer <access_token>` against `https://api.kimi.com/coding/v1` (Anthropic Messages API). The plugin's custom fetch strips the `x-api-key` placeholder and injects the Bearer header. |
| Refresh | Access tokens live **~15 minutes**. The plugin refreshes proactively when <5 min remain, single-flights concurrent refreshes, retries 429/5xx with backoff, and persists rotated tokens back to opencode's auth store. |
| Expired refresh token | `invalid_grant`/401/403 → error tells you to run `opencode auth login` again. |

API keys still work — the plugin only adds the OAuth method; the built-in
"API key" method is untouched.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KIMI_CODE_OAUTH_HOST` | `https://auth.kimi.com` | Override OAuth host (also reads `KIMI_OAUTH_HOST`) |
| `KIMI_API_KEY` | — | Built-in API-key auth (unchanged, no plugin needed) |

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
