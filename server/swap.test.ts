import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user-123",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "demo",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };

  return { ctx };
}

describe("swap router", () => {
  it("returns supported tokens list", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.swap.getSupportedTokens();

    expect(result.tokens).toBeDefined();
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.tokens[0]).toHaveProperty("symbol");
    expect(result.tokens[0]).toHaveProperty("name");
    expect(result.tokens[0]).toHaveProperty("currency");
  }, 15_000); // live venue API call — allow up to 15s

  it("registers a wallet address", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.swap.registerWallet({
      walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    });

    expect(result.success).toBe(true);
  });

  it("records a swap transaction", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.swap.recordSwap({
      fromToken: "USDT",
      toToken: "XSGD",
      fromAmount: "100",
      toAmount: "134.50",
      valueUsd: "100",
      type: "swap",
    });

    expect(result.success).toBe(true);
  });

  it("retrieves transaction history", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.swap.getHistory({ limit: 10 });

    expect(Array.isArray(result)).toBe(true);
  });
});
