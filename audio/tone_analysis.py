import librosa
import numpy as np


def analyze_tone(audio_path: str) -> dict:
    """
    Extract raw acoustic features from speech audio.
    These are numeric and interpretation-free.
    """

    # Load audio (mono, consistent sample rate)
    y, sr = librosa.load(audio_path, mono=True)

    # --- ENERGY (loudness) ---
    rms = float(np.mean(librosa.feature.rms(y=y)))

    # --- PITCH ---
    pitches, magnitudes = librosa.piptrack(y=y, sr=sr)

    # Keep only confident pitch estimates
    mask = magnitudes > np.max(magnitudes) * 0.1
    pitch_values = pitches[mask]

    if len(pitch_values) > 0:
        avg_pitch = float(np.mean(pitch_values))
        pitch_std = float(np.std(pitch_values))
        pitch_cv = pitch_std / avg_pitch  # relative variation
    else:
        avg_pitch = 0.0
        pitch_cv = 0.0

    return {
        "avg_rms": rms,
        "avg_pitch_hz": avg_pitch,
        "pitch_cv": pitch_cv,
    }


def interpret_tone(features: dict) -> dict:
    """
    Convert raw acoustic features into human-readable tone labels.
    Thresholds are tuned for NORMAL SPEECH, not music.
    """

    rms = features["avg_rms"]
    pitch = features["avg_pitch_hz"]
    pitch_cv = features["pitch_cv"]

    # --- ENERGY (post-normalization aware) ---
    if rms < 0.1:
        energy = "low"
    elif rms < 0.2:
        energy = "medium"
    else:
        energy = "high"

    # --- PITCH HEIGHT ---
    if pitch == 0:
        pitch_level = "unknown"
    elif pitch < 200:
        pitch_level = "low"
    elif pitch < 350:
        pitch_level = "medium"
    else:
        pitch_level = "high"

    # --- EXPRESSIVENESS (relative pitch variation) ---
    if pitch_cv < 0.45:
        expressiveness = "flat"
    elif pitch_cv < 0.85:
        expressiveness = "moderate"
    else:
        expressiveness = "expressive"

    return {
        "energy_level": energy,
        "pitch_level": pitch_level,
        "expressiveness": expressiveness,
    }
