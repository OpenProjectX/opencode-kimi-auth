import { describe, expect, test } from "bun:test"
import {
  CLIENT_ID,
  RefreshUnauthorizedError,
  getOauthHost,
  needsRefresh,
  pollForToken,
  refreshToken,
  startDeviceAuthorization,
  type FetchLike,
} from "../src/oauth"

const noSleep = () => Promise.resolve()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Scriptable fetch: pops one handler per call. */
function scriptedFetch(...handlers: Array<(url: string, body: string) => Response>) {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = String(init?.body ?? "")
    calls.push({ url, body })
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch call: ${url}`)
    return handler(url, body)
  }
  return { fetchImpl, calls }
}

const device = {
  deviceCode: "dc-123",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.kimi.com/device",
  verificationUriComplete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
  intervalSeconds: 1,
  expiresInSeconds: 60,
}

describe("getOauthHost", () => {
  test("defaults to auth.kimi.com", () => {
    expect(getOauthHost({})).toBe("https://auth.kimi.com")
  })
  test("honors KIMI_CODE_OAUTH_HOST and strips trailing slashes", () => {
    expect(getOauthHost({ KIMI_CODE_OAUTH_HOST: "https://auth.example.com/" })).toBe("https://auth.example.com")
  })
  test("KIMI_OAUTH_HOST is a fallback", () => {
    expect(getOauthHost({ KIMI_OAUTH_HOST: "https://alt.example.com" })).toBe("https://alt.example.com")
  })
})

describe("startDeviceAuthorization", () => {
  test("parses a valid response and sends the client_id form", async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      jsonResponse({
        device_code: "dc-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.kimi.com/device",
        verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH",
        interval: 7,
        expires_in: 600,
      }),
    )
    const result = await startDeviceAuthorization("https://auth.kimi.com", { fetchImpl })
    expect(result.deviceCode).toBe("dc-123")
    expect(result.intervalSeconds).toBe(7)
    expect(result.expiresInSeconds).toBe(600)
    expect(calls[0]!.url).toBe("https://auth.kimi.com/api/oauth/device_authorization")
    expect(calls[0]!.body).toBe(`client_id=${CLIENT_ID}`)
  })

  test("applies defaults for missing interval/expires_in", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({
        device_code: "dc",
        user_code: "uc",
        verification_uri: "https://auth.kimi.com/device",
        verification_uri_complete: "https://auth.kimi.com/device?user_code=uc",
      }),
    )
    const result = await startDeviceAuthorization("https://auth.kimi.com", { fetchImpl })
    expect(result.intervalSeconds).toBe(5)
    expect(result.expiresInSeconds).toBe(900)
  })

  test("throws on non-OK status", async () => {
    const { fetchImpl } = scriptedFetch(() => new Response("boom", { status: 503 }))
    await expect(startDeviceAuthorization("https://auth.kimi.com", { fetchImpl })).rejects.toThrow("status 503")
  })

  test("rejects untrusted verification URIs", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({
        device_code: "dc",
        user_code: "uc",
        verification_uri: "javascript:alert(1)",
        verification_uri_complete: "javascript:alert(1)",
      }),
    )
    await expect(startDeviceAuthorization("https://auth.kimi.com", { fetchImpl })).rejects.toThrow(
      "Invalid Kimi Code device authorization response",
    )
  })
})

describe("pollForToken", () => {
  test("pending -> success, returns token with absolute expiry", async () => {
    const { fetchImpl, calls } = scriptedFetch(
      () => jsonResponse({ error: "authorization_pending" }),
      () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 900 }),
    )
    const before = Date.now()
    const result = await pollForToken("https://auth.kimi.com", device, { fetchImpl, sleep: noSleep })
    expect(result.token.access).toBe("at")
    expect(result.token.refresh).toBe("rt")
    expect(result.token.expires).toBeGreaterThanOrEqual(before + 900_000)
    expect(calls[0]!.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
    expect(calls[0]!.body).toContain("device_code=dc-123")
  })

  test("slow_down honors server-provided interval then succeeds", async () => {
    const sleeps: number[] = []
    const { fetchImpl } = scriptedFetch(
      () => jsonResponse({ error: "slow_down", interval: 30 }),
      () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 900 }),
    )
    await pollForToken("https://auth.kimi.com", device, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    // first sleep is the pre-poll wait (1s from device.intervalSeconds), second is slow_down's 30s
    expect(sleeps).toEqual([1000, 30_000])
  })

  test("expired_token fails with restart message", async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse({ error: "expired_token" }))
    await expect(pollForToken("https://auth.kimi.com", device, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      "expired. Please restart login",
    )
  })

  test("access_denied fails", async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse({ error: "access_denied" }))
    await expect(pollForToken("https://auth.kimi.com", device, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      "denied",
    )
  })

  test("5xx fails immediately", async () => {
    const { fetchImpl } = scriptedFetch(() => new Response("oops", { status: 502 }))
    await expect(pollForToken("https://auth.kimi.com", device, { fetchImpl, sleep: noSleep })).rejects.toThrow(
      "status 502",
    )
  })
})

describe("refreshToken", () => {
  test("success returns rotated tokens", async () => {
    const { fetchImpl, calls } = scriptedFetch(() =>
      jsonResponse({ access_token: "at2", refresh_token: "rt2", expires_in: 900 }),
    )
    const token = await refreshToken("https://auth.kimi.com", "rt1", { fetchImpl })
    expect(token.access).toBe("at2")
    expect(calls[0]!.body).toContain("grant_type=refresh_token")
    expect(calls[0]!.body).toContain("refresh_token=rt1")
  })

  test("retries 429 with backoff then succeeds", async () => {
    const sleeps: number[] = []
    const { fetchImpl } = scriptedFetch(
      () => jsonResponse({ error: "temporarily_unavailable" }, 429),
      () => jsonResponse({ access_token: "at2", refresh_token: "rt2", expires_in: 900 }),
    )
    const token = await refreshToken("https://auth.kimi.com", "rt1", {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(token.access).toBe("at2")
    expect(sleeps).toEqual([1000])
  })

  test("invalid_grant is fatal, no retries", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => jsonResponse({ error: "invalid_grant" }, 400))
    await expect(refreshToken("https://auth.kimi.com", "rt1", { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(
      RefreshUnauthorizedError,
    )
    expect(calls).toHaveLength(1)
  })

  test("401 is fatal with re-login hint", async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse({}, 401))
    await expect(refreshToken("https://auth.kimi.com", "rt1", { fetchImpl, sleep: noSleep })).rejects.toThrow(
      "opencode auth login",
    )
  })

  test("network errors are retried up to the limit", async () => {
    const { fetchImpl } = scriptedFetch(
      () => {
        throw new Error("socket hangup")
      },
      () => {
        throw new Error("socket hangup")
      },
      () => {
        throw new Error("socket hangup")
      },
      () => {
        throw new Error("socket hangup")
      },
    )
    await expect(refreshToken("https://auth.kimi.com", "rt1", { fetchImpl, sleep: noSleep })).rejects.toThrow(
      "socket hangup",
    )
  })
})

describe("needsRefresh", () => {
  test("true when expired or inside the proactive window", () => {
    const now = Date.now()
    expect(needsRefresh(now - 1, now)).toBe(true) // expired
    expect(needsRefresh(now + 60_000, now)).toBe(true) // <5 min remaining
    expect(needsRefresh(now + 10 * 60_000, now)).toBe(false) // 10 min remaining
  })
})
