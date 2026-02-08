import pretty_midi

pm = pretty_midi.PrettyMIDI()

# tempo
pm._tempo_changes = ([0.0], [120])

# instruments
drums = pretty_midi.Instrument(program=0, is_drum=True)
bass = pretty_midi.Instrument(program=pretty_midi.instrument_name_to_program("Electric Bass (finger)"))
pad = pretty_midi.Instrument(program=pretty_midi.instrument_name_to_program("Pad 1 (new age)"))

# add notes
for bar in range(16):
    start = bar * 2

    # kick drum
    drums.notes.append(pretty_midi.Note(velocity=100, pitch=36, start=start, end=start + 0.1))

    # bass note
    bass.notes.append(pretty_midi.Note(velocity=80, pitch=36, start=start, end=start + 2))

    # pad chord
    pad.notes.append(pretty_midi.Note(velocity=60, pitch=48, start=start, end=start + 2))


pm.instruments.append(drums)
pm.instruments.append(bass)
pm.instruments.append(pad)

pm.write("beat.mid")

