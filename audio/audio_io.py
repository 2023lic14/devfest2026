from pydub import AudioSegment
from pydub.silence import detect_nonsilent
from pathlib import Path


def clean_input_audio(input_path: str, out_path: str = "clean_input.wav"):
    """
    Prepare speech audio for transcription / intent extraction.
    Conservative processing to avoid losing words.
    """

    audio = AudioSegment.from_file(input_path)

    # 1) Convert to mono, 16kHz (ASR sweet spot)
    audio = audio.set_channels(1).set_frame_rate(16000)

    # 2) Detect non-silent regions (gentle)
    nonsilent = detect_nonsilent(
        audio,
        min_silence_len=200,   # ms
        silence_thresh=-35     # dBFS (not aggressive)
    )

    # 3) Trim silence BUT keep padding
    if nonsilent:
        start = max(0, nonsilent[0][0] - 500)   # 500 ms padding
        end = min(len(audio), nonsilent[-1][1] + 500)
        audio = audio[start:end]

    # 4) Gentle gain only (keep headroom)
    audio = audio.apply_gain(-3)

    # 5) Export
    audio.export(out_path, format="wav")
    return out_path
