"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

type Track = {
  id: string;
  label: string;
  url: string;
  muted: boolean;
  volume: number;
  rate: number;
};

type TrackStatus = {
  ready: boolean;
  error?: string;
};

type MultiTrackEditorProps = {
  jobId?: string;
};

type StatusResponse = {
  blueprint_json?: {
    metadata?: {
      stems?: Record<string, string>;
    };
  };
};

const defaultTracks: Track[] = [
  { id: "vocals", label: "Vocals", url: "", muted: false, volume: 1, rate: 1 },
  { id: "drums", label: "Drums", url: "", muted: false, volume: 1, rate: 1 },
  { id: "bass", label: "Bass", url: "", muted: false, volume: 1, rate: 1 },
  { id: "other", label: "Other", url: "", muted: false, volume: 1, rate: 1 },
];

const applyMute = (ws: WaveSurfer, muted: boolean) => {
  const anyWs = ws as WaveSurfer & {
    setMute?: (value: boolean) => void;
    setMuted?: (value: boolean) => void;
  };
  if (anyWs.setMuted) {
    anyWs.setMuted(muted);
  } else if (anyWs.setMute) {
    anyWs.setMute(muted);
  }
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001";
const buildProxyUrl = (rawUrl: string) =>
  `${apiBase}/v1/proxy-audio?url=${encodeURIComponent(rawUrl)}`;

export default function MultiTrackEditor({ jobId }: MultiTrackEditorProps) {
  const [tracks, setTracks] = useState<Track[]>(defaultTracks);
  const [statuses, setStatuses] = useState<Record<string, TrackStatus>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const instancesRef = useRef<Record<string, { url: string; ws: WaveSurfer }>>(
    {},
  );

  const hasAnyAudio = useMemo(
    () => tracks.some((track) => track.url.trim().length > 0),
    [tracks],
  );

  useEffect(() => {
    if (!jobId) {
      return;
    }
    let cancelled = false;
    const loadStems = async () => {
      setLoadError(null);
      try {
        const response = await fetch(`${apiBase}/v1/status/${jobId}`);
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }
        const data = (await response.json()) as StatusResponse;
        const stems = data.blueprint_json?.metadata?.stems;
        if (!stems) {
          throw new Error("No stems found for this job.");
        }
        if (cancelled) {
          return;
        }
        setTracks((prev) =>
          prev.map((track) => ({
            ...track,
            url: stems[track.id] ?? track.url,
          })),
        );
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Failed to load stems.");
      }
    };
    loadStems();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    tracks.forEach((track) => {
      const existing = instancesRef.current[track.id];
      const container = containerRefs.current[track.id];
      if (!track.url || !container) {
        if (existing) {
          existing.ws.destroy();
          delete instancesRef.current[track.id];
        }
        setStatuses((prev) => {
          const next = { ...prev };
          delete next[track.id];
          return next;
        });
        return;
      }

      if (existing && existing.url === track.url) {
        applyMute(existing.ws, track.muted);
        existing.ws.setVolume(track.volume);
        existing.ws.setPlaybackRate(track.rate);
        return;
      }

      if (existing) {
        existing.ws.destroy();
        delete instancesRef.current[track.id];
      }

      const ws = WaveSurfer.create({
        container,
        url: buildProxyUrl(track.url),
        waveColor: "rgba(185, 167, 255, 0.6)",
        progressColor: "rgba(182, 255, 59, 0.9)",
        cursorColor: "rgba(182, 255, 59, 0.8)",
        height: 72,
        barWidth: 2,
        barGap: 2,
        normalize: true,
        fetchParams: { mode: "cors" },
      });

      setStatuses((prev) => ({
        ...prev,
        [track.id]: { ready: false },
      }));
      ws.on("ready", () => {
        setStatuses((prev) => ({
          ...prev,
          [track.id]: { ready: true },
        }));
      });
      ws.on("error", (error) => {
        setStatuses((prev) => ({
          ...prev,
          [track.id]: { ready: false, error: String(error) },
        }));
      });

      applyMute(ws, track.muted);
      ws.setVolume(track.volume);
      ws.setPlaybackRate(track.rate);
      instancesRef.current[track.id] = { url: track.url, ws };
    });
  }, [tracks]);

  useEffect(() => {
    return () => {
      Object.values(instancesRef.current).forEach((entry) => entry.ws.destroy());
      instancesRef.current = {};
    };
  }, []);

  const handlePlayPause = () => {
    const instances = Object.entries(instancesRef.current)
      .filter(([id]) => statuses[id]?.ready)
      .map(([, entry]) => entry.ws);
    if (instances.length === 0) {
      return;
    }
    const isPlaying = instances.some((ws) => ws.isPlaying());
    instances.forEach((ws) => (isPlaying ? ws.pause() : ws.play()));
  };

  const handleStop = () => {
    Object.values(instancesRef.current).forEach((entry) => entry.ws.stop());
  };

  const handleSync = () => {
    const master = instancesRef.current.vocals?.ws;
    if (!master) {
      return;
    }
    const duration = master.getDuration();
    if (!duration) {
      return;
    }
    const progress = master.getCurrentTime() / duration;
    Object.values(instancesRef.current).forEach((entry) => entry.ws.seekTo(progress));
  };

  const updateTrack = (id: string, updates: Partial<Track>) => {
    setTracks((prev) =>
      prev.map((track) => (track.id === id ? { ...track, ...updates } : track)),
    );
  };

  return (
    <div className="panel">
      <h2>Multitrack Editor</h2>
      <p className="prompt-note">
        Paste stem URLs from `blueprint_json.metadata.stems` and control each track.
      </p>
      {loadError && <p className="track-status">Auto-load failed: {loadError}</p>}
      <div className="script-view">
        {tracks.map((track) => (
          <div key={track.id} className="wave-track">
            <h3>{track.label}</h3>
            <input
              className="input"
              placeholder={`Paste ${track.label} URL`}
              value={track.url}
              onChange={(event) => updateTrack(track.id, { url: event.target.value })}
            />
            <p className="track-status">
              {statuses[track.id]?.error
                ? `Error: ${statuses[track.id]?.error}`
                : statuses[track.id]?.ready
                  ? "Ready"
                  : track.url
                    ? "Loading..."
                    : "Paste a URL"}
            </p>
            <div
              ref={(node) => {
                containerRefs.current[track.id] = node;
              }}
            />
            <div className="track-controls">
              <label className="status-chip">
                <input
                  type="checkbox"
                  checked={track.muted}
                  onChange={(event) =>
                    updateTrack(track.id, { muted: event.target.checked })
                  }
                />
                Mute
              </label>
              <label className="status-chip">
                Vol
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={track.volume}
                  onChange={(event) =>
                    updateTrack(track.id, { volume: Number(event.target.value) })
                  }
                />
              </label>
              <label className="status-chip">
                Pitch
                <input
                  type="range"
                  min={0.75}
                  max={1.25}
                  step={0.01}
                  value={track.rate}
                  onChange={(event) =>
                    updateTrack(track.id, { rate: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="track-actions">
        <button
          className="record-button"
          type="button"
          onClick={handlePlayPause}
          disabled={!hasAnyAudio}
        >
          {hasAnyAudio ? "Play / Pause" : "Paste stem URLs"}
        </button>
        <button className="ghost-button" type="button" onClick={handleStop}>
          Stop
        </button>
        <button className="ghost-button" type="button" onClick={handleSync}>
          Sync to Vocals
        </button>
      </div>
    </div>
  );
}
