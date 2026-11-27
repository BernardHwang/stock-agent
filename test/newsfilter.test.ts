import { describe, expect, it } from "vitest";
import { aboutCompany, isMajor } from "../src/newsfilter";

describe("news filter", () => {
  it("knows major news", () => {
    expect(isMajor("Nvidia cuts guidance")).toBe(true);
    expect(isMajor("5 stocks to watch")).toBe(false);
    expect(isMajor("Analyst downgrades MongoDB")).toBe(true); // a plural "s" still matches
    expect(isMajor("Probes of the deep")).toBe(true);
    expect(isMajor("Reinvestigation")).toBe(false); // whole words only
    expect(isMajor("SEC opens probe")).toBe(true);
  });

  it("keeps only headlines about the company", () => {
    expect(aboutCompany("Central Garden & Pet Q4 Earnings", "US.NVDA", "NVIDIA Corporation")).toBe(false);
    expect(aboutCompany("SpaceX prices share offering", "US.SPCX", "Space Exploration Technologies")).toBe(true);
    expect(aboutCompany("NVDA beats estimates", "US.NVDA", "NVIDIA Corporation")).toBe(true);
    expect(aboutCompany("Nvidia beats estimates", "US.NVDA", "NVIDIA Corporation")).toBe(true);
    expect(aboutCompany("Anything", "US.NVDA", "")).toBe(true); // unknown name: nothing is filtered
  });
});
