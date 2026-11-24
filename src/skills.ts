/** Role instructions for the analysis (skills/*.md, adapted from TradingAgents; see skills/NOTICE.md). */
import bear from "../skills/bear.md";
import bull from "../skills/bull.md";
import fundamentalsAnalyst from "../skills/fundamentals_analyst.md";
import marketAnalyst from "../skills/market_analyst.md";
import newsAnalyst from "../skills/news_analyst.md";
import portfolioManager from "../skills/portfolio_manager.md";
import researchManager from "../skills/research_manager.md";
import riskAggressive from "../skills/risk_aggressive.md";
import riskConservative from "../skills/risk_conservative.md";
import riskNeutral from "../skills/risk_neutral.md";
import trader from "../skills/trader.md";

export const ROLES = [
  "market_analyst", "news_analyst", "fundamentals_analyst", "bull", "bear", "research_manager", "trader",
  "risk_aggressive", "risk_neutral", "risk_conservative", "portfolio_manager",
] as const;
export type Role = (typeof ROLES)[number];

export const SHARED_RULE = "Use only the verified data sheet and the reports given to you";

const SHARED = `

Shared rules:
- ${SHARED_RULE}; never invent prices, figures or news.
- If something you need is missing ("n/a"), say so instead of guessing.
- Be concise: at most 250 words unless your instructions say otherwise.`;

const RAW: Record<Role, string> = {
  market_analyst: marketAnalyst, news_analyst: newsAnalyst, fundamentals_analyst: fundamentalsAnalyst, bull, bear,
  research_manager: researchManager, trader, risk_aggressive: riskAggressive, risk_neutral: riskNeutral,
  risk_conservative: riskConservative, portfolio_manager: portfolioManager,
};

export const SKILLS = Object.fromEntries(ROLES.map((r) => [r, RAW[r].trim() + SHARED])) as Record<Role, string>;
