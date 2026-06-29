import { useRef, useEffect } from "react";
import { SUPPORTED_TOKENS, TESTNET_TRADEABLE_SYMBOLS } from "@shared/venue-config";
import { useTelegram } from "@/contexts/TelegramContext";
import { trpc } from "@/lib/trpc";
import { resolveToken } from "@/lib/dex/tokens";

const CURRENCY_FLAG: Record<string, string> = {
  SGD: "🇸🇬",
  MYR: "🇲🇾",
  IDR: "🇮🇩",
  USD: "💵",
  JPY: "🇯🇵",
  EUR: "🇪🇺",
};

interface Props {
  open: boolean;
  onClose: () => void;
  selected: string;
  excluded: string;
  onSelect: (token: string) => void;
  /**
   * The tokens to offer. Default = the funded testnet set (for the maker side).
   * The Swap passes the LIVE order-book token set (every token with a funded
   * resting order) so it's not capped to a hardcoded list.
   */
  tokens?: readonly string[];
}

export default function TokenPickerSheet({ open, onClose, selected, excluded, onSelect, tokens }: Props) {
  const PICKER_TOKENS = tokens && tokens.length > 0 ? tokens : TESTNET_TRADEABLE_SYMBOLS;
  const { haptic } = useTelegram();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Live token metadata from the venue /tokens. Falls back to static SUPPORTED_TOKENS
  // when the query is loading or unreachable (see lib/dex/tokens.ts resolveToken).
  const liveTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 5 * 60_000, // 5 min — token metadata rarely changes
    refetchOnWindowFocus: false,
  });
  const liveTokens = liveTokensQuery.data?.tokens ?? null;

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="bottom-sheet-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={sheetRef}
        className="bottom-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="bottom-sheet-handle" />

        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 20px 14px",
          borderBottom: "1.5px solid #0A0A0A",
        }}>
          <h2 style={{
            fontFamily: "Space Grotesk, sans-serif",
            fontSize: 18,
            fontWeight: 800,
            color: "#0A0A0A",
            margin: 0,
            letterSpacing: "-0.02em",
          }}>
            Select Token
          </h2>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#F5F5F0",
              border: "1.5px solid #0A0A0A",
              cursor: "pointer",
              fontSize: 16,
              color: "#0A0A0A",
            }}
          >
            ✕
          </button>
        </div>

        {/* Tradeable tokens — flat list (no fiat-corridor grouping) */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {PICKER_TOKENS.map((symbol) => {
            // Prefer live token metadata; fall back to static map.
            const resolved = resolveToken(symbol, liveTokens);
            const token = resolved ?? SUPPORTED_TOKENS[symbol as keyof typeof SUPPORTED_TOKENS];
            if (!token) return null;
            const tokenName = ("name" in token ? token.name : symbol) as string;
            const isSelected = symbol === selected;
            const isExcluded = symbol === excluded;

            return (
              <button
                key={symbol}
                disabled={isExcluded}
                onClick={() => {
                  haptic.impact("light");
                  onSelect(symbol);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 20px",
                  borderBottom: "1px solid #F0F0EC",
                  background: isSelected ? "rgba(0,200,150,0.06)" : "#FFFFFF",
                  borderLeft: isSelected ? "3px solid #00C896" : "3px solid transparent",
                  opacity: isExcluded ? 0.4 : 1,
                  cursor: isExcluded ? "not-allowed" : "pointer",
                  textAlign: "left",
                  transition: "background 0.1s ease",
                }}
              >
                {/* Token icon */}
                <div style={{
                  width: 44,
                  height: 44,
                  background: isSelected ? "rgba(0,200,150,0.10)" : "#F5F5F0",
                  border: `1.5px solid ${isSelected ? "#00C896" : "#E8E8E2"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                  flexShrink: 0,
                }}>
                  {CURRENCY_FLAG[token.currency] ?? "🪙"}
                </div>

                {/* Token info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "Space Grotesk, sans-serif",
                    fontSize: 16,
                    fontWeight: 800,
                    color: "#0A0A0A",
                    letterSpacing: "-0.01em",
                  }}>
                    {symbol}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: "#9EA1A4",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {tokenName}
                  </div>
                </div>

                {/* Right side */}
                {isSelected && (
                  <div style={{
                    width: 22,
                    height: 22,
                    background: "#00C896",
                    border: "1.5px solid #0A0A0A",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontSize: 12,
                    color: "#0A0A0A",
                    fontWeight: 800,
                  }}>
                    ✓
                  </div>
                )}
                {isExcluded && !isSelected && (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#9EA1A4",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    flexShrink: 0,
                  }}>
                    IN USE
                  </span>
                )}
              </button>
            );
          })}
          <div style={{ height: 24 }} />
        </div>
      </div>
    </div>
  );
}
