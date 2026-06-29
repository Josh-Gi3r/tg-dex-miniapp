/**
 * VideoTour — a modal player for the per-flow HyperFrames explainer videos
 * (Swap / Send / P2P / Set-up-shop). Stylised step-by-step clips, muted +
 * captioned (Telegram autoplay-safe). Lazy by construction: the <video> (and
 * therefore the MP4 fetch) only mounts when `open` is true, so the ~1.5MB clips
 * never touch the initial app load. Auto-shows once on a first-timer's visit to
 * a flow and is re-summonable anytime from the header "?" button.
 */
import { useEffect, useRef } from "react";

export interface VideoTourProps {
  /** Public URL of the MP4, e.g. "/embeds/swap.mp4". */
  src: string;
  /** Short label shown under the player, e.g. "How Swap works". */
  title?: string;
  onClose: () => void;
}

export function VideoTour({ src, title, onClose }: VideoTourProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Autoplay muted (the only reliable autoplay in a TG webview). If the browser
  // still blocks it, the tap-to-play controls are the fallback.
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.play().catch(() => {
        /* autoplay blocked — user can tap play; non-fatal */
      });
    }
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 4000,
        background: "rgba(8,20,16,0.86)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 20px",
      }}
    >
      {/* Close */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 16px)",
          right: 18,
          width: 40,
          height: 40,
          borderRadius: "50%",
          border: "none",
          background: "rgba(255,255,255,0.16)",
          color: "#fff",
          fontSize: 22,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ✕
      </button>

      <video
        ref={videoRef}
        onClick={(e) => e.stopPropagation()}
        src={src}
        muted
        playsInline
        autoPlay
        loop
        controls={false}
        style={{
          width: "auto",
          maxWidth: "100%",
          maxHeight: "76vh",
          aspectRatio: "9 / 16",
          borderRadius: 28,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          background: "#EAF3F0",
        }}
      />

      {title && (
        <div style={{ marginTop: 18, color: "rgba(255,255,255,0.92)", fontSize: 15, fontWeight: 700, textAlign: "center" }}>
          {title}
        </div>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          marginTop: 16,
          padding: "12px 30px",
          borderRadius: 999,
          border: "none",
          background: "#00C896",
          color: "#fff",
          fontSize: 15,
          fontWeight: 800,
          cursor: "pointer",
        }}
      >
        Got it
      </button>
    </div>
  );
}
