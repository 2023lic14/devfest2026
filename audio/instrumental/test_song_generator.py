from instrumental.song_generator import generate_instrumental

result = generate_instrumental(
    bpm=128,
    total_bars=28,
    chorus_start_bar=14,
    chorus_bars=4,
)

print(result)

