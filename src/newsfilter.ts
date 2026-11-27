/** Which headlines matter: major news, about this company. Ported from src/stockagent/news.py at 9c81be3. */

const MAJOR_KEYWORDS = [
  "earnings", "guidance", "downgrade", "upgrade", "lawsuit", "sues", "sued", "SEC", "investigation", "probe",
  "acquire", "acquisition", "merger", "CEO", "CFO", "resigns", "steps down", "recall", "bankruptcy", "delist",
  "offering", "dilution", "misses", "beats", "fraud", "antitrust", "export ban", "sanction",
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words, plus a plural "s" ("downgrades"), which the Python version missed.
const MAJOR_RE = new RegExp(`\\b(${MAJOR_KEYWORDS.map(escape).join("|")})s?\\b`, "i");

export function isMajor(title: string): boolean {
  return MAJOR_RE.test(title);
}

const NAME_SUFFIX = /[,.]|\b(inc|corp|corporation|co|ltd|plc|holdings|group|class [a-z])\b/gi;

/**
 * Yahoo's feed for a ticker mixes in other companies' stories: keep those naming the ticker or the company's short
 * name, matched as a word prefix ("Space Exploration Technologies" is "SpaceX" in headlines). An unknown name
 * filters nothing.
 */
export function aboutCompany(title: string, code: string, name: string): boolean {
  const short = name.replace(NAME_SUFFIX, " ").split(/\s+/).filter(Boolean).join(" ");
  if (!short) return true;
  const words = [code.split(".").slice(1).join("."), short, short.split(" ")[0]!];
  return words.some((w) => new RegExp(`\\b${escape(w)}`, "i").test(title));
}
