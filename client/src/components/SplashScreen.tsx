import { useEffect, useState } from "react";

const APP_LOGO = import.meta.env.VITE_APP_LOGO_URL ?? "";

interface SplashScreenProps {
  onComplete: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"enter" | "hold" | "exit">("enter");

  useEffect(() => {
    // Progress bar animation: 0 → 100 over 2.2s
    const start = performance.now();
    const duration = 2200;

    const tick = (now: number) => {
      const elapsed = now - start;
      const pct = Math.min((elapsed / duration) * 100, 100);
      setProgress(pct);
      if (pct < 100) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);

    // Phase transitions
    const holdTimer = setTimeout(() => setPhase("hold"), 400);
    const exitTimer = setTimeout(() => setPhase("exit"), 2300);
    const doneTimer = setTimeout(() => onComplete(), 2800);

    return () => {
      clearTimeout(holdTimer);
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [onComplete]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#FFFFFF",
        transition: "opacity 0.5s ease",
        opacity: phase === "exit" ? 0 : 1,
        pointerEvents: phase === "exit" ? "none" : "all",
      }}
    >
      {/* Background subtle radial glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 60% 40% at 50% 50%, rgba(0,200,150,0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Animated ring behind logo */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 32,
        }}
      >
        {/* Pulsing ring */}
        <div style={{ position: "relative", width: 120, height: 120 }}>
          {/* Outer pulse ring */}
          <div
            style={{
              position: "absolute",
              inset: -12,
              borderRadius: "50%",
              border: "2px solid rgba(0,200,150,0.25)",
              animation: "splash-pulse 1.8s ease-in-out infinite",
            }}
          />
          {/* Inner ring */}
          <div
            style={{
              position: "absolute",
              inset: -4,
              borderRadius: "50%",
              border: "1.5px solid rgba(0,200,150,0.15)",
              animation: "splash-pulse 1.8s ease-in-out 0.3s infinite",
            }}
          />
          {/* Logo container */}
          <div
            style={{
              width: 120,
              height: 120,
              borderRadius: "50%",
              background: "rgba(0,200,150,0.06)",
              border: "1.5px solid rgba(0,200,150,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backdropFilter: "blur(8px)",
              animation: phase === "enter" ? "splash-logo-in 0.6s cubic-bezier(0.34,1.56,0.64,1) forwards" : "none",
              opacity: phase === "enter" ? 0 : 1,
            }}
          >
            <img
              src={APP_LOGO}
              alt="App Logo"
              style={{
                width: 80,
                height: "auto",
                objectFit: "contain",
              }}
            />
          </div>
        </div>

        {/* Brand name */}
        <div
          style={{
            textAlign: "center",
            animation: phase === "enter" ? "splash-text-in 0.6s ease 0.2s forwards" : "none",
            opacity: phase === "enter" ? 0 : 1,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.18em",
              color: "#8E8E93",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            the app
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: "0.12em",
              color: "#C7C7CC",
              textTransform: "uppercase",
            }}
          >
            Cross-Border Stablecoin Exchange
          </div>
        </div>

        {/* Progress bar */}
        <div
          style={{
            width: 160,
            height: 2,
            background: "rgba(0,200,150,0.12)",
            borderRadius: 2,
            overflow: "hidden",
            animation: phase === "enter" ? "splash-text-in 0.4s ease 0.4s forwards" : "none",
            opacity: phase === "enter" ? 0 : 1,
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress}%`,
              background: "linear-gradient(90deg, #00C896, #00E5B0)",
              borderRadius: 2,
              transition: "width 0.05s linear",
              boxShadow: "0 0 8px rgba(0,200,150,0.6)",
            }}
          />
        </div>
      </div>

      {/* Powered by footer */}
      <div
        style={{
          position: "absolute",
          bottom: 48,
          fontSize: 10,
          color: "#C7C7CC",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        Stablecoin FX Mini App
      </div>

      <style>{`
        @keyframes splash-pulse {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50% { transform: scale(1.08); opacity: 0.2; }
        }
        @keyframes splash-logo-in {
          from { opacity: 0; transform: scale(0.7); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes splash-text-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
