"use client";

import { useEffect, useMemo, useState } from "react";

type StartupSplashProps = {
  active?: boolean;
  autoHideMs?: number;
};

export default function StartupSplash({
  active,
  autoHideMs = 6500,
}: StartupSplashProps) {
  const [visible, setVisible] = useState(active ?? true);
  const [typed, setTyped] = useState("");
  const [phraseIndex, setPhraseIndex] = useState(0);
  const phrases = useMemo(
    () => [
      "calibrating noir mood curve",
      "threading hum into score",
      "warming the synth stage",
      "sequencing main character energy",
    ],
    [],
  );

  useEffect(() => {
    if (active !== undefined) {
      setVisible(active);
      return;
    }
    const timer = setTimeout(() => setVisible(false), autoHideMs);
    return () => clearTimeout(timer);
  }, [active, autoHideMs]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let offset = 0;
    let pause = 0;
    const interval = setInterval(() => {
      if (pause > 0) {
        pause -= 1;
        return;
      }
      const current = phrases[phraseIndex] ?? "";
      if (offset <= current.length) {
        setTyped(current.slice(0, offset));
        offset += 1;
      } else {
        pause = 6;
        offset = 0;
        setPhraseIndex((prev) => (prev + 1) % phrases.length);
      }
    }, 70);
    return () => clearInterval(interval);
  }, [phrases, phraseIndex, visible]);

  if (!visible) {
    return null;
  }

  return (
    <div className="startup-splash" aria-hidden="true">
      <div className="startup-logo">
        <svg viewBox="0 0 96 96" role="presentation">
          <circle cx="48" cy="48" r="32" className="startup-ring" />
          <path
            className="startup-note"
            d="M57 28v28.5a8.5 8.5 0 1 1-4-7.1V38.8l-14 3.2V60a8.5 8.5 0 1 1-4-7.1V39.6a3 3 0 0 1 2.3-2.9l18-4.2a2.8 2.8 0 0 1 1.7.2 2.7 2.7 0 0 1 1.3 2.3Z"
          />
          <path
            className="startup-headphones"
            d="M24 50a24 24 0 0 1 48 0v10a6 6 0 0 1-6 6h-6v-12h8v-4a20 20 0 0 0-40 0v4h8v12h-6a6 6 0 0 1-6-6V50Z"
          />
        </svg>
        <span>Overture</span>
        <p className="startup-typing">
          {typed}
          <span className="startup-caret" />
        </p>
      </div>
    </div>
  );
}
