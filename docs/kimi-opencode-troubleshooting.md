# Troubleshooting: opencode fails to connect to Kimi K3 ("Unauthorized")

**Date:** 2026-08-27 · **Status:** Diagnosed · **Affected tool:** opencode 1.18.23

---

## 1. Symptom

opencode fails on every request when using model `kimi-for-coding/k3` (and
`kimi-for-coding/kimi-for-coding-highspeed`), while the pi coding agent on the
same machine connects to the same model successfully.

Error observed in the opencode TUI: **Unauthorized**.

## 2. Evidence

### 2.1 opencode logs

File: `~/.local/share/opencode/log/opencode.log`

```
level=INFO  message=stream providerID=kimi-for-coding modelID=k3
level=ERROR message="stream error" providerID=kimi-for-coding modelID=k3
        error.error="AI_APICallError: Unauthorized"
```

Every stream attempt (primary agent and title agent) fails with
`AI_APICallError: Unauthorized` ≈ HTTP 401 from the upstream API.

### 2.2 Stored credentials

File: `~/.local/share/opencode/auth.json`

| Provider entry     | Auth type | Key prefix |
|--------------------|-----------|------------|
| `kimi-for-coding`  | api key   | `sk-Oq1…`  |
| `moonshotai-cn`    | api key   | `sk-Oq1…`  |
| `moonshotai`       | api key   | `sk-Oq1…`  |

**The same `sk-…` platform key was pasted into all three provider slots.**

### 2.3 Direct API tests (curl)

The stored key was tested against each endpoint:

| # | Endpoint | Result | Meaning |
|---|----------|--------|---------|
| 1 | `POST https://api.kimi.com/coding/v1/messages` | **401** `invalid_authentication_error` | Key rejected by the Kimi For Coding endpoint — this is the endpoint opencode uses for `kimi-for-coding/*` |
| 2 | `GET https://api.moonshot.cn/v1/models` | **200** model list | Key **is valid**, but only on the Moonshot **CN platform** |
| 3 | `POST https://api.moonshot.cn/anthropic/v1/messages` (model `kimi-k3`) | **429** `exceeded_current_quota_error` — *"account … is suspended due to insufficient balance"* | Auth passes, but the CN platform account has no credit |
| 4 | `GET https://api.moonshot.ai/v1/models` | **401** | Key not valid on the global platform either |
| 5 | `POST https://api.kimi.com/coding/v1/messages` with pi's **OAuth token** | **200** | The endpoint works fine with the correct credential type |

Reproducible versions of these requests are in `kimi.http` (same directory).

## 3. Root cause

Two independent problems:

1. **Credential/endpoint mismatch.** `kimi-for-coding/k3` in opencode routes to
   `https://api.kimi.com/coding/v1` (Anthropic Messages API). That endpoint
   belongs to the **Kimi Code subscription** product and does not accept
   Moonshot *platform* API keys. The user stored a platform key
   (from platform.moonshot.cn) in the `kimi-for-coding` credential slot → 401.

2. **CN platform account out of balance.** Even the endpoint where the key *is*
   valid (`api.moonshot.cn`) rejects generation requests with 429
   (account suspended, insufficient balance).

**Same model name ≠ same product.** "Kimi" is exposed through three
independent billing/auth systems; a credential for one is rejected by the others:

| Product | Provider id (opencode) | Endpoint | Credential |
|---------|------------------------|----------|------------|
| Kimi Code (subscription) | `kimi-for-coding` | `https://api.kimi.com/coding/v1` | Kimi Code API key (from kimi.com/code) **or** OAuth token |
| Moonshot platform CN (pay-as-you-go) | `moonshotai-cn` | `https://api.moonshot.cn` (`/v1`, `/anthropic/v1`) | `sk-…` key from platform.moonshot.cn |
| Moonshot platform global | `moonshotai` | `https://api.moonshot.ai` | `sk-…` key from platform.moonshot.ai |

## 4. Why pi works on the same machine

pi uses a different auth mechanism entirely:

| | pi (working) | opencode (failing) |
|---|---|---|
| Provider | `kimi-coding` | `kimi-for-coding` |
| Auth | **OAuth 2.0 subscription login** (browser sign-in) | API key (`type: "api"`) |
| Token | JWT access token, `scope=kimi-code`, `region=cn`, **15-min lifetime**, auto-refreshed via refresh token | Static `sk-…` key |
| Token store | `~/.pi/agent/auth.json` | `~/.local/share/opencode/auth.json` |
| Model registry | `~/.pi/agent/models-store.json` | models.dev (`kimi-for-coding` → npm `@ai-sdk/anthropic`, env `KIMI_API_KEY`) |
| Endpoint | `https://api.kimi.com/coding` | `https://api.kimi.com/coding/v1` |

opencode's `kimi-for-coding` provider (per models.dev) supports **API-key auth
only** — it cannot perform or refresh the OAuth flow that pi uses. Copying pi's
OAuth access token into opencode is not viable: the token expires ~15 minutes
after issuance and opencode has no way to refresh it.

## 5. Fix options

**Option A — use the existing Kimi Code subscription (recommended; matches pi):**
1. Generate a Kimi Code API key at <https://www.kimi.com/code> (subscription
   console — this is a *different* key from platform.moonshot.cn keys).
2. Replace the wrong credential:
   `opencode auth login --provider kimi-for-coding`
   (or set env var `KIMI_API_KEY`).
3. Keep using model `kimi-for-coding/k3`.

**Option B — pay-as-you-go on the CN platform:**
1. Recharge the account at <https://platform.moonshot.cn> (clears the 429).
2. In opencode, switch model to `moonshotai-cn/kimi-k3`
   (the stored key already authenticates there).

## 6. Verification checklist (after fix)

- [ ] `curl` request #1 or #6 in `kimi.http` returns **200** (not 401)
- [ ] opencode log shows `message=stream` with no subsequent `stream error`
- [ ] `opencode models | grep kimi` lists the provider being used

## 7. General troubleshooting methodology

1. **Read the client log first.** opencode:
   `~/.local/share/opencode/log/opencode.log` (or run with `--print-logs`).
   The true error (`AI_APICallError: Unauthorized`) was visible immediately.
2. **Inspect stored credentials.** `opencode auth list` +
   `~/.local/share/opencode/auth.json`. All three providers holding the
   identical key was the first red flag.
3. **Isolate with curl.** Test the key directly against each endpoint to
   separate "bad key" / "wrong endpoint" / "billing" (401 vs 429) from
   client configuration problems.
4. **Check which endpoint the provider actually uses.** `opencode models`
   lists provider ids; the provider definition (models.dev) maps
   `kimi-for-coding` → `https://api.kimi.com/coding/v1`.
5. **Distinguish products behind the same brand.** Verify which console
   issued the key and match it to the endpoint's expected credential type
   (API key vs OAuth token; platform vs subscription).

## 8. Reference: file locations

| Purpose | Path |
|---------|------|
| opencode config | `~/.config/opencode/opencode.jsonc` (was empty/default) |
| opencode credentials | `~/.local/share/opencode/auth.json` |
| opencode logs | `~/.local/share/opencode/log/opencode.log` |
| pi credentials (OAuth) | `~/.pi/agent/auth.json` |
| pi model registry | `~/.pi/agent/models-store.json` |
| Repro API requests | `kimi.http` (this directory) |
| Kimi For Coding docs | <https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents.html> |
