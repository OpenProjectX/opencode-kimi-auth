import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_PROVIDER_ID,
  KimiAuthPlugin,
  PROVIDER_IDS,
  RefreshUnauthorizedError,
  SubscriptionUnauthorizedError,
  resolveProviderID,
} from "../src/index"

const API = "https://api.kimi.com/coding/v1/chat/completions"
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function credential(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}) {
  return {
    type: "oauth" as const,
    access: "access-old",
    refresh: "refresh-old",
    // Far in the future: no proactive refresh unless a test asks for it.
    expires: Date.now() + 60 * 60 * 1000,
    ...overrides,
  }
}

/**
 * Build the loader's fetch with a scripted network. Handlers are matched in
 * order; each call records the URL and the authorization header it carried.
 */
async function harness(options: {
  auth: ReturnType<typeof credential> | { type: "api"; key: string }
  handlers: Array<(url: string) => Response>
  pluginOptions?: Record<string, unknown>
}) {
  const saved: Array<Record<string, unknown>> = []
  const calls: Array<{ url: string; authorization: string | null }> = []

  const input = {
    client: {
      auth: {
        set: async (args: { body: Record<string, unknown> }) => {
          saved.push(args.body)
          // Mirror opencode: a successful set is visible to later getAuth calls.
          if (current.type === "oauth") current = { ...(args.body as ReturnType<typeof credential>) }
          return {}
        },
      },
    },
  } as never

  let current: typeof options.auth = options.auth
  const remaining = [...options.handlers]

  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get("authorization") })
    const handler = remaining.shift()
    if (!handler) throw new Error(`unexpected fetch call: ${url}`)
    return handler(url)
  }) as typeof fetch

  const hooks = await KimiAuthPlugin(input, options.pluginOptions)
  const loader = hooks.auth?.loader
  if (!loader) throw new Error("loader missing")

  const loaded = await loader(async () => current as never, {} as never)
  return { loaded, calls, saved, providerID: hooks.auth?.provider }
}

describe("resolveProviderID", () => {
  test("defaults to the CN plan", () => {
    expect(resolveProviderID(undefined)).toBe(PROVIDER_IDS.cn)
    expect(DEFAULT_PROVIDER_ID).toBe(PROVIDER_IDS.cn)
  })

  test("never returns the retired kimi-for-coding id", () => {
    expect(resolveProviderID({})).not.toBe("kimi-for-coding")
  })

  test("maps a region to its plan id", () => {
    expect(resolveProviderID({ region: "global" })).toBe(PROVIDER_IDS.global)
    expect(resolveProviderID({ region: " CN " })).toBe(PROVIDER_IDS.cn)
  })

  test("an explicit provider id wins", () => {
    expect(resolveProviderID({ provider: "custom-plan", region: "global" })).toBe("custom-plan")
  })

  test("rejects an unknown region", () => {
    expect(() => resolveProviderID({ region: "eu" })).toThrow(/Unknown Kimi Code region/)
  })
})

describe("loader", () => {
  test("ignores non-oauth credentials", async () => {
    const { loaded } = await harness({ auth: { type: "api", key: "sk-test" }, handlers: [] })
    expect(loaded).toEqual({})
  })

  test("binds to the configured provider id", async () => {
    const { providerID } = await harness({
      auth: credential(),
      handlers: [],
      pluginOptions: { region: "global" },
    })
    expect(providerID).toBe(PROVIDER_IDS.global)
  })

  test("refreshes proactively and sends the new bearer token", async () => {
    const { loaded, calls, saved } = await harness({
      auth: credential({ expires: Date.now() - 1000 }),
      handlers: [
        () => json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 }),
        () => json({ ok: true }),
      ],
    })

    const response = await loaded.fetch(API, { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(calls[0]?.url).toBe(TOKEN_URL)
    expect(calls[1]?.authorization).toBe("Bearer access-new")
    expect(saved[0]).toMatchObject({ type: "oauth", access: "access-new", refresh: "refresh-new" })
  })

  test("treats a missing expires as due for refresh", async () => {
    const { loaded, calls } = await harness({
      auth: { ...credential(), expires: undefined as unknown as number },
      handlers: [
        () => json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 }),
        () => json({ ok: true }),
      ],
    })

    await loaded.fetch(API, { method: "POST", body: "{}" })
    expect(calls[0]?.url).toBe(TOKEN_URL)
  })

  test("strips x-api-key so only the bearer token is sent", async () => {
    const { loaded, calls } = await harness({ auth: credential(), handlers: [() => json({ ok: true })] })

    await loaded.fetch(API, { method: "POST", body: "{}", headers: { "x-api-key": "dummy" } })
    expect(calls[0]?.authorization).toBe("Bearer access-old")
  })

  test("forces one refresh and replays after an unexpected 401", async () => {
    const { loaded, calls } = await harness({
      auth: credential(),
      handlers: [
        () => json({ error: "unauthorized" }, 401),
        () => json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 }),
        () => json({ ok: true }),
      ],
    })

    const response = await loaded.fetch(API, { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([API, TOKEN_URL, API])
    expect(calls[2]?.authorization).toBe("Bearer access-new")
  })

  test("reports an entitlement problem when a fresh token is still rejected", async () => {
    const { loaded } = await harness({
      auth: credential(),
      handlers: [
        () => json({ error: "unauthorized" }, 401),
        () => json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 900 }),
        () => json({ error: { message: "subscription expired" } }, 401),
      ],
    })

    const failure = loaded.fetch(API, { method: "POST", body: "{}" })

    await expect(failure).rejects.toBeInstanceOf(SubscriptionUnauthorizedError)
    await expect(failure).rejects.toThrow(/entitlement is not/)
    await expect(failure).rejects.toThrow(/subscription expired/)
  })

  test("adopts a token another process already rotated instead of exchanging", async () => {
    const saved: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const stale = credential({ expires: Date.now() - 1000 })
    let current = stale

    const input = {
      client: { auth: { set: async (a: { body: Record<string, unknown> }) => (saved.push(a.body), {}) } },
    } as never

    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = typeof request === "string" ? request : (request as Request).url
      calls.push(url)
      return json({ ok: true })
    }) as typeof fetch

    const hooks = await KimiAuthPlugin(input, undefined)
    const loaded = await hooks.auth!.loader!(async () => current as never, {} as never)

    // A sibling opencode process refreshes between the read and the exchange.
    current = credential({ access: "access-sibling", refresh: "refresh-sibling" })

    await loaded.fetch(API, { method: "POST", body: "{}" })

    expect(calls).toEqual([API])
    expect(saved).toHaveLength(0)
  })

  test("fails fast on a rejected refresh token instead of re-hitting the auth host", async () => {
    const { loaded, calls } = await harness({
      auth: credential({ expires: Date.now() - 1000 }),
      handlers: [() => json({ error: "invalid_grant" }, 401)],
    })

    await expect(loaded.fetch(API, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      RefreshUnauthorizedError,
    )
    await expect(loaded.fetch(API, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      RefreshUnauthorizedError,
    )

    // One exchange attempt total; the second request never reached the network.
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL])
  })
})
