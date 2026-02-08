import sounddevice as sd
from scipy.io.wavfile import write
import run_intent_pipeline

FS = 44100
DURATION = 15  # seconds

print("Recording...")
audio = sd.rec(int(DURATION * FS), samplerate=FS, channels=1)
sd.wait()
write("live_input.wav", FS, audio)

intent = run_intent_pipeline.run("live_input.wav")
print(intent)
