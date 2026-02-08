"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import StartupSplash from "./StartupSplash";

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

const consoleKnobs = [
  { label: "Intensity", value: "62%" },
  { label: "Dramatic", value: "74%" },
  { label: "Space", value: "48%" },
  { label: "Pulse", value: "55%" },
];

const spectrumBars = Array.from({ length: 18 }, (_, index) => ({
  id: `bar-${index}`,
}));

export default function HomePage() {
  const [isRecording, setIsRecording] = useState(false);
  const [stemStatus, setStemStatus] = useState<"idle" | "loading" | "ready">("idle");
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get("job_id");
  const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

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

  useEffect(() => {
    if (!jobId) {
      setStemStatus("idle");
      return;
    }
    let cancelled = false;
    let timeoutId: number | null = null;

    const pollStatus = async () => {
      setStemStatus((prev) => (prev === "ready" ? prev : "loading"));
      try {
        const response = await fetch(`${apiBase}/v1/status/${jobId}`);
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }
        const data = await response.json();
        const stems = data?.blueprint_json?.metadata?.stems;
        if (stems && !cancelled) {
          setStemStatus("ready");
          router.push(`/editor?job_id=${jobId}`);
          return;
        }
      } catch {
        if (!cancelled) {
          setStemStatus("loading");
        }
      }
      if (!cancelled) {
        timeoutId = window.setTimeout(pollStatus, 2500);
      }
    };

    pollStatus();
    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [apiBase, jobId, router]);

  return (
    <main className="page" data-recording={isRecording}>
      <StartupSplash active={isRecording} />
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
        {jobId && (
          <div className="record-status">
            <span>Stems:</span>
            <span>
              {stemStatus === "ready" ? "Ready - opening editor" : "Checking..."}
            </span>
          </div>
        )}
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

      <section className="console-grid">
        <div className="panel console-panel">
          <h2>Director Console</h2>
          <div className="console-row">
            {consoleKnobs.map((knob) => (
              <div key={knob.label} className="knob-card">
                <div className="knob" data-active={isRecording} />
                <div className="knob-meta">
                  <span>{knob.label}</span>
                  <strong>{knob.value}</strong>
                </div>
              </div>
            ))}
          </div>
          <div className="console-row">
            <div className="status-chip">Scene Mode: Noir Pulse</div>
            <div className="status-chip">Render Target: 48kHz</div>
            <div className="status-chip">Mix Bus: Warm Tape</div>
          </div>
        </div>

        <div className="panel console-panel">
          <h2>Timeline</h2>
          <div className="timeline">
            <div className="timeline-track">
              <span>Intro</span>
              <div className="timeline-bar" data-active={isRecording} />
            </div>
            <div className="timeline-track">
              <span>Build</span>
              <div className="timeline-bar" />
            </div>
            <div className="timeline-track">
              <span>Climax</span>
              <div className="timeline-bar" />
            </div>
            <div className="timeline-track">
              <span>Resolve</span>
              <div className="timeline-bar" />
            </div>
          </div>
          <p className="prompt-note">Markers align to the blueprint sections.</p>
        </div>

        <div className="panel console-panel">
          <h2>Reactive Spectrum</h2>
          <div className="spectrum" data-active={isRecording}>
            {spectrumBars.map((bar) => (
              <span key={bar.id} className="spectrum-bar" />
            ))}
          </div>
          <div className="meter-row">
            <div className="meter">
              <span>Mix</span>
              <div className="meter-fill" data-level="72" />
            </div>
            <div className="meter">
              <span>Vocals</span>
              <div className="meter-fill" data-level="58" />
            </div>
            <div className="meter">
              <span>FX</span>
              <div className="meter-fill" data-level="64" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
