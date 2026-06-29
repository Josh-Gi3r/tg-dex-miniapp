/**
 * ─── History Tab ──────────────────────────────────────────────────────────────
 *
 * Displays the user's swap and send transaction history.
 * Wallets are auto-generated server-side on first login, so all authenticated
 * users always have a wallet -- the "no wallet" empty state is removed.
 */

import { trpc } from "@/lib/trpc";
import { ArrowRight, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { formatDate, getExplorerUrl } from "@/lib/format";

const STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  failed:    <XCircle      className="w-4 h-4 text-red-500" />,
  pending:   <Loader2      className="w-4 h-4 text-muted-foreground animate-spin" />,
  claiming:  <Loader2      className="w-4 h-4 text-primary animate-spin" />,
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  failed:    "Failed",
  pending:   "Pending",
  claiming:  "Claiming",
};

export default function HistoryTab() {
  const { data: history, isLoading } = trpc.swap.getHistory.useQuery({ limit: 50 });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold">History</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Your swap transactions</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : !history || history.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 px-8 text-center">
            <div
              className="w-14 h-14 border-2 border-black flex items-center justify-center"
              style={{ boxShadow: "3px 3px 0 #000" }}
            >
              <Clock className="w-7 h-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-bold mb-1">No transactions yet</p>
              <p className="text-sm text-muted-foreground">Your swaps will appear here</p>
            </div>
          </div>
        ) : (
          <div className="px-4 space-y-3 pb-4">
            {history.map((tx: any) => (
              <div
                key={tx.id}
                className="border border-black bg-white p-4"
                style={{ boxShadow: "2px 2px 0 #000" }}
              >
                {/* Token pair + status */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-bold text-sm">{tx.fromToken}</span>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                  <span className="font-bold text-sm">{tx.toToken}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {STATUS_ICON[tx.status as string] ?? null}
                    <span className="text-xs text-muted-foreground">
                      {STATUS_LABEL[tx.status as string] ?? tx.status}
                    </span>
                  </div>
                </div>

                {/* Amounts */}
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Sent</p>
                    <p className="font-bold">{tx.fromAmount}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  <div className="text-right">
                    <p className="text-muted-foreground text-xs">Received</p>
                    <p className="font-bold">{tx.toAmount}</p>
                  </div>
                </div>

                {/* Timestamp + explorer link */}
                <div className="mt-3 pt-3 border-t border-black/10 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {formatDate(tx.createdAt)}
                  </span>
                  {tx.txHash && /^0x[0-9a-fA-F]{64}$/.test(tx.txHash) && (
                    <a
                      href={getExplorerUrl(tx.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary underline"
                    >
                      View on Etherscan
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
