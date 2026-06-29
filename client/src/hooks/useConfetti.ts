import confetti from "canvas-confetti";

export function useConfetti() {
  const fireConfetti = (opts?: { origin?: { x: number; y: number }; colors?: string[] }) => {
    const colors = opts?.colors ?? ["#00C896", "#00E5AC", "#4A90D9", "#FFD700", "#FF6B6B", "#FFFFFF"];
    const origin = opts?.origin ?? { x: 0.5, y: 0.6 };

    confetti({
      particleCount: 80,
      spread: 70,
      origin,
      colors,
      ticks: 200,
      gravity: 1.2,
      scalar: 0.9,
      shapes: ["circle", "square"],
    });

    // Second burst for richness
    setTimeout(() => {
      confetti({
        particleCount: 40,
        spread: 100,
        origin: { x: origin.x - 0.1, y: origin.y },
        colors,
        ticks: 150,
        gravity: 1.0,
        scalar: 0.7,
      });
    }, 120);

    setTimeout(() => {
      confetti({
        particleCount: 40,
        spread: 100,
        origin: { x: origin.x + 0.1, y: origin.y },
        colors,
        ticks: 150,
        gravity: 1.0,
        scalar: 0.7,
      });
    }, 200);
  };

  const fireXpConfetti = () => {
    fireConfetti({ colors: ["#00C896", "#00E5AC", "#FFD700", "#FFFFFF"] });
  };

  const fireSwapConfetti = () => {
    fireConfetti({ colors: ["#00C896", "#4A90D9", "#FFFFFF", "#00E5AC"] });
  };

  return { fireConfetti, fireXpConfetti, fireSwapConfetti };
}
