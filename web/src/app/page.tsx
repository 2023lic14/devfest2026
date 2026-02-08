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
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [isSpectrumLive, setIsSpectrumLive] = useState(false);
  const [jobIdState, setJobIdState] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [finalAudioUrl, setFinalAudioUrl] = useState<string | null>(null);
  const [hasStems, setHasStems] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const router = useRouter();
  const params = useSearchParams();
  const jobId = jobIdState ?? params.get("job_id");
  const apiBase = getApiBase();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const spectrumBarRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const mixMeterRef = useRef<HTMLDivElement | null>(null);
  const vocalsMeterRef = useRef<HTMLDivElement | null>(null);
  const fxMeterRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const freqDataRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  const trackStatus = useMemo(
    () => [
      {
        title: "Instrumental",
        status:
          jobStatus === "RENDERING"
            ? "Rendering"
            : jobStatus === "MIXING"
              ? "Finalizing"
              : jobStatus === "COMPLETED"
                ? "Ready"
                : jobId
                  ? "Queued"
                  : "Awaiting input",
        ready: jobStatus === "MIXING" || jobStatus === "COMPLETED",
      },
      {
        title: "Vocals",
        status:
          jobStatus === "RENDERING"
            ? "Rendering"
            : jobStatus === "MIXING"
              ? "Finalizing"
              : jobStatus === "COMPLETED"
                ? "Ready"
                : jobId
                  ? "Queued"
                  : "Awaiting input",
        ready: jobStatus === "MIXING" || jobStatus === "COMPLETED",
      },
    ],
    [jobId, jobStatus],
  );

  const pipelineStage = useMemo(() => {
    if (isUploading) return "Uploading";
    if (isRecording) return "Recording";
    if (!jobId) return "Idle";
    if (pipelineError) return "Error";
    if (!jobStatus) return "Checking";
    if (jobStatus === "PENDING") return "Queued";
    if (jobStatus === "ANALYZING") return "Analyzing";
    if (jobStatus === "RENDERING") return "Rendering";
    if (jobStatus === "MIXING") return "Mixing";
    if (jobStatus === "COMPLETED") return "Ready";
    return String(jobStatus);
  }, [isUploading, isRecording, jobId, jobStatus, pipelineError]);

  const pipelineBusy = useMemo(() => {
    if (isUploading || isRecording) return true;
    if (!jobId || !jobStatus) return false;
    return jobStatus !== "COMPLETED";
  }, [isUploading, isRecording, jobId, jobStatus]);

  useEffect(() => {
    if (!jobId) {
      setJobStatus(null);
      setFinalAudioUrl(null);
      setHasStems(false);
      setPipelineError(null);
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
          const metadata = (data as any)?.blueprint_json?.metadata;
          const stems = metadata?.stems;
          const errorMessage = typeof metadata?.error_message === "string" ? metadata.error_message : null;
          const stemsError = typeof metadata?.stems_error === "string" ? metadata.stems_error : null;
          setPipelineError(errorMessage);
          setHasStems(Boolean(stems));
          if (!cancelled && stemsError && !errorMessage) {
            setPipelineError(stemsError);
          }
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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const resetWidgets = () => {
      spectrumBarRefs.current.forEach((bar) => {
        if (!bar) return;
        bar.style.height = "";
      });
      mixMeterRef.current?.style.removeProperty("--level");
      vocalsMeterRef.current?.style.removeProperty("--level");
      fxMeterRef.current?.style.removeProperty("--level");
    };

    const stopLoop = () => {
      runningRef.current = false;
      setIsAudioPlaying(false);
      setIsSpectrumLive(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      resetWidgets();
    };

    const ensureAudioGraph = async () => {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (!analyserRef.current) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.85;
        analyserRef.current = analyser;
        freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      }
      if (!sourceRef.current) {
        sourceRef.current = ctx.createMediaElementSource(audio);
        // Route: element -> analyser -> speakers
        sourceRef.current.connect(analyserRef.current!);
        analyserRef.current!.connect(ctx.destination);
      }
    };

    const tick = () => {
      if (!runningRef.current) return;
      const analyser = analyserRef.current;
      const data = freqDataRef.current;
      if (!analyser || !data) return;

      analyser.getByteFrequencyData(data);
      const bars = spectrumBarRefs.current;
      const barCount = bars.length || 1;
      const binCount = data.length || 1;

      // Simple log-ish spread: lower bins get more resolution.
      for (let i = 0; i < barCount; i += 1) {
        const start = Math.floor((i / barCount) ** 1.8 * binCount);
        const end = Math.max(start + 1, Math.floor(((i + 1) / barCount) ** 1.8 * binCount));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += data[j] ?? 0;
        const avg = sum / Math.max(1, end - start);
        const heightPct = 14 + (avg / 255) * 86; // 14..100
        const bar = bars[i];
        if (bar) {
          bar.style.height = `${heightPct.toFixed(1)}%`;
        }
      }

      // Meters: low/mid/high band averages.
      const avgBand = (from: number, to: number) => {
        const a = Math.max(0, Math.min(binCount - 1, from));
        const b = Math.max(a + 1, Math.min(binCount, to));
        let sum = 0;
        for (let i = a; i < b; i += 1) sum += data[i] ?? 0;
        return sum / Math.max(1, b - a);
      };
      const low = avgBand(0, Math.floor(binCount * 0.25));
      const mid = avgBand(Math.floor(binCount * 0.25), Math.floor(binCount * 0.6));
      const high = avgBand(Math.floor(binCount * 0.6), binCount);
      const mix = (low + mid + high) / 3;
      const toLevel = (v: number) => Math.max(0, Math.min(100, Math.round((v / 255) * 100)));
      mixMeterRef.current?.style.setProperty("--level", String(toLevel(mix)));
      vocalsMeterRef.current?.style.setProperty("--level", String(toLevel(mid)));
      fxMeterRef.current?.style.setProperty("--level", String(toLevel(high)));

      rafRef.current = requestAnimationFrame(tick);
    };

    const onPlay = async () => {
      try {
        await ensureAudioGraph();
        setIsAudioPlaying(true);
        setIsSpectrumLive(true);
        if (runningRef.current) return;
        runningRef.current = true;
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // If the analyser can't initialize (CORS or browser limitation), keep UI functional.
        setIsAudioPlaying(true);
        setIsSpectrumLive(false);
      }
    };

    const onPause = () => stopLoop();
    const onEnded = () => stopLoop();

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      stopLoop();
    };
  }, [finalAudioUrl]);

  const chooseMimeType = () => {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (const type of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return "";
  };

  const mimeToExtension = (mime: string) => {
    const m = mime.toLowerCase();
    if (m.includes("mp4")) return "m4a";
    if (m.includes("webm")) return "webm";
    return "webm";
  };

  const startRecording = async () => {
    try {
      setRecordError(null);
      setRecordSeconds(0);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = chooseMimeType();
      if (!mimeType) {
        throw new Error("This browser does not support MediaRecorder audio capture. Try Chrome, or upload a file.");
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        if (autoStopRef.current) {
          window.clearTimeout(autoStopRef.current);
          autoStopRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (!blob.size) {
          setRecordError("No audio captured.");
          return;
        }
        setIsUploading(true);
        try {
          const ext = mimeToExtension(mimeType);
          const newJobId = await createMoment({
            file: blob,
            filename: `hum.${ext}`,
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

      // Timeslice helps ensure we actually receive dataavailable events on some browsers.
      recorder.start(250);
      setIsRecording(true);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);

      // Auto-stop so users don't forget to press "Stop" (and so a job actually starts).
      autoStopRef.current = window.setTimeout(() => {
        recorderRef.current?.stop();
      }, 12_000);
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
          <span>{isRecording ? `Listening (${recordSeconds}s)` : "Standing by"}</span>
        </div>
        {recordError && <div className="record-status">{recordError}</div>}
        {jobId && (
          <div className="record-status">
            <span>
              Job: {jobStatus ?? "Checking..."}
            </span>
          </div>
        )}
        {jobId && pipelineError && (
          <div className="record-status" style={{ color: "#ffb3b3" }}>
            Error: {pipelineError}
          </div>
        )}
        {jobId && finalAudioUrl && (
          <div className="panel" style={{ maxWidth: 720 }}>
            <h2>Final Song</h2>
            <audio
              ref={audioRef}
              controls
              preload="none"
              crossOrigin="anonymous"
              src={buildProxyAudioUrl(finalAudioUrl, apiBase)}
            />
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
              Pipeline: {pipelineStage}
            </div>
            {pipelineBusy && (
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
                <div className="knob" data-active={isRecording || isAudioPlaying} />
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
              <div className="timeline-bar" data-active={isAudioPlaying} />
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
          <div className="spectrum" data-active={isRecording || isAudioPlaying} data-live={isSpectrumLive}>
            {spectrumBars.map((bar) => (
              <span
                key={bar.id}
                className="spectrum-bar"
                ref={(node) => {
                  const index = Number(bar.id.replace("bar-", ""));
                  spectrumBarRefs.current[index] = node;
                }}
              />
            ))}
          </div>
          <div className="meter-row">
            <div className="meter">
              <span>Mix</span>
              <div className="meter-fill" ref={mixMeterRef} />
            </div>
            <div className="meter">
              <span>Vocals</span>
              <div className="meter-fill" ref={vocalsMeterRef} />
            </div>
            <div className="meter">
              <span>FX</span>
              <div className="meter-fill" ref={fxMeterRef} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
