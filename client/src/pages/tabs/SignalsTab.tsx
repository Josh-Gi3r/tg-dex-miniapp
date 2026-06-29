/**
 * Assistant tab — the in-app the app helper (Douglas's ask).
 *
 * A grounded chat assistant: the server builds context from the user's live
 * vault balances, the app mids, and (inside a shop) the changer's offers, then
 * relays to the configured LLM. Education + state-grounding, NOT a "buy now"
 * signal engine. The model key is wired server-side and dropped in later;
 * until then the UI is fully built and says so honestly.
 *
 * (File name kept as SignalsTab for the existing nav wiring; the surface is
 *  the Assistant. The old stub signal feed + "coming soon" roadmap are gone.)
 */

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useTelegram } from "@/contexts/TelegramContext";
import { useDemoGate } from "@/contexts/DemoGate";
import { toast } from "sonner";

type NavTarget = "swap" | "send" | "p2p" | "signals" | "quests" | "news" | "me";

interface SignalsTabProps {
  onNavigate?: (tab: NavTarget) => void;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

const STARTERS = [
  "How do my balances look right now?",
  "Which shop gives me the best rate for SGD?",
  "Is now a good time to swap USDT to XSGD?",
  "Explain how trading on the venue works, in simple words.",
];

// Persist the conversation so switching tabs (which unmounts this component)
// or reloading does NOT wipe it. Cleared only when the user taps "Clear".
const CHAT_STORAGE_KEY = "app_assistant_chat_v1";

// Plain-language list of what the assistant can do — shown in the empty state.
const HELP_POINTS = [
  "💰 Check your balances and what they mean",
  "📊 Tell you the live rates and which shop is best",
  "🤔 Help you decide when and what to swap (I never just say 'buy')",
  "📚 Explain anything about the venue in simple words",
];

export default function SignalsTab(_props: SignalsTabProps = {}) {
  const { haptic } = useTelegram();
  const providerStatus = trpc.assistant.providerStatus.useQuery();
  const liveBoard = trpc.dex.liveBoard.useQuery(undefined, { staleTime: 60_000, refetchInterval: 60_000, retry: false });
  const chat = trpc.assistant.chat.useMutation();
  // Load any saved conversation so a tab switch / reload doesn't erase it.
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { blockIfDemo } = useDemoGate();

  const connected = providerStatus.data?.ready ?? false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chat.isPending]);

  // Persist on every change (keep the last 50 turns) so it survives unmount.
  useEffect(() => {
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-50))); } catch { /* ignore */ }
  }, [messages]);

  const clearChat = () => {
    haptic.impact("medium");
    setMessages([]);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* ignore */ }
  };

  const send = async (text: string) => {
    if (blockIfDemo("The assistant")) return;
    const content = text.trim();
    if (!content || chat.isPending) return;
    haptic.impact("light");
    const next: ChatMsg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    try {
      const res = await chat.mutateAsync({ messages: next });
      setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
    } catch (err: any) {
      const msg: string = err?.message ?? "Assistant unavailable";
      if (/no llm api key|unavailable/i.test(msg)) {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content:
              "My AI isn't switched on yet, so I can't chat right now. But I can already see your balances, the live rates, and the shop offers. Once it's on, I'll answer using your real numbers.",
          },
        ]);
      } else {
        toast.error(msg);
        setMessages((m) => m.slice(0, -1)); // roll back the unsent user line
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0B0E11" }}>
      {/* Header */}
      <div style={{ padding: "16px 18px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="page-title" style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>Assistant</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                style={{
                  fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
                  color: "#AEAEB2", background: "rgba(118,118,128,0.15)",
                  border: "none", cursor: "pointer",
                }}
              >
                Clear
              </button>
            )}
            <span
              style={{
                fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 999,
                color: connected ? "#00C896" : "#AEAEB2",
                background: connected ? "rgba(0,200,150,0.12)" : "rgba(118,118,128,0.15)",
              }}
            >
              {connected ? `● ${providerStatus.data?.provider ?? "online"}` : "○ offline"}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: "#8E8E93", marginTop: 4 }}>
          I can see your balances, the live rates, and shop offers. I help you understand and decide — I never tell you to buy.
        </div>
      </div>

      {/* Live the venue orders — horizontal scroller */}
      {(() => {
        const dirs = (liveBoard.data?.directions ?? []).filter((d: any) => d.live && d.rate);
        if (dirs.length === 0) return null;
        return (
          <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "10px 0 10px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#00C896", marginBottom: 6, letterSpacing: "0.04em" }}>LIVE</div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingRight: 16 }}>
              {dirs.map((d: any) => (
                <button
                  key={`${d.from}-${d.to}`}
                  onClick={() => send(`Tell me about the ${d.from} to ${d.to} rate right now.`)}
                  style={{ flex: "0 0 auto", textAlign: "left", padding: "8px 11px", borderRadius: 11, background: "rgba(0,200,150,0.07)", border: "1px solid rgba(0,200,150,0.18)", cursor: "pointer" }}
                >
                  <div style={{ fontSize: 11, color: "#8E8E93", fontWeight: 600 }}>{d.from} → {d.to}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", marginTop: 1 }}>
                    {d.rate < 0.01 ? d.rate.toExponential(2) : d.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
        {messages.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 2 }}>Here's how I can help</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              {HELP_POINTS.map((h) => (
                <div key={h} style={{ fontSize: 13, color: "#C7C7CC" }}>{h}</div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 2 }}>Try asking:</div>
            {STARTERS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                style={{
                  textAlign: "left", padding: "12px 14px", borderRadius: 12,
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
                  color: "#E5E5EA", fontSize: 13.5, cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 10,
            }}
          >
            <div
              style={{
                maxWidth: "82%", padding: "10px 13px", borderRadius: 14, fontSize: 13.5, lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                background: m.role === "user" ? "linear-gradient(135deg,#00C896,#00A87A)" : "rgba(255,255,255,0.06)",
                color: m.role === "user" ? "#fff" : "#E5E5EA",
                borderBottomRightRadius: m.role === "user" ? 4 : 14,
                borderBottomLeftRadius: m.role === "user" ? 14 : 4,
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {chat.isPending && (
          <div style={{ color: "#8E8E93", fontSize: 13, fontStyle: "italic" }}>thinking…</div>
        )}
      </div>

      {/* Composer */}
      <div style={{ padding: "10px 14px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
          placeholder="Ask about your vault, rates, a shop…"
          style={{
            flex: 1, padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.05)", color: "#fff", fontSize: 14, outline: "none",
          }}
        />
        <button
          onClick={() => send(input)}
          disabled={chat.isPending || !input.trim()}
          style={{
            padding: "0 18px", borderRadius: 12, border: "none",
            background: input.trim() ? "linear-gradient(135deg,#00C896,#00A87A)" : "rgba(118,118,128,0.15)",
            color: input.trim() ? "#fff" : "#AEAEB2", fontWeight: 700, fontSize: 14,
            cursor: input.trim() ? "pointer" : "default",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
