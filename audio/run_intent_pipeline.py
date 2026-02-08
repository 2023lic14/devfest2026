from audio_io import clean_input_audio
from intent_extraction import transcribe_audio, extract_intent
import sys
import json
from tone_analysis import analyze_tone, interpret_tone

def run(audio_path: str):
    print(f"Processing audio: {audio_path}")

    cleaned = clean_input_audio(audio_path)
    print("✓ Audio cleaned")

    tone = analyze_tone(cleaned)

    transcript = transcribe_audio(cleaned)
    print("✓ Transcription complete")
    print("Transcript:", transcript)

    intent = extract_intent(transcript)
    print("✓ Intent extracted")

    print("\nFinal intent:")
    print(json.dumps(intent, indent=2))

    print("\nVocal tone:")
    print(tone)

    print("\nTone interpretation:")
    print(interpret_tone(tone))

    return {
        "semantic_intent": intent,
        "vocal_tone": tone
    }



if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python audio/run_intent_pipeline.py <audio_file>")
        sys.exit(1)

    audio_file = sys.argv[1]
    run(audio_file)
