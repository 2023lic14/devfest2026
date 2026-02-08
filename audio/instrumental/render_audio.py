import pretty_midi
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent
MIDI_PATH = BASE_DIR / "beat.mid"
SOUNDFONT_PATH = BASE_DIR.parent / "assets" / "FluidR3_GM.sf2"
OUT_PATH = BASE_DIR / "instrumental.wav"

# Load MIDI
midi = pretty_midi.PrettyMIDI(str(MIDI_PATH))

# Render to audio using FluidSynth (via pretty_midi)
audio = midi.fluidsynth(
    fs=44100,
    sf2_path=str(SOUNDFONT_PATH)
)

# Save WAV
import soundfile as sf
sf.write(OUT_PATH, audio, 44100)

print(f"Saved {OUT_PATH}")
