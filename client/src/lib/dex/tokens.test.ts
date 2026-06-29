import { describe, expect, it } from "vitest";
import { fromRawAmount, resolveToken, toRawAmount } from "./tokens";

describe("toRawAmount", () => {
  it("converts integer human values", () => {
    expect(toRawAmount("100", 6)).toBe("100000000");
    expect(toRawAmount(100, 6)).toBe("100000000");
  });

  it("converts decimal human values", () => {
    expect(toRawAmount("1.5", 6)).toBe("1500000");
    expect(toRawAmount("0.000001", 6)).toBe("1");
  });

  it("truncates excess decimal precision", () => {
    expect(toRawAmount("1.123456789", 6)).toBe("1123456");
  });

  it("pads short fractional parts", () => {
    expect(toRawAmount("1.5", 8)).toBe("150000000");
  });

  it("handles whole-number fallthroughs without decimal point", () => {
    expect(toRawAmount("0", 6)).toBe("0");
    expect(toRawAmount("0.0", 6)).toBe("0");
    expect(toRawAmount("", 6)).toBe("0");
  });

  it("preserves precision for large values", () => {
    expect(toRawAmount("1000000.123456", 6)).toBe("1000000123456");
  });

  it("returns 0 for non-numeric input", () => {
    expect(toRawAmount("abc", 6)).toBe("0");
  });
});

describe("fromRawAmount", () => {
  it("round-trips with toRawAmount", () => {
    const cases = [
      { human: "100", decimals: 6 },
      { human: "1.5", decimals: 6 },
      { human: "0.000001", decimals: 6 },
      { human: "1000000.123456", decimals: 6 },
    ];
    for (const c of cases) {
      const raw = toRawAmount(c.human, c.decimals);
      expect(fromRawAmount(raw, c.decimals)).toBe(c.human);
    }
  });

  it("trims trailing zeros from fractional part", () => {
    expect(fromRawAmount("1500000", 6)).toBe("1.5");
    expect(fromRawAmount("100000000", 6)).toBe("100");
  });

  it("handles zero", () => {
    expect(fromRawAmount("0", 6)).toBe("0");
  });
});

describe("resolveToken", () => {
  it("prefers live tokens when provided", () => {
    const live = [
      { symbol: "USDC", address: "0xLIVE", decimals: 6, currency: "USD" },
    ];
    const r = resolveToken("USDC", live);
    expect(r?.address).toBe("0xLIVE");
  });

  it("falls back to static SUPPORTED_TOKENS when live missing", () => {
    const r = resolveToken("USDT", null);
    expect(r?.symbol).toBe("USDT");
    expect(r?.decimals).toBe(6);
  });

  it("is case-insensitive", () => {
    expect(resolveToken("usdt", null)?.symbol).toBe("USDT");
  });

  it("returns null for unknown symbols", () => {
    expect(resolveToken("FAKETOKEN", null)).toBeNull();
  });
});
