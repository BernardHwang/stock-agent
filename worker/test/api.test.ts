import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/commands";
import { apiGet, positions, quotePost, quotes, tradingDays } from "../src/moomoo/api";
import { Store } from "../src/store";
import { mockFetch, sentTexts, telegramOk } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const raw = (text: string) => new Response(text, { headers: { "content-type": "application/json" } });
const NOW = new Date("2026-11-24T03:00:00Z");

describe("apiGet", () => {
  it("keeps long account ids as exact strings", async () => {
    mockFetch(() => raw('{"s":"ok","d":{"accounts":[{"account_id":12345678901234567}]}}'));
    const d = (await apiGet("tok", "/api/v1.0/accounts/authorized_trd_accs")) as { accounts: { account_id: unknown }[] };
    expect(d.accounts[0]!.account_id).toBe("12345678901234567");
  });

  it("throws when moomoo answers an error", async () => {
    mockFetch(() => raw('{"s":"error","msg":"nope"}'));
    await expect(apiGet("tok", "/api/v1.0/x")).rejects.toThrow("answered error");
  });

  it("sends the bearer token and never a body", async () => {
    const calls = mockFetch(() => raw('{"s":"ok","d":{}}'));
    await apiGet("tok", "/api/v1.0/x");
    expect(calls[0]!.method).toBe("GET");
  });
});

describe("quotePost", () => {
  it("refuses anything outside the quote API before sending", async () => {
    const calls = mockFetch(() => raw('{"s":"ok","d":{}}'));
    await expect(quotePost("tok", "/api/v1.0/accounts/x", {})).rejects.toThrow();
    await expect(quotePost("tok", "/api/v1.0/trade/x", {})).rejects.toThrow();
    await expect(quotePost("tok", "/api/v1.0/quote/../trd/x", {})).rejects.toThrow();
    await expect(quotePost("tok", "/api/v1.0/quote/%2e%2e/trd/x", {})).rejects.toThrow();
    await expect(quotePost("tok", "/api/v1.0/quote/%2E%2E/trd/x", {})).rejects.toThrow();
    await expect(quotePost("tok", "/api/v1.0/quote/..\\trd/x", {})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("posts to the quote API", async () => {
    const calls = mockFetch(() => raw('{"s":"ok","d":{"x":1}}'));
    expect(await quotePost("tok", "/api/v1.0/quote/snapshot", { code_list: ["US.MDB"] })).toEqual({ x: 1 });
    expect(calls[0]!.method).toBe("POST");
  });
});

describe("positions", () => {
  it("merges a stock held in two accounts and skips non-stock rows", async () => {
    mockFetch((url) => {
      if (url.endsWith("/authorized_trd_accs")) return raw('{"s":"ok","d":{"accounts":[{"account_id":11111111111111111},{"account_id":2}]}}');
      if (url.includes("/11111111111111111/positions")) {
        return raw('{"s":"ok","d":[{"code":"US.NVDA","stock_name":"NVIDIA","qty":1,"cost_price":100,"security_type":"STOCK"},' +
          '{"code":"US.NVDA260116C200000","qty":1,"cost_price":5,"security_type":"OPTION"}]}');
      }
      if (url.includes("/2/positions")) return raw('{"s":"ok","d":[{"code":"US.NVDA","stock_name":"NVIDIA","qty":3,"cost_price":120}]}');
      return undefined;
    });
    const out = await positions("tok");
    expect(out.positions).toEqual([{ code: "US.NVDA", name: "NVIDIA", qty: 4, avgCost: 115 }]);
    expect(out.skipped).toEqual(["US.NVDA260116C200000"]);
  });
});

describe("/moomoo probe", () => {
  const upd = (text: string) => ({ message: { chat: { id: 1001 }, text } });

  it("only reads quote and account paths, and masks account ids", async () => {
    const store = new Store(env.DB);
    await store.setSetting("moomoo_refresh", "r");
    await store.setSetting("moomoo_access", "tok");
    await store.setSetting("moomoo_access_until", "2026-11-24T05:00:00Z");
    const calls = mockFetch((url) => telegramOk(url) ??
      raw('{"s":"ok","d":{"accounts":[{"account_id":12345678901234567}]}}'));
    await handleUpdate(env, store, upd("/moomoo probe /api/v1.0/trade/orders"), NOW, "https://worker.test");
    await handleUpdate(env, store, upd("/moomoo probe /api/v1.0/accounts/authorized_trd_accs"), NOW, "https://worker.test");
    const texts = sentTexts(calls);
    expect(texts[0]).toContain("only /api/v1.0/quote/ and /api/v1.0/accounts/");
    expect(texts[1]).toContain("…4567");
    expect(texts[1]).not.toContain("12345678901234567");
    expect(calls.filter((c) => c.url.includes("webapi.moomoo.com"))).toHaveLength(1);
  });
});

describe("quotes", () => {
  const fixture = async (name: string) => JSON.stringify((await import(`./fixtures/${name}.json`)).default);

  it("takes the overnight price when that session is active and skips codes with no price", async () => {
    const body = await fixture("snapshot-overnight");
    const calls = mockFetch(() => raw(body));
    const out = await quotes("tok", ["US.MDB", "US.NVDA"]);
    expect(out.get("US.MDB")).toEqual({ price: 312.5, session: "overnight" });
    expect(out.has("US.NVDA")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({ code_list: ["US.MDB", "US.NVDA"] });
  });

  it("reads pre-market prices, also from a wrapped list", async () => {
    const body = await fixture("snapshot-pre");
    mockFetch(() => raw(body));
    expect((await quotes("tok", ["US.MDB"])).get("US.MDB")).toEqual({ price: 318.2, session: "pre" });
  });

  it("falls back to the last price in the regular session", async () => {
    const body = await fixture("snapshot-regular");
    mockFetch(() => raw(body));
    expect((await quotes("tok", ["US.MDB"])).get("US.MDB")).toEqual({ price: 317.4, session: "regular" });
  });

  it("makes no call for an empty list", async () => {
    const calls = mockFetch(() => raw("{}"));
    expect((await quotes("tok", [])).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("tradingDays", () => {
  it("collects the trading dates", async () => {
    const body = JSON.stringify((await import("./fixtures/trading-days.json")).default);
    const calls = mockFetch(() => raw(body));
    const days = await tradingDays("tok", "2026-11-24", "2026-11-30");
    expect([...days]).toEqual(["2026-11-24", "2026-11-25", "2026-11-27"]);
    expect(calls[0]!.url).toContain("/api/v1.0/quote/trading-days");
  });
});
