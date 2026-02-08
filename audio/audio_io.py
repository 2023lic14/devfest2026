from __future__ import annotations

"""
Audio IO helpers used by the local recording + pipeline scripts.

Design goals:
- Keep dependencies minimal (no ffmpeg/pydub required for WAV cleaning).
- Produce a "speech-friendly" WAV for transcription: mono, 16kHz, trimmed silence.
"""

import math
import struct
import wave
from array import array
from pathlib import Path
from typing import Tuple

import audioop


def _read_wav_bytes(input_path: str) -> Tuple[int, int, int, bytes]:
    """
    Read WAV audio and return (sample_rate, channels, sample_width_bytes, pcm_bytes).

    Supports:
    - PCM (format 1)
    - IEEE float32 (format 3) converted to int16 PCM

    `wave` cannot open float WAVs (format 3), so we parse RIFF directly.
    """
    path = Path(input_path)
    data = path.read_bytes()
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Not a RIFF/WAVE file.")

    fmt_audio_format = None
    fmt_channels = None
    fmt_sample_rate = None
    fmt_bits_per_sample = None
    data_bytes = None

    offset = 12
    # Chunk format: 4s id, u32 size, <size> payload, padded to even.
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > len(data):
            break

        if chunk_id == b"fmt " and chunk_size >= 16:
            (
                fmt_audio_format,
                fmt_channels,
                fmt_sample_rate,
                _byte_rate,
                _block_align,
                fmt_bits_per_sample,
            ) = struct.unpack_from("<HHIIHH", data, chunk_start)
        elif chunk_id == b"data":
            data_bytes = data[chunk_start:chunk_end]

        offset = chunk_end + (chunk_size % 2)  # padding

    if fmt_audio_format is None or fmt_channels is None or fmt_sample_rate is None or fmt_bits_per_sample is None:
        raise ValueError("Missing WAV fmt chunk.")
    if data_bytes is None:
        raise ValueError("Missing WAV data chunk.")

    channels = int(fmt_channels)
    sample_rate = int(fmt_sample_rate)

    if int(fmt_audio_format) == 1:
        # PCM
        sample_width = int(fmt_bits_per_sample) // 8
        if sample_width not in (1, 2, 3, 4):
            raise ValueError(f"Unsupported PCM sample width: {sample_width} bytes.")
        return sample_rate, channels, sample_width, data_bytes

    if int(fmt_audio_format) == 3 and int(fmt_bits_per_sample) == 32:
        # IEEE float32 -> int16 PCM
        floats = array("f")
        floats.frombytes(data_bytes)
        # WAV float is little-endian; Python array uses native endianness.
        if floats.itemsize != 4:
            raise ValueError("Unexpected float sample size.")
        if struct.pack("<I", 1) != struct.pack("=I", 1):
            floats.byteswap()

        pcm16 = array("h")
        for x in floats:
            if not math.isfinite(x):
                x = 0.0
            # Common float WAV convention: [-1, 1]
            x = max(-1.0, min(1.0, float(x)))
            pcm16.append(int(round(x * 32767.0)))

        pcm_bytes = pcm16.tobytes()
        return sample_rate, channels, 2, pcm_bytes

    raise ValueError(f"Unsupported WAV encoding (format={fmt_audio_format}, bits={fmt_bits_per_sample}).")


def _write_wav_bytes(out_path: str, sample_rate: int, channels: int, sample_width: int, pcm: bytes) -> None:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sample_width)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


def _trim_silence(
    pcm: bytes,
    sample_rate: int,
    sample_width: int,
    *,
    window_ms: int = 20,
    padding_ms: int = 500,
) -> bytes:
    if not pcm:
        return pcm

    # Work in mono (channels=1) throughout this module.
    bytes_per_sample = sample_width
    window_samples = max(1, int(sample_rate * (window_ms / 1000.0)))
    window_bytes = window_samples * bytes_per_sample

    rms_values = []
    for i in range(0, len(pcm), window_bytes):
        chunk = pcm[i : i + window_bytes]
        if not chunk:
            break
        rms_values.append(audioop.rms(chunk, sample_width))

    if not rms_values:
        return pcm

    peak = max(rms_values) or 1
    # Keep it conservative: only trim clear silence.
    threshold = max(200, int(peak * 0.05))

    first = next((idx for idx, v in enumerate(rms_values) if v >= threshold), None)
    last = next((idx for idx, v in enumerate(reversed(rms_values)) if v >= threshold), None)
    if first is None or last is None:
        return pcm
    last = len(rms_values) - 1 - last

    pad_windows = int((padding_ms / 1000.0) * sample_rate / window_samples)
    start_win = max(0, first - pad_windows)
    end_win = min(len(rms_values) - 1, last + pad_windows)

    start_b = start_win * window_bytes
    end_b = min(len(pcm), (end_win + 1) * window_bytes)
    return pcm[start_b:end_b]


def clean_input_audio(input_path: str, out_path: str = "clean_input.wav") -> str:
    """
    Prepare speech audio for transcription / blueprint generation.

    Output: mono 16kHz PCM WAV with light silence trimming and gentle gain.
    """
    input_path = str(input_path)
    out_path = str(out_path)

    # Only WAV is handled dependency-free. If you're feeding m4a/mp3, skip cleaning and
    # let the downstream pipeline handle it.
    if Path(input_path).suffix.lower() != ".wav":
        return input_path

    sr, channels, sample_width, pcm = _read_wav_bytes(input_path)

    # Mono
    if channels > 1:
        pcm = audioop.tomono(pcm, sample_width, 0.5, 0.5)
        channels = 1

    # Resample to 16kHz
    if sr != 16000:
        pcm, _state = audioop.ratecv(pcm, sample_width, channels, sr, 16000, None)
        sr = 16000

    # Trim silence (keep padding)
    pcm = _trim_silence(pcm, sr, sample_width)

    # Gentle gain (keep headroom). -3 dB ~= 0.707.
    pcm = audioop.mul(pcm, sample_width, 0.70710678)

    _write_wav_bytes(out_path, sr, channels, sample_width, pcm)
    return out_path


def clean_output_audio(input_path: str, out_path: str = "final_output.wav") -> str:
    """
    Placeholder "finishing" function for generated audio.
    Currently this is just a copy-through for WAV files.
    """
    input_path = str(input_path)
    out_path = str(out_path)
    if Path(input_path).suffix.lower() != ".wav":
        return input_path
    sr, channels, sample_width, pcm = _read_wav_bytes(input_path)
    _write_wav_bytes(out_path, sr, channels, sample_width, pcm)
    return out_path

