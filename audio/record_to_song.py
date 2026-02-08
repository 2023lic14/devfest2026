"""
Record audio from the microphone, run the audio preprocessing pipeline in this folder,
then generate a blueprint + create a song via the backend/MCP pipeline.

Flow:
1) Record mic audio -> WAV
2) clean_input_audio() -> cleaned WAV (16k mono)
3) Call `mcp/music-tools` CLI (OpenAI -> blueprint -> POST /v1/create-moment -> Celery -> MCP create_song)

Prereqs:
- API running (uvicorn) and worker running (celery)
- MCP server running (npm run dev:http) OR backend configured to hit the correct MCP URL
- `mcp/music-tools/.env` contains OPENAI_API_KEY (and ELEVENLABS_API_KEY is configured on MCP side)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
import shutil
import platform


def _record_wav(out_path: Path, duration_s: float, sample_rate: int, channels: int) -> None:
    """
    Record microphone audio to a WAV file.

    Prefer Python (sounddevice+scipy) when available, otherwise fall back to
    macOS built-in `afrecord` to avoid extra dependencies.
    """
    try:
        import sounddevice as sd  # type: ignore
        from scipy.io.wavfile import write  # type: ignore
    except ModuleNotFoundError:
        sd = None
        write = None

    out_path.parent.mkdir(parents=True, exist_ok=True)

    frames = int(duration_s * sample_rate)
    print(f"Recording {duration_s:.1f}s @ {sample_rate}Hz...")

    # Python path (cross-platform) if deps are installed.
    if sd is not None and write is not None:
        # Record as int16 PCM so the downstream WAV cleaner can read it without extra deps.
        audio = sd.rec(frames, samplerate=sample_rate, channels=channels, dtype="int16")
        sd.wait()
        write(str(out_path), sample_rate, audio)
        print(f"Wrote {out_path}")
        return

    # macOS fallback: use CoreAudio recorder.
    if platform.system().lower() == "darwin":
        afrecord = shutil.which("afrecord")
        if not afrecord and Path("/usr/bin/afrecord").exists():
            afrecord = "/usr/bin/afrecord"
        if not afrecord:
            raise ModuleNotFoundError(
                "Missing sounddevice. Install with `pip install sounddevice scipy` "
                "(and ensure PortAudio is available), or install/enable `afrecord`."
            )
        cmd = [
            afrecord,
            "-q",
            "-d",
            str(duration_s),
            "-c",
            str(channels),
            "-r",
            str(sample_rate),
            "-f",
            "WAVE",
            str(out_path),
        ]
        # Note: macOS may prompt for microphone permission the first time.
        subprocess.run(cmd, check=True)
        print(f"Wrote {out_path}")
        return

    raise ModuleNotFoundError(
        "Missing sounddevice. Install with `pip install sounddevice scipy`."
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=15.0, help="Recording duration in seconds (default: 15).")
    parser.add_argument("--sample-rate", type=int, default=44100, help="Recording sample rate (default: 44100).")
    parser.add_argument("--channels", type=int, default=1, help="Number of mic channels (default: 1).")
    parser.add_argument("--api", default="http://127.0.0.1:8001", help="Backend base URL (default: http://127.0.0.1:8001).")
    parser.add_argument("--kind", default="song", choices=["song", "preview"], help="Output kind (default: song).")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    audio_dir = repo_root / "tmp" / "recordings"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    raw_path = audio_dir / f"mic-{stamp}.wav"
    cleaned_path = audio_dir / f"mic-{stamp}.clean.wav"

    _record_wav(raw_path, duration_s=args.duration, sample_rate=args.sample_rate, channels=args.channels)

    # Local cleaning pipeline (silence trim, mono 16k).
    # WAV path is implemented without ffmpeg/ffprobe. If anything fails, fall back to raw WAV.
    try:
        sys.path.insert(0, str((repo_root / "audio").resolve()))
        from audio_io import clean_input_audio  # noqa: E402

        clean_input_audio(str(raw_path), out_path=str(cleaned_path))
        input_for_pipeline = cleaned_path
        print(f"Cleaned audio -> {cleaned_path}")
    except Exception as exc:
        input_for_pipeline = raw_path
        print(f"Skipping clean_input_audio ({exc}). Using raw recording: {raw_path}")

    # Delegate blueprint generation + job submission to the Node CLI in mcp/music-tools.
    mcp_dir = repo_root / "mcp" / "music-tools"
    cmd = [
        "npm",
        "run",
        "audio:moment",
        "--",
        str(input_for_pipeline),
        "--api",
        args.api,
        "--kind",
        args.kind,
    ]
    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(mcp_dir), check=False)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
