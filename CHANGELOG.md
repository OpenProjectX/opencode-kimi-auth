# @openprojectx/opencode-kimi-auth

## 0.3.0

### Minor Changes

- f30c1c4: Add explicit "Manually enter API Key" method so `opencode auth login` shows a method menu instead of auto-selecting OAuth — API-key auth (e.g. KIMI_API_KEY) stays a first-class option alongside "Sign in with Kimi Code (subscription)".

## 0.2.0

### Minor Changes

- 551bb93: Initial release: "Sign in with Kimi Code (subscription)" OAuth login (RFC 8628 device flow) for opencode's built-in `kimi-for-coding` provider, with proactive access-token refresh (~15 min token TTL) and Bearer-header injection for `https://api.kimi.com/coding/v1`.
