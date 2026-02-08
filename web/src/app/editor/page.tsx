"use client";

import { useSearchParams } from "next/navigation";
import MultiTrackEditor from "../../components/MultiTrackEditor";

export default function EditorPage() {
  const params = useSearchParams();
  const jobId = params.get("job_id") ?? undefined;
  return (
    <main className="page">
      <section className="hero">
        <p className="tagline">Mood Mode: Multitrack</p>
        <h1 className="title">Overture Editor</h1>
        <p className="subtitle">
          Paste stem URLs to scrub, mute, and balance each layer.
        </p>
      </section>
      <section className="stage-grid">
        <MultiTrackEditor jobId={jobId} />
      </section>
    </main>
  );
}
