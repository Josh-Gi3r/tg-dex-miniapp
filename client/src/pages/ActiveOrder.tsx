/**
 * Active Order Page
 *
 * Shows the current state of a P2P fiat order for both the taker and the changer.
 * Displays the correct action buttons based on the user's role and the order status.
 *
 * Order status flow:
 *   escrowed → (taker clicks "I've Paid") → payment_sent → (changer clicks "Payment Received") → completed
 *   escrowed | payment_sent → (either party) → disputed
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { MessageCircle, CheckCircle2, AlertTriangle, Clock, Shield, Star } from "lucide-react";
import { useVenueWallet } from "@/lib/privy/useEmbeddedWallet";
import { runSameTokenSend } from "@/lib/dex/send";
import { resolveToken, toRawAmount } from "@/lib/dex/tokens";

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  escrowed: "Escrow Locked",
  payment_sent: "Payment Sent",
  completed: "Completed",
  disputed: "Disputed",
  resolved: "Resolved",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  escrowed: "bg-blue-100 text-blue-800",
  payment_sent: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  disputed: "bg-red-100 text-red-800",
  resolved: "bg-gray-100 text-gray-800",
  cancelled: "bg-gray-100 text-gray-500",
  refunded: "bg-orange-100 text-orange-800",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="w-4 h-4" />,
  escrowed: <Shield className="w-4 h-4" />,
  payment_sent: <CheckCircle2 className="w-4 h-4" />,
  completed: <CheckCircle2 className="w-4 h-4" />,
  disputed: <AlertTriangle className="w-4 h-4" />,
};

// ─── Rating Dialog ────────────────────────────────────────────────────────────

function RatingDialog({
  orderId,
  open,
  onClose,
}: {
  orderId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [score, setScore] = useState(5);
  const [comment, setComment] = useState("");
  const utils = trpc.useUtils();

  const submitRating = trpc.p2p.submitRating.useMutation({
    onSuccess: () => {
      toast.success("Rating submitted!");
      utils.p2p.getOrder.invalidate({ orderId });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rate Your Trading Partner</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex justify-center gap-2">
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                onClick={() => setScore(s)}
                className={`text-2xl transition-transform hover:scale-110 ${s <= score ? "text-yellow-400" : "text-gray-300"}`}
              >
                <Star className="w-7 h-7 fill-current" />
              </button>
            ))}
          </div>
          <Textarea
            placeholder="Leave a comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Skip</Button>
          <Button
            onClick={() => submitRating.mutate({ orderId, score, comment: comment || undefined })}
            disabled={submitRating.isPending}
          >
            Submit Rating
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dispute Dialog ───────────────────────────────────────────────────────────

function DisputeDialog({
  orderId,
  open,
  onClose,
}: {
  orderId: number;
  open: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const utils = trpc.useUtils();

  const raiseDispute = trpc.p2p.raiseDispute.useMutation({
    onSuccess: () => {
      toast.success("Dispute raised. Admin will review shortly.");
      utils.p2p.getOrder.invalidate({ orderId });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-red-600">Raise a Dispute</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Describe the issue. Our team will review and contact both parties within 24 hours.
          </p>
          <Textarea
            placeholder="e.g. I sent the payment 2 hours ago but the changer has not confirmed..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => raiseDispute.mutate({ orderId, reason })}
            disabled={reason.length < 10 || raiseDispute.isPending}
          >
            Raise Dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface ActiveOrderProps {
  orderId: number;
  onBack: () => void;
}

export default function ActiveOrder({ orderId, onBack }: ActiveOrderProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const venueWallet = useVenueWallet();
  const dexTokensQuery = trpc.dex.tokens.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const venueLiveMode =
    venueWallet.isReady && venueWallet.isAuthenticated && !!venueWallet.address;

  const [showRating, setShowRating] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const messageCounterparty = trpc.p2p.messageCounterparty.useMutation();

  const { data: order, isLoading } = trpc.p2p.getOrder.useQuery(
    { orderId },
    { refetchInterval: 5000 }, // Poll every 5s for status updates
  );

  const markPaid = trpc.p2p.markPaid.useMutation({
    onSuccess: () => {
      toast.success("Payment marked as sent. Waiting for confirmation.");
      utils.p2p.getOrder.invalidate({ orderId });
    },
    onError: (err) => toast.error(err.message),
  });

  const confirmReceived = trpc.p2p.confirmReceived.useMutation({
    onSuccess: () => {
      toast.success("Payment confirmed — settlement processing.");
      utils.p2p.getOrder.invalidate({ orderId });
      setShowRating(true);
    },
    onError: (err) => toast.error(err.message),
  });

  const handleReleaseEscrow = async () => {
    if (!order) return;
    setReleasing(true);
    try {
      let releaseTxHash: string | undefined;
      if (venueLiveMode && order.takerWalletAddress) {
        const tok = resolveToken(order.fromToken, dexTokensQuery.data?.tokens);
        if (!tok) throw new Error(`Token ${order.fromToken} not on the active chain`);
        const result = await runSameTokenSend({
          wallet: venueWallet,
          utils,
          token: tok.address,
          amount: toRawAmount(String(order.fromAmount), tok.decimals),
          to: order.takerWalletAddress,
        });
        releaseTxHash = result.txHash;
      }
      await confirmReceived.mutateAsync({ orderId, releaseTxHash });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Release failed");
    } finally {
      setReleasing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
        <p className="text-muted-foreground">Order not found.</p>
        <Button variant="outline" onClick={onBack}>Back to Home</Button>
      </div>
    );
  }

  const isTaker = order.takerId === user?.id;
  const isChanger = order.changerId === user?.id;
  const status = order.status;
  const isActive = ["escrowed", "payment_sent", "disputed"].includes(status);
  const isCompleted = status === "completed";

  // Determine which Telegram handle to link to
  // (We show "Chat with [other party]" button)
  const chatLabel = isTaker ? "Chat with Changer" : "Chat with Buyer";

  return (
    <div className="min-h-screen bg-background p-4 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          ← Back
        </button>
        <h1 className="text-lg font-semibold">Order #{order.id}</h1>
      </div>

      {/* Status Card */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Order Status</CardTitle>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-100 text-gray-600"}`}>
              {STATUS_ICONS[status]}
              {STATUS_LABELS[status] ?? status}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Trade Summary */}
          <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">You {isTaker ? "buy" : "sell"}</span>
              <span className="font-medium">{order.fromAmount} {order.fromToken}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">You {isTaker ? "pay" : "receive"}</span>
              <span className="font-medium">{order.fiatAmount ?? order.toAmount} {order.fiatCurrency ?? order.toToken}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Rate</span>
              <span className="font-medium">{order.rateUsed}</span>
            </div>
            {order.paymentMethod && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Payment via</span>
                <span className="font-medium">{order.paymentMethod}</span>
              </div>
            )}
          </div>

          {/* Status explanation */}
          {status === "escrowed" && (
            <div className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3">
              {isTaker
                ? "🔒 Escrow is locked. Make your fiat payment and tap \"I've Paid\" when done."
                : "🔒 Escrow is locked. Waiting for the buyer to send fiat payment."}
            </div>
          )}
          {status === "payment_sent" && (
            <div className="text-sm text-purple-700 bg-purple-50 rounded-lg p-3">
              {isTaker
                ? "⏳ Payment marked as sent. Waiting for the changer to confirm receipt."
                : "💸 The buyer has marked their payment as sent. Please check your account and confirm receipt."}
            </div>
          )}
          {status === "disputed" && (
            <div className="text-sm text-red-700 bg-red-50 rounded-lg p-3">
              ⚠️ A dispute has been raised. Our team will review and contact both parties within 24 hours.
              {order.disputeReason && <p className="mt-1 font-medium">Reason: {order.disputeReason}</p>}
            </div>
          )}
          {isCompleted && (
            <div className="text-sm text-green-700 bg-green-50 rounded-lg p-3">
              ✅ Trade completed successfully!
            </div>
          )}
        </CardContent>
      </Card>

      {/* Progress Steps */}
      <Card className="mb-4">
        <CardContent className="pt-4">
          <div className="flex items-center gap-0">
            {[
              { key: "escrowed", label: "Escrowed" },
              { key: "payment_sent", label: "Paid" },
              { key: "completed", label: "Done" },
            ].map((step, i, arr) => {
              const statuses = ["escrowed", "payment_sent", "completed"];
              const currentIdx = statuses.indexOf(status);
              const stepIdx = statuses.indexOf(step.key);
              const isDone = currentIdx >= stepIdx;
              const isDisputed = status === "disputed";
              return (
                <div key={step.key} className="flex items-center flex-1">
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                      isDisputed ? "border-red-400 bg-red-100 text-red-600" :
                      isDone ? "border-primary bg-primary text-primary-foreground" :
                      "border-muted bg-muted text-muted-foreground"
                    }`}>
                      {isDone && !isDisputed ? "✓" : i + 1}
                    </div>
                    <span className="text-xs text-muted-foreground text-center">{step.label}</span>
                  </div>
                  {i < arr.length - 1 && (
                    <div className={`h-0.5 flex-1 mx-1 transition-colors ${
                      isDisputed ? "bg-red-200" :
                      currentIdx > i ? "bg-primary" : "bg-muted"
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="space-y-3">
        {/* Chat on Telegram — always visible while active */}
        {isActive && (
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={() => {
              // Open a real Telegram DM with the counterparty when we know their
              // handle; otherwise tell the user honestly (don't fake it via the bot).
              const handle = (order as { counterpartyTelegram?: string | null }).counterpartyTelegram;
              if (handle) {
                const url = `https://t.me/${handle}`;
                if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url);
                else window.open(url, "_blank");
              } else {
                // No public @username → send via the bot relay (works for everyone).
                setChatOpen(true);
              }
            }}
          >
            <MessageCircle className="w-4 h-4" />
            {chatLabel}
          </Button>
        )}

        {/* In-app message composer — bot delivers it to the counterparty's
            Telegram even when they have no public @username. */}
        <Dialog open={chatOpen} onOpenChange={setChatOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Message the other trader</DialogTitle>
            </DialogHeader>
            <Textarea
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="Type your message — they'll get it in Telegram from @your_bot_username."
              rows={4}
              maxLength={500}
            />
            <DialogFooter>
              <Button
                disabled={!chatText.trim() || messageCounterparty.isPending}
                onClick={async () => {
                  try {
                    const r = await messageCounterparty.mutateAsync({ orderId, text: chatText.trim() });
                    if (r.delivered) {
                      toast.success("Message sent — they'll see it in Telegram.");
                      setChatText("");
                      setChatOpen(false);
                    } else if (r.reason === "no_chat") {
                      toast.info("They haven't opened the bot yet, so we can't message them. Try again once they're active.");
                    } else {
                      toast.error("Couldn't deliver the message. Try again.");
                    }
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Couldn't send the message.");
                  }
                }}
              >
                {messageCounterparty.isPending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Taker: I've Paid button */}
        {isTaker && status === "escrowed" && (
          <Button
            className="w-full bg-primary text-primary-foreground gap-2"
            onClick={() => markPaid.mutate({ orderId })}
            disabled={markPaid.isPending}
          >
            {markPaid.isPending ? "Sending..." : "✅ I've Paid"}
          </Button>
        )}

        {/* Changer: Payment Received button */}
        {isChanger && status === "payment_sent" && (
          <Button
            className="w-full bg-green-600 hover:bg-green-700 text-white gap-2"
            onClick={handleReleaseEscrow}
            disabled={releasing || confirmReceived.isPending}
          >
            {releasing
              ? (venueLiveMode ? "Signing release tx…" : "Confirming…")
              : "✅ Payment Received — Release Escrow"}
          </Button>
        )}

        {/* Raise Dispute — available to both parties when active */}
        {isActive && status !== "disputed" && (
          <Button
            variant="outline"
            className="w-full text-red-600 border-red-200 hover:bg-red-50 gap-2"
            onClick={() => setShowDispute(true)}
          >
            <AlertTriangle className="w-4 h-4" />
            Raise Dispute
          </Button>
        )}

        {/* Rate trading partner — after completion */}
        {isCompleted && (
          <>
            {isTaker && !order.isRatedByTaker && (
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setShowRating(true)}
              >
                <Star className="w-4 h-4" />
                Rate Your Trading Partner
              </Button>
            )}
            {isChanger && !order.isRatedByChanger && (
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setShowRating(true)}
              >
                <Star className="w-4 h-4" />
                Rate Your Trading Partner
              </Button>
            )}
          </>
        )}
      </div>

      {/* Dialogs */}
      <RatingDialog orderId={orderId} open={showRating} onClose={() => setShowRating(false)} />
      <DisputeDialog orderId={orderId} open={showDispute} onClose={() => setShowDispute(false)} />
    </div>
  );
}
