import { describe, it, expect } from "vitest";
import { QUEST_DEFINITIONS } from "./routers/quests";

describe("Quest Definitions", () => {
  it("should have at least 15 quests defined", () => {
    expect(QUEST_DEFINITIONS.length).toBeGreaterThanOrEqual(15);
  });

  it("should have unique quest IDs", () => {
    const ids = QUEST_DEFINITIONS.map((q) => q.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("should have valid categories", () => {
    const validCategories = ["trading", "social", "partner", "streak"];
    for (const q of QUEST_DEFINITIONS) {
      expect(validCategories).toContain(q.category);
    }
  });

  it("should have positive XP rewards", () => {
    for (const q of QUEST_DEFINITIONS) {
      expect(q.xpReward).toBeGreaterThan(0);
    }
  });

  it("should have positive requirement values", () => {
    for (const q of QUEST_DEFINITIONS) {
      expect(q.requirement.value).toBeGreaterThan(0);
    }
  });

  it("should have valid requirement types", () => {
    const validTypes = ["swap_count", "swap_volume", "send_count", "p2p_count", "login_streak", "referral", "manual"];
    for (const q of QUEST_DEFINITIONS) {
      expect(validTypes).toContain(q.requirement.type);
    }
  });

  it("should have partner quests as manual type", () => {
    const partnerQuests = QUEST_DEFINITIONS.filter((q) => q.category === "partner");
    for (const q of partnerQuests) {
      expect(q.requirement.type).toBe("manual");
    }
  });

  it("should have trading quests with non-manual types", () => {
    const tradingQuests = QUEST_DEFINITIONS.filter((q) => q.category === "trading");
    for (const q of tradingQuests) {
      expect(q.requirement.type).not.toBe("manual");
    }
  });

  it("should include Asktian and YouApp partner quests", () => {
    const ids = QUEST_DEFINITIONS.map((q) => q.id);
    expect(ids).toContain("visit_asktian");
    expect(ids).toContain("visit_youapp");
  });

  it("should include share_app social quest as repeatable", () => {
    const shareQuest = QUEST_DEFINITIONS.find((q) => q.id === "share_app");
    expect(shareQuest).toBeDefined();
    expect(shareQuest?.repeatable).toBe(true);
  });
});

describe("Wallet address validation", () => {
  const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

  it("should validate correct Ethereum addresses", () => {
    const validAddresses = [
      "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      "0x0000000000000000000000000000000000000000",
      "0xffffffffffffffffffffffffffffffffffffffff",
    ];
    for (const addr of validAddresses) {
      expect(ETH_ADDRESS_REGEX.test(addr)).toBe(true);
    }
  });

  it("should reject invalid Ethereum addresses", () => {
    const invalidAddresses = [
      "0x742d35",
      "742d35Cc6634C0532925a3b844Bc454e4438f44e",
      "0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
      "",
      "not-an-address",
    ];
    for (const addr of invalidAddresses) {
      expect(ETH_ADDRESS_REGEX.test(addr)).toBe(false);
    }
  });
});
