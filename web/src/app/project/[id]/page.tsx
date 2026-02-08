export default function ProjectPage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <main className="page">
      <section className="hero">
        <p className="tagline">Project</p>
        <h1 className="title">Overture Session {params.id}</h1>
        <p className="subtitle">
          Review the cinematic score and timeline cues for this moment.
        </p>
      </section>
      <section className="stage-grid">
        <div className="panel">
          <h2>Timeline</h2>
          <p className="prompt-note">
            The mixdown will render here with glowing waveforms once ready.
          </p>
        </div>
        <div className="panel">
          <h2>Director Notes</h2>
          <p className="prompt-note">
            Capture adjustments for dynamics, instrumentation, and mood.
          </p>
        </div>
      </section>
    </main>
  );
}
