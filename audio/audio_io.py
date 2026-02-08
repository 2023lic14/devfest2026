from pydub import AudioSegment
from pathlib import Path


def clean_input_audio(input_path: str, out_path: str = "clean_input.wav"): # prepares user audio for elevenlabs (mono, normalize, trim silence)

    audio = AudioSegment.from_file(input_path)

    audio = audio.set_channels(1)
    audio = audio.normalize()
    audio = audio.strip_silence(
        silence_len=500,
        silence_thresh=-40
    )

    audio.export(out_path, format="wav")
    return out_path


def clean_output_audio(input_path: str, out_path: str = "final_output.wav"): # normalize elevenlabs output


    audio = AudioSegment.from_file(input_path)
    audio = audio.normalize()
    audio.export(out_path)
    return out_path


clean_input_audio("devfest-test-1.m4a")