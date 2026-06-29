import { describe, expect, it } from "vitest";
import {
  bestRateStrategy,
  staleOfferStrategy,
  wideSpreadStrategy,
} from "./strategies";
import type { ActiveAdSnapshot, StrategyContext } from "./types";

function makeAd(partial: Partial<ActiveAdSnapshot>): ActiveAdSnapshot {
  return {
    id: 1,
    posterId: 100,
    fromToken: "USDT",
    toToken: "XSGD",
    rate: 1.36,
    liquidity: 1000,
    liquidityRemaining: 1000,
    settlementOrderId: "0x" + "f".repeat(64),
    marketSymbol: "USDT/XSGD",
    ...partial,
  };
}

function makeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    activeAds: [],
    oracleRates: { "USD/SGD": 1.35 },
    serverTimestampSec: 1700000000,
    ...overrides,
  };
}

describe("bestRateStrategy", () => {
  it("emits a signal when an ad beats the oracle by ≥ 5 bps", () => {
    // 1.36 vs oracle 1.35 → +74 bps, well over the 5-bps floor
    const sigs = bestRateStrategy(makeCtx({ activeAds: [makeAd({})] }));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.type).toBe("best_rate");
    expect(sigs[0]!.opportunityScore).toBeGreaterThan(70);
    expect(sigs[0]!.relatedAdId).toBe(1);
  });

  it("does NOT emit when the ad is worse than oracle", () => {
    // 1.34 vs 1.35 → negative diff
    const sigs = bestRateStrategy(makeCtx({ activeAds: [makeAd({ rate: 1.34 })] }));
    expect(sigs).toHaveLength(0);
  });

  it("does NOT emit when below the 5 bps floor", () => {
    // 1.35027 vs 1.35 → +2 bps, below floor
    const sigs = bestRateStrategy(makeCtx({ activeAds: [makeAd({ rate: 1.35027 })] }));
    expect(sigs).toHaveLength(0);
  });

  it("ignores ads without a the venue order id", () => {
    const sigs = bestRateStrategy(
      makeCtx({ activeAds: [makeAd({ settlementOrderId: null })] }),
    );
    expect(sigs).toHaveLength(0);
  });

  it("ignores ads with no oracle data for the pair", () => {
    const sigs = bestRateStrategy(
      makeCtx({ activeAds: [makeAd({})], oracleRates: {} }),
    );
    expect(sigs).toHaveLength(0);
  });

  it("uses inverse oracle rate when only the inverse direction is available", () => {
    // Oracle has SGD/USD instead of USD/SGD; should still resolve.
    const sigs = bestRateStrategy(
      makeCtx({
        activeAds: [makeAd({})],
        oracleRates: { "SGD/USD": 1 / 1.35 },
      }),
    );
    expect(sigs).toHaveLength(1);
  });
});

describe("staleOfferStrategy", () => {
  it("emits when ad gives takers more than market by ≥ 10 bps (maker exposed)", () => {
    // 1.37 vs 1.35 → +148 bps, exposed
    const sigs = staleOfferStrategy(makeCtx({ activeAds: [makeAd({ rate: 1.37 })] }));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.payload.direction).toBe("exposed");
  });

  it("emits when ad is uncompetitive (off_market)", () => {
    // 1.30 vs 1.35 → -370 bps, way uncompetitive
    const sigs = staleOfferStrategy(makeCtx({ activeAds: [makeAd({ rate: 1.30 })] }));
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.payload.direction).toBe("off_market");
  });

  it("does NOT emit when drift is below 10 bps either direction", () => {
    // 1.3505 vs 1.35 → +3.7 bps
    const sigs = staleOfferStrategy(makeCtx({ activeAds: [makeAd({ rate: 1.3505 })] }));
    expect(sigs).toHaveLength(0);
  });
});

describe("wideSpreadStrategy", () => {
  it("emits when bid+ask ads on the same market imply ≥ 15 bps spread", () => {
    // ask: USDT → XSGD at 1.36 (1 USDT buys 1.36 XSGD; ask price = 1.36 XSGD per USDT)
    // bid: XSGD → USDT at 0.7415 (1 XSGD buys 0.7415 USDT; implied bid = 1/0.7415 = 1.3486)
    // mid = (1.36 + 1.3486) / 2 = 1.3543; spread = (1.36 - 1.3486)/1.3543 = 84 bps
    const sigs = wideSpreadStrategy(
      makeCtx({
        activeAds: [
          makeAd({ id: 1, fromToken: "USDT", toToken: "XSGD", rate: 1.36, marketSymbol: "USDT/XSGD" }),
          makeAd({ id: 2, fromToken: "XSGD", toToken: "USDT", rate: 0.7415, marketSymbol: "USDT/XSGD" }),
        ],
      }),
    );
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.opportunityScore).toBeGreaterThan(80);
    expect(sigs[0]!.relatedAdId).toBeNull();
  });

  it("does NOT emit when only one side of the book is populated", () => {
    const sigs = wideSpreadStrategy(
      makeCtx({
        activeAds: [makeAd({ fromToken: "USDT", toToken: "XSGD", rate: 1.36 })],
      }),
    );
    expect(sigs).toHaveLength(0);
  });

  it("does NOT emit when bid >= ask (crossed book)", () => {
    // ask 1.34, bid 1.40 implied → crossed
    const sigs = wideSpreadStrategy(
      makeCtx({
        activeAds: [
          makeAd({ id: 1, fromToken: "USDT", toToken: "XSGD", rate: 1.34 }),
          makeAd({ id: 2, fromToken: "XSGD", toToken: "USDT", rate: 1 / 1.40 }),
        ],
      }),
    );
    expect(sigs).toHaveLength(0);
  });

  it("does NOT emit when spread is below the 15 bps floor", () => {
    // 1.350 ask, 1.349 bid → ~7 bps spread
    const sigs = wideSpreadStrategy(
      makeCtx({
        activeAds: [
          makeAd({ id: 1, fromToken: "USDT", toToken: "XSGD", rate: 1.350 }),
          makeAd({ id: 2, fromToken: "XSGD", toToken: "USDT", rate: 1 / 1.349 }),
        ],
      }),
    );
    expect(sigs).toHaveLength(0);
  });
});
