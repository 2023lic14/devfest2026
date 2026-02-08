import librosa
import numpy as np

def analyze_tone(audio_path: str):
    print("Loading audio:", audio_path)

    y, sr = librosa.load(audio_path, mono=True)
    print("Sample rate:", sr)
    print("Audio length (seconds):", len(y) / sr)

    # Loudness (energy)
    rms = librosa.feature.rms(y=y)[0]
    avg_rms = float(np.mean(rms))

    # Pitch (fundamental frequency)
    pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
    pitch_values = pitches[magnitudes > np.max(magnitudes) * 0.1]

    avg_pitch = float(np.mean(pitch_values)) if len(pitch_values) > 0 else 0.0
    pitch_variance = float(np.var(pitch_values)) if len(pitch_values) > 0 else 0.0

    tone = {
        "avg_rms": avg_rms,
        "avg_pitch_hz": avg_pitch,
        "pitch_variance": pitch_variance,
    }

    return tone


if __name__ == "__main__":
    tone = analyze_tone("audio/devfest-test-1.m4a")
    print("\nTone analysis result:")
    print(tone)
