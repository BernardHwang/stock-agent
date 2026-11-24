/** Recent headlines from Yahoo's search API (moomoo has no news endpoint). Fail-soft: [] on any problem. */

export interface Headline {
  title: string;
  publisher: string;
  at: string; // ISO time
}

export async function headlines(code: string, count = 8): Promise<Headline[]> {
  const symbol = code.split(".").slice(1).join(".").replace(/\./g, "-"); // US.BRK.B -> BRK-B
  const query = new URLSearchParams({ q: symbol, newsCount: String(count), quotesCount: "0" });
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?${query}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; stock-agent)", accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`yahoo news failed: ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { news?: { title?: unknown; publisher?: unknown; providerPublishTime?: unknown }[] };
    return (body.news ?? [])
      .filter((n) => typeof n.title === "string" && n.title)
      .slice(0, count)
      .map((n) => ({
        title: String(n.title),
        publisher: String(n.publisher ?? ""),
        at: typeof n.providerPublishTime === "number" ? new Date(n.providerPublishTime * 1000).toISOString() : "",
      }));
  } catch (e) {
    console.error("yahoo news failed", e instanceof Error ? e.name : typeof e);
    return [];
  }
}
