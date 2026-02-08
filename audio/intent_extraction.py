from openai import OpenAI
import json
import pathlib

client = OpenAI()

def transcribe_audio(audio_path: str) -> str:
    path = pathlib.Path(audio_path)
    with path.open("rb") as f:
        transcript = client.audio.transcriptions.create(
            file=f,
            model="gpt-4o-transcribe"
        )
    return transcript.text.strip()


def extract_intent(transcript: str) -> dict:
    prompt = f"""
    Given the following spoken text, infer musical intent.

    Text:
    "{transcript}"

    Return ONLY valid JSON with:
    - mood (one word)
    - energy (low, medium, or high)
    - vibe (short descriptive phrase)
    """

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )


    return json.loads(response.choices[0].message.content)
