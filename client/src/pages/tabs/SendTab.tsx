import { useState } from "react";
import { SUPPORTED_TOKENS, type TokenSymbol } from "@shared/venue-config";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import TokenPickerSheet from "@/components/TokenPickerSheet";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { SuccessModal } from "@/components/SuccessModal";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { InfoChip } from "@/components/onboarding/InfoChip";
import { useVenueWallet } from "@/lib/privy/useEmbeddedWallet";
import { runSameTokenSend, runCrossTokenSend } from "@/lib/dex/send";
import { resolveToken, toRawAmount } from "@/lib/dex/tokens";

const CURRENCY_FLAG: Record<string, string> = {
  SGD: "🇸🇬", MYR: "🇲🇾", IDR: "🇮🇩", USD: "💵",
};

// Rates come from live trpc.swap.getRate per pair — no hardcoded fallback.
// Same-token send always 1:1.

function formatAmount(amount: number, token: TokenSymbol): string {
  const isIDR = ["IDRX", "IDRT", "XIDR"].includes(token);
  if (isIDR) return amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return amount.toFixed(4);
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr) || /^@[a-zA-Z0-9_]{3,32}$/.test(addr);
}

export default function SendTab() {
  const { haptic } = useTelegram();

  const [sendToken, setSendToken] = useState<string>("USDT");
  const [receiveToken, setReceiveToken] = useState<string>("USDT");
  const [amount, setAmount] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [note, setNote] = useState("");
  const [showSendPicker, setShowSendPicker] = useState(false);
  const [showReceiveExpanded, setShowReceiveExpanded] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [claimLink, setClaimLink] = useState("");
  const [lastSend, setLastSend] = useState<{ amount: string; token: string; to: string; received?: string; receiveToken?: string } | null>(null);

  // Live-mode plumbing (Privy + the venue)
  const venueWallet = useVenueWallet();
  const trpcUtils = trpc.useUtils();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;

  // Real balances (replaces the old hardcoded "100"). Best-effort: when no
  // wallet/creds the balance is unknown and we simply don't gate on it.
  const balancesQuery = trpc.dex.balances.useQuery(undefined, { staleTime: 30_000, retry: false });
  const utils = trpc.useUtils();
  const createClaimMutation = trpc.send.createClaim.useMutation();
  // REAL server-signed send (imported wallet) — replaces the disabled Privy path.
  const sendTokenMut = trpc.dex.sendToken.useMutation();
  const swapManagedMut = trpc.dex.swapManaged.useMutation();
  const { blockIfDemo } = useDemoGate();
  const sendBalance = (() => {
    const b = (balancesQuery.data?.balances as any[] | undefined)?.find((x) => x.symbol === sendToken);
    if (!b) return null;
    const dec = b.decimals ?? 6;
    return (Number(b.wallet_balance) + Number(b.vault_available)) / 10 ** dec;
  })();

  const isCrossToken = sendToken !== receiveToken;
  // Live rate for the cross-token pair. Same-token: 1:1, no query.
  const crossRateQuery = trpc.swap.getRate.useQuery(
    { from: sendToken, to: receiveToken },
    { enabled: isCrossToken, staleTime: 15_000, retry: false },
  );
  const rate = isCrossToken ? (crossRateQuery.data?.rate ?? 0) : 1;
  const rateLoaded = !isCrossToken || crossRateQuery.data?.rate !== undefined;
  const parsedAmount = parseFloat(amount) || 0;
  const estimatedReceive = parsedAmount > 0 && rateLoaded
    ? formatAmount(parsedAmount * rate, receiveToken as TokenSymbol)
    : "";
  // Static map provides display name + flag (stable for the SEA corridor v1).
  // Live the venue /tokens query is exposed separately for trading paths that need
  // current address/decimals — already used by lib/dex/send.ts via resolveToken.
  const liveTokens = dexTokensQuery.data?.tokens ?? null;
  const toInfo = SUPPORTED_TOKENS[receiveToken as TokenSymbol];
  const fromInfo = SUPPORTED_TOKENS[sendToken as TokenSymbol];
  // Mark unused — kept available for future live-token-driven UI gating.
  void liveTokens;

  const addressValid = isValidAddress(recipientAddress);
  const canSend = parsedAmount > 0 && addressValid;

  const handleSelectSend = (token: string) => {
    if (receiveToken === sendToken) setReceiveToken(token);
    setSendToken(token);
    setShowSendPicker(false);
  };

  const handleSelectReceive = (token: TokenSymbol) => {
    if (token === sendToken) setSendToken(receiveToken);
    setReceiveToken(token);
    setShowReceiveExpanded(false);
  };

  const handleReview = () => {
    if (blockIfDemo("Send")) return;
    if (!amount || parsedAmount <= 0) { toast.error("Enter an amount to send"); return; }
    if (recipientAddress.startsWith("0x") && sendBalance != null && parsedAmount > sendBalance) {
      toast.error(`Not enough ${sendToken}. You have ${sendBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`); return;
    }
    if (!addressValid) { toast.error("Enter a valid wallet address (0x…) or @telegram handle"); return; }
    haptic.impact("medium");
    setShowConfirm(true);
  };

  const handleConfirm = async () => {
    setIsSending(true);
    try {
      const shortTo = recipientAddress.length > 20
        ? `${recipientAddress.slice(0, 10)}...${recipientAddress.slice(-6)}`
        : recipientAddress;

      // Telegram-handle recipient. First try to resolve @username → a app user
      // with a wallet: if found, send DIRECT to their wallet (real on-chain).
      // Otherwise fall back to a shareable claim link (no funds move until they
      // open it + claim). Never fabricate a tx hash.
      if (recipientAddress.startsWith("@")) {
        const resolved = await utils.send.resolveRecipient.fetch({ handle: recipientAddress });
        if (resolved.found && resolved.walletAddress) {
          // Known funded user → direct send straight to their wallet.
          let hash = "";
          if (isCrossToken) {
            await swapManagedMut.mutateAsync({
              fromToken: sendToken, toToken: receiveToken, amount: parsedAmount, recipient: resolved.walletAddress,
            });
          } else {
            const r = await sendTokenMut.mutateAsync({ token: sendToken, to: resolved.walletAddress, amount: parsedAmount });
            hash = r.txHash ?? "";
          }
          setClaimLink("");
          setTxHash(hash);
          setLastSend({
            amount, token: sendToken, to: resolved.displayName ?? recipientAddress,
            received: isCrossToken ? estimatedReceive : undefined,
            receiveToken: isCrossToken ? receiveToken : undefined,
          });
          setShowConfirm(false);
          haptic.notification("success");
          setShowSuccess(true);
          return;
        }
        // Not a known funded user → shareable claim link.
        const claim = await createClaimMutation.mutateAsync({
          fromToken: sendToken,
          toToken: receiveToken,
          fromAmount: amount,
          estimatedToAmount: isCrossToken ? String(parsedAmount * rate) : amount,
          message: note || undefined,
        });
        setClaimLink(claim.claimUrl);
        setTxHash("");
        setLastSend({
          amount, token: sendToken, to: recipientAddress,
          received: isCrossToken ? estimatedReceive : undefined,
          receiveToken: isCrossToken ? receiveToken : undefined,
        });
        setShowConfirm(false);
        haptic.notification("success");
        setShowSuccess(true);
        return;
      }

      // 0x recipient → REAL on-chain send, SERVER-SIGNED with the user's imported
      // wallet (Privy is off; this is the same path the P2P burst uses). If they
      // haven't imported a wallet, the server returns a clear "Import first" error.
      let hash = "";
      if (isCrossToken) {
        // Cross-token: a swap that delivers the output to the recipient.
        const r = await swapManagedMut.mutateAsync({
          fromToken: sendToken, toToken: receiveToken, amount: parsedAmount, recipient: recipientAddress,
        });
        hash = ""; // swap settles asynchronously; reference is the trade id
        void r;
      } else {
        const r = await sendTokenMut.mutateAsync({ token: sendToken, to: recipientAddress, amount: parsedAmount });
        hash = r.txHash ?? "";
      }
      setClaimLink("");
      setTxHash(hash);
      setLastSend({
        amount, token: sendToken, to: shortTo,
        received: isCrossToken ? estimatedReceive : undefined,
        receiveToken: isCrossToken ? receiveToken : undefined,
      });
      setShowConfirm(false);
      haptic.notification("success");
      setShowSuccess(true);
    } catch (err) {
      haptic.notification("error");
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setIsSending(false);
    }
  };

  const handleReset = () => {
    setAmount("");
    setRecipientAddress("");
    setNote("");
    setShowReceiveExpanded(false);
    setShowSuccess(false);
    setLastSend(null);
    setTxHash("");
    setClaimLink("");
  };

  const shortAddr = recipientAddress.length > 20
    ? `${recipientAddress.slice(0, 10)}...${recipientAddress.slice(-6)}`
    : recipientAddress;

  return (
    <div className="tab-page">

      <div
        className="page-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div className="page-title">Send</div>
          <div className="page-subtitle">Wallet-to-wallet · On-chain via the venue · No banks</div>
        </div>
        <InfoChip topic="send" compact />
      </div>

      <div className="tab-content">

        {/* RECIPIENT ADDRESS */}
        <div>
          <div className="section-header">
            <span className="section-title">RECIPIENT ADDRESS</span>
          </div>
          <div className="glass-card-elevated" style={{ padding: 16 }}>
            <div data-tour="send-recipient" style={{ position: "relative" }}>
              <input
                type="text"
                placeholder="0x… wallet address or @telegram"
                value={recipientAddress}
                onChange={(e) => setRecipientAddress(e.target.value)}
                style={{
                  width: "100%", padding: "12px 40px 12px 14px",
                  background: "rgba(118,118,128,0.10)", border: "none",
                  borderRadius: 10, fontSize: 15, color: "#1C1C1E",
                  outline: "none", fontFamily: "monospace",
                  boxShadow: recipientAddress && addressValid
                    ? "0 0 0 2px rgba(0,200,150,0.30)"
                    : recipientAddress && !addressValid
                      ? "0 0 0 2px rgba(255,59,48,0.30)"
                      : "none",
                  transition: "box-shadow 0.15s ease",
                }}
              />
              {recipientAddress && addressValid && (
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "#00C896", fontSize: 16 }}>✓</span>
              )}
              {recipientAddress && !addressValid && (
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "#FF3B30", fontSize: 16 }}>✗</span>
              )}
            </div>
            {recipientAddress && !addressValid && (
              <div style={{ fontSize: 12, color: "#FF3B30", marginTop: 6 }}>Enter a valid 0x address or @telegram handle</div>
            )}
          </div>
        </div>

        {/* YOU SEND */}
        <div>
          <div className="section-header">
            <span className="section-title">YOU SEND</span>
            <button
              onClick={() => { haptic.impact("light"); if (sendBalance != null) setAmount(String(sendBalance)); }}
              style={{ fontSize: 12, color: "#00C896", fontWeight: 600, background: "none", border: "none", cursor: "pointer" }}
            >
              {sendBalance != null ? `Balance: ${sendBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} · MAX` : "MAX"}
            </button>
          </div>
          <div className="glass-card-elevated" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number" inputMode="decimal" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                style={{
                  flex: 1, border: "none", outline: "none", background: "transparent",
                  fontSize: 38, fontWeight: 700, color: amount ? "#1C1C1E" : "#C7C7CC",
                  letterSpacing: "-0.03em", minWidth: 0, lineHeight: 1, fontFamily: "inherit",
                }}
              />
              <button
                onClick={() => { haptic.impact("light"); setShowSendPicker(true); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "rgba(118,118,128,0.12)", border: "none",
                  borderRadius: 20, padding: "8px 12px 8px 10px",
                  cursor: "pointer", flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 20 }}>{CURRENCY_FLAG[fromInfo.currency]}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{sendToken}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 3.5L5 6.5L8 3.5" stroke="#8E8E93" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#AEAEB2", marginTop: 6 }}>{fromInfo.name}</div>
          </div>
        </div>

        {/* RECIPIENT RECEIVES */}
        <div>
          <div className="section-header">
            <span className="section-title">RECIPIENT RECEIVES</span>
            <button
              onClick={() => { haptic.impact("light"); setShowReceiveExpanded(!showReceiveExpanded); }}
              style={{ fontSize: 12, color: "#00C896", fontWeight: 600, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
            >
              {isCrossToken ? `Receiving ${receiveToken}` : "Convert on arrival?"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: showReceiveExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s ease" }}>
                <path d="M2 4l4 4 4-4" stroke="#00C896" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div className="glass-card-elevated" style={{ overflow: "hidden" }}>
            <div style={{ padding: "16px 16px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{
                  flex: 1, fontSize: 38, fontWeight: 700, letterSpacing: "-0.03em",
                  color: estimatedReceive ? "#00C896" : "#C7C7CC", lineHeight: 1, minWidth: 0,
                }}>
                  {estimatedReceive || "0.00"}
                </div>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "rgba(118,118,128,0.12)", borderRadius: 20, padding: "8px 12px 8px 10px",
                }}>
                  <span style={{ fontSize: 20 }}>{CURRENCY_FLAG[toInfo.currency]}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#1C1C1E" }}>{receiveToken}</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#AEAEB2", marginTop: 6 }}>
                {isCrossToken
                  ? `1 ${sendToken} = ${rate.toFixed(4)} ${receiveToken} · the venue atomic swap`
                  : `Same token · No conversion needed`}
              </div>
            </div>
            {showReceiveExpanded && (
              <div style={{ borderTop: "0.5px solid rgba(60,60,67,0.10)", padding: "14px 16px", background: "rgba(0,200,150,0.03)" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", marginBottom: 10 }}>SELECT RECEIVE TOKEN</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(Object.keys(SUPPORTED_TOKENS) as TokenSymbol[]).map((tok) => {
                    const info = SUPPORTED_TOKENS[tok];
                    const isSelected = tok === receiveToken;
                    return (
                      <button
                        key={tok}
                        onClick={() => handleSelectReceive(tok)}
                        style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "7px 12px",
                          background: isSelected ? "rgba(0,200,150,0.12)" : "rgba(255,255,255,0.72)",
                          backdropFilter: "blur(12px)",
                          border: `0.5px solid ${isSelected ? "rgba(0,200,150,0.40)" : "rgba(60,60,67,0.15)"}`,
                          borderRadius: 20,
                          color: isSelected ? "#00C896" : "#3C3C43",
                          fontSize: 13, fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{CURRENCY_FLAG[info.currency]}</span>
                        {tok}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Note */}
        <div>
          <div className="section-header">
            <span className="section-title">NOTE (OPTIONAL)</span>
          </div>
          <div className="glass-card-elevated" style={{ padding: 16 }}>
            <textarea
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Add a memo for this transaction…"
              maxLength={140} rows={2}
              style={{
                width: "100%", padding: "10px 12px",
                background: "rgba(118,118,128,0.10)", border: "none",
                borderRadius: 10, fontSize: 15, color: "#1C1C1E",
                outline: "none", resize: "none", lineHeight: 1.5,
                fontFamily: "inherit",
              }}
            />
            <div style={{ textAlign: "right", fontSize: 11, color: "#AEAEB2", marginTop: 4 }}>{note.length}/140</div>
          </div>
        </div>

        {/* CTA */}
        <button onClick={handleReview} className="btn-primary" disabled={!canSend}>
          {parsedAmount <= 0
            ? "Enter Amount"
            : !addressValid
              ? "Enter Recipient Address"
              : `Review Send ${amount} ${sendToken} →`}
        </button>

        {/* How it works */}
        <div className="glass-card" style={{ padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#8E8E93", marginBottom: 12, letterSpacing: "0.02em" }}>HOW IT WORKS</div>
          {[
            { n: "1", t: "Enter the recipient's wallet address (0x…) or @telegram handle" },
            { n: "2", t: "Choose how much to send and in which token" },
            { n: "3", t: 'Tap "Convert on arrival?" if the recipient wants a different token' },
            { n: "4", t: "the settlement venue executes an atomic swap and delivers tokens directly to their wallet" },
          ].map(({ n, t }) => (
            <div key={n} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
              <div style={{
                width: 22, height: 22, background: "rgba(0,200,150,0.12)", border: "0.5px solid rgba(0,200,150,0.35)",
                borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700, flexShrink: 0, color: "#00C896",
              }}>{n}</div>
              <span style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.55 }}>{t}</span>
            </div>
          ))}
        </div>

      </div>

      {/* Confirm Sheet */}
      <ConfirmSheet
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirm}
        loading={isSending}
        title="Confirm Send"
        emoji="📤"
        subtitle={recipientAddress.startsWith("@")
          ? "We'll create a claim link. The person you send to gets it in Telegram and connects a wallet to receive."
          : "We'll send this on-chain through the venue, signed with your imported wallet."}
        confirmLabel={isSending ? "Broadcasting…" : `Send ${amount} ${sendToken}`}
        details={[
          { label: "You send",          value: `${amount} ${sendToken}` },
          { label: "Recipient receives", value: isCrossToken ? `~${estimatedReceive} ${receiveToken}` : `${amount} ${sendToken}`, highlight: true },
          { label: "To",                value: shortAddr },
          { label: "Network fee",       value: "On-chain gas (Sepolia)" },
          ...(isCrossToken ? [{ label: "Swap fee", value: "0.05%" }] : []),
          ...(note ? [{ label: "Note", value: `"${note}"` }] : []),
        ]}
      />

      {/* Success Modal */}
      <SuccessModal
        open={showSuccess}
        onClose={handleReset}
        title={claimLink ? "Claim Link Ready" : "Send submitted"}
        subtitle={!lastSend ? "" : claimLink
          ? `Share this link with ${lastSend.to}. They get ${lastSend.amount} ${lastSend.token} when they open it and connect a wallet.`
          : `${lastSend.amount} ${lastSend.token} sent on-chain to ${lastSend.to} via the venue.`}
        emoji={claimLink ? "🔗" : "📤"}
        details={claimLink
          ? [
              { label: "You send",   value: lastSend ? `${lastSend.amount} ${lastSend.token}` : "" },
              ...(lastSend?.received ? [{ label: "They get", value: `~${lastSend.received} ${lastSend.receiveToken}` }] : []),
              { label: "Claim link", value: claimLink },
              { label: "Status",     value: "Waiting for them to claim" },
            ]
          : [
              { label: "You sent",   value: lastSend ? `${lastSend.amount} ${lastSend.token}` : "" },
              ...(lastSend?.received ? [{ label: "They get", value: `~${lastSend.received} ${lastSend.receiveToken}` }] : []),
              ...(txHash ? [{ label: "TX Hash", value: txHash }] : []),
              { label: "Status",     value: lastSend?.received ? "Submitted — converting on the venue" : "Submitted — settling on Sepolia" },
            ]}
        ctaLabel={claimLink ? "Copy & Share Link" : "Send Another"}
        onCta={claimLink
          ? () => { try { void navigator.clipboard?.writeText(claimLink); } catch { /* ignore */ } toast.success("Claim link copied"); handleReset(); }
          : handleReset}
      />

      <TokenPickerSheet open={showSendPicker} onClose={() => setShowSendPicker(false)} selected={sendToken} excluded={receiveToken} onSelect={handleSelectSend} />
    </div>
  );
}
