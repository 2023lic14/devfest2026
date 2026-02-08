export default function CreatePage() {
  return (
    <main className="page">
      <section className="hero">
        <p className="tagline">Mood Mode: Cinematic Noir</p>
        <h1 className="title">Create Your Overture</h1>
        <p className="subtitle">
          Drop a hum, set the intent, and step into director mode.
        </p>
      </section>
      <section className="stage-grid">
        <div className="panel">
          <h2>Capture</h2>
          <p className="prompt-note">
            Record or upload a raw sketch. The system will stage the blueprint
            for your cinematic score.
          </p>
        </div>
        <div className="panel">
          <h2>Blueprint</h2>
          <p className="prompt-note">
            Lyrics, genre analysis, and mood cues appear like a teleprompter
            while the AI agent renders your soundtrack.
          </p>
        </div>
      </section>
    </main>
  );
}
