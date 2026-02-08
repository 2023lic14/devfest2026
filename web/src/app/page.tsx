"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { buildProxyAudioUrl, createMoment, fetchStatus, getApiBase } from "../lib/api";
import type { JobStatus, StatusResponse } from "../lib/types";

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
  const [isUploading, setIsUploading] = useState(false);
  const [jobIdState, setJobIdState] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [finalAudioUrl, setFinalAudioUrl] = useState<string | null>(null);
  const [hasStems, setHasStems] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const jobId = jobIdState ?? params.get("job_id");
  const apiBase = getApiBase();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

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
      setJobStatus(null);
      setFinalAudioUrl(null);
      setHasStems(false);
      return;
    }
    let cancelled = false;
    let timeoutId: number | null = null;

    const pollStatus = async () => {
      try {
        const data = (await fetchStatus(jobId, apiBase)) as StatusResponse;
        const status = data?.status ?? null;
        if (!cancelled) {
          setJobStatus(status);
          setFinalAudioUrl(typeof data.final_audio_url === "string" ? data.final_audio_url : null);
          const stems = (data as any)?.blueprint_json?.metadata?.stems;
          setHasStems(Boolean(stems));
        }
      } catch {
        // keep polling
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

  const startRecording = async () => {
    try {
      setRecordError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (!blob.size) {
          setRecordError("No audio captured.");
          return;
        }
        setIsUploading(true);
        try {
          const newJobId = await createMoment({
            file: blob,
            filename: "hum.webm",
            apiBase,
            outputKind: "song",
          });
          setJobIdState(newJobId);
          router.push(`/?job_id=${newJobId}`);
        } catch (error) {
          setRecordError(
            error instanceof Error ? error.message : "Upload failed.",
          );
        } finally {
          setIsUploading(false);
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      setRecordError(
        error instanceof Error ? error.message : "Microphone permission denied.",
      );
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

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
          onClick={isRecording ? stopRecording : startRecording}
          type="button"
          disabled={isUploading}
        >
          {isUploading
            ? "Uploading..."
            : isRecording
              ? "Stop recording"
              : "Record your hum"}
        </button>
        <div className="record-status">
          <span>Status:</span>
          <span>{isRecording ? "Listening" : "Standing by"}</span>
        </div>
        {recordError && <div className="record-status">{recordError}</div>}
        {jobId && (
          <div className="record-status">
            <span>
              Job: {jobStatus ?? "Checking..."}
            </span>
          </div>
        )}
        {jobId && finalAudioUrl && (
          <div className="panel" style={{ maxWidth: 720 }}>
            <h2>Final Song</h2>
            <audio controls preload="none" src={buildProxyAudioUrl(finalAudioUrl, apiBase)} />
            <div className="record-status" style={{ marginTop: 12 }}>
              <span>Editor:</span>
              <span>{hasStems ? "Stems ready" : "Waiting for stems (optional)"}</span>
            </div>
            {hasStems && (
              <button
                className="record-button"
                type="button"
                onClick={() => router.push(`/editor?job_id=${jobId}`)}
                style={{ marginTop: 12 }}
              >
                Open multitrack editor
              </button>
            )}
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
