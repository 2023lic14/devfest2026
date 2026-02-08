"use client";

import { useMemo, useState } from "react";

const scriptLines = [
  "SCENE 01 - OPENING SHOT",
  "The city exhales. A lone hum cuts through the neon haze.",
  "",
  "INTENT:",
  "Cinematic noir. Slow tempo. Suspenseful strings. Hopeful resolve.",
  "",
  "GENRE ANALYSIS:",
  "Hybrid of neo-noir score, ambient synthwave, and orchestral pulse.",
];

export default function HomePage() {
  const [isRecording, setIsRecording] = useState(false);

  const trackStatus = useMemo(
    () => [
      {
        title: "Instrumental",
        status: isRecording ? "Rendering" : "Awaiting input",
        ready: isRecording,
      },
      {
        title: "Vocals",
        status: isRecording ? "Rendering" : "Awaiting input",
        ready: isRecording,
      },
    ],
    [isRecording],
  );

  return (
    <main className="page" data-recording={isRecording}>
      <section className="hero">
        <p className="tagline">
          Turn your hum into a cinematic score. Your Overture starts now.
        </p>
        <h1 className="title">Overture</h1>
        <p className="subtitle">
          Cinematic Noir mood mode for directors of sound. Capture raw human
          creativity, then watch your AI-rendered score take the spotlight.
        </p>
        <button
          className="record-button"
          data-active={isRecording}
          onClick={() => setIsRecording((prev) => !prev)}
          type="button"
        >
          {isRecording ? "Recording live" : "Record your hum"}
        </button>
        <div className="record-status">
          <span>Status:</span>
          <span>{isRecording ? "Listening" : "Standing by"}</span>
        </div>
      </section>

      <section className="stage-grid">
        <div className="panel">
          <h2>Script View</h2>
          <div className="script-view">
            <div className="script-block">{scriptLines.join("\n")}</div>
            <div className="status-chip">
              AI Blueprint: {isRecording ? "Synthesizing" : "Idle"}
            </div>
            {isRecording && (
              <div className="progress-glow">
                <span />
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>Dynamic Waveforms</h2>
          <div className="script-view">
            {trackStatus.map((track) => (
              <div key={track.title} className="wave-track">
                <h3>{track.title}</h3>
                <div className="wave-bar">
                  <div className="wave-fill" data-ready={track.ready} />
                </div>
                <p className="prompt-note">{track.status}</p>
              </div>
            ))}
            <p className="prompt-note">
              Glow waves appear once tracks finish rendering.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
