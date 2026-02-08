from instrumental.song_generator import generate_instrumental

result = generate_instrumental(
    bpm=128,
    chords=[50, 53, 55, 48],
    total_bars=28,
)

print(result)
