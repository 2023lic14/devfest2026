from pathlib import Path
import pretty_midi
import soundfile as sf



def generate_instrumental(
    bpm: int = 120,
    chords=None,
    total_bars: int = 24,
    chorus_start_bar: int = 12,
    chorus_bars: int = 4,
    out_dir: str = "instrumental",
    soundfont_path: str = "assets/FluidR3_GM.sf2",
):
    # generates instrumental track as MIDI + WAV; returns dict with paths + timing metadata
    

    if chords is None:
        chords = [48, 55, 50, 53]

    seconds_per_bar = 60 / bpm * 4  # 4/4 time

    chorus_start_sec = chorus_start_bar * seconds_per_bar
    chorus_duration_sec = chorus_bars * seconds_per_bar


    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    midi_path = out_dir / "beat.mid"
    wav_path = out_dir / "instrumental.wav"



    pm = pretty_midi.PrettyMIDI()
    pm._tempo_changes = ([0.0], [bpm])

    drums = pretty_midi.Instrument(program=0, is_drum=True)
    bass = pretty_midi.Instrument(
        program=pretty_midi.instrument_name_to_program("Electric Bass (finger)")
    )
    pad = pretty_midi.Instrument(program=88)  # Pad 1 (New Age)

    for bar in range(total_bars):
        start = bar * seconds_per_bar
        root = chords[bar % len(chords)]

        drums.notes.append(pretty_midi.Note(100, 36, start, start + 0.1))

        bass.notes.append(pretty_midi.Note(80, root - 12, start, start + seconds_per_bar))

        # pad chord
        pad.notes.append(pretty_midi.Note(60, root, start, start + seconds_per_bar))
        pad.notes.append(pretty_midi.Note(60, root + 7, start, start + seconds_per_bar))

    pm.instruments.extend([drums, bass, pad])
    pm.write(midi_path)




    audio = pm.fluidsynth(fs=44100, sf2_path=soundfont_path)

    sf.write(wav_path, audio, 44100)


    return {
        "bpm": bpm,
        "bars": total_bars,
        "duration_sec": total_bars * seconds_per_bar,
        "chorus": {
            "start_bar": chorus_start_bar,
            "bars": chorus_bars,
            "start_sec": chorus_start_sec,
            "duration_sec": chorus_duration_sec,
        },
        "paths": {
            "midi": str(midi_path),
            "wav": str(wav_path),
        },
    }

