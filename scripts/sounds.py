"""Whisk's alert sounds, synthesized so they can be tuned and rebuilt.

    uv run --with numpy python scripts/sounds.py

Writes packages/shared/assets/sounds/*.wav (44.1 kHz, 16-bit mono PCM, which
iOS, Android, Chromium and Safari all play). Each note is modal synthesis: a
handful of partials at a struck bar's inharmonic ratios, each with its own
decay, the upper ones dying first, so it rings like a vibraphone or a small
bell instead of a beep. A short room reverb gives it air.

- meeting-soon: the meeting is a few minutes out. Two notes, a fifth apart,
  soft and round.
- meeting-now:  the meeting is starting. A rising three-note figure with a
  bright top, struck twice so it carries across a room.
- meeting-push: the phone's push. The rising figure once, with a longer ring
  (iOS plays up to 30 s; this stays under 3).
"""

import wave
from pathlib import Path

import numpy as np

RATE = 44_100
OUT = Path(__file__).resolve().parent.parent / "packages/shared/assets/sounds"

# Partial ratios, relative loudness and decay (seconds to fall by 60 dB).
VIBES = [(1.0, 1.0, 2.6), (2.0, 0.18, 1.4), (3.98, 0.32, 0.55), (9.2, 0.06, 0.18)]
BELL = [(1.0, 1.0, 2.2), (2.76, 0.45, 0.9), (5.40, 0.22, 0.42), (8.93, 0.1, 0.2), (0.5, 0.05, 1.6)]


def hz(note: str) -> float:
    names = {"C": -9, "D": -7, "E": -5, "F": -4, "G": -2, "A": 0, "B": 2}
    letter, rest = note[0], note[1:]
    shift = 0
    while rest and rest[0] in "#b":
        shift += 1 if rest[0] == "#" else -1
        rest = rest[1:]
    return 440.0 * 2 ** ((names[letter] + shift + (int(rest) - 4) * 12) / 12)


def strike(freq: float, partials, length: float, velocity: float = 1.0, tremolo: float = 0.0) -> np.ndarray:
    t = np.arange(int(length * RATE)) / RATE
    out = np.zeros_like(t)
    for ratio, gain, t60 in partials:
        f = freq * ratio
        if f > RATE / 2.2:
            continue
        # Harder strikes brighten the upper partials.
        g = gain * (velocity ** (1 + ratio / 4))
        env = np.exp(-6.91 * t / t60)
        # Two copies a hair apart in pitch: the slow beat makes it shimmer.
        out += g * env * (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 1.0012 * t + 0.7))
    # A 3 ms attack takes the click off without softening the strike.
    attack = np.minimum(1.0, t / 0.003)
    out *= attack
    # Close each strike over its last 80 ms: a ring cut short clicks.
    tail = int(0.08 * RATE)
    out[-tail:] *= np.linspace(1, 0, tail) ** 2
    if tremolo:
        out *= 1 - 0.18 * (1 - np.cos(2 * np.pi * tremolo * t)) / 2
    return out * velocity


def place(track: np.ndarray, sound: np.ndarray, at: float) -> None:
    i = int(at * RATE)
    n = min(len(sound), len(track) - i)
    track[i : i + n] += sound[:n]


def room(dry: np.ndarray, size: float = 0.32, mix: float = 0.18) -> np.ndarray:
    """A small Schroeder reverb: four combs in parallel, two allpasses in series."""
    wet = np.zeros_like(dry)
    for delay_ms, fb in [(29.7, 0.77), (37.1, 0.75), (41.1, 0.73), (43.7, 0.71)]:
        d = int(delay_ms * size / 0.32 * RATE / 1000)
        buf = np.zeros(len(dry) + d)
        for i in range(len(dry)):
            buf[i + d] = dry[i] + fb * buf[i]
        wet += buf[d:]
    for delay_ms, g in [(5.0, 0.7), (1.7, 0.7)]:
        d = int(delay_ms * RATE / 1000)
        y = np.zeros_like(wet)
        for i in range(len(wet)):
            x_d = wet[i - d] if i >= d else 0.0
            y_d = y[i - d] if i >= d else 0.0
            y[i] = -g * wet[i] + x_d + g * y_d
        wet = y
    return dry * (1 - mix) + wet * mix / 4


def highpass(x: np.ndarray, cutoff: float = 60.0) -> np.ndarray:
    """One-pole high-pass: no DC, no rumble a phone speaker would buzz on."""
    a = 1 / (1 + 2 * np.pi * cutoff / RATE)
    y = np.zeros_like(x)
    for i in range(1, len(x)):
        y[i] = a * (y[i - 1] + x[i] - x[i - 1])
    return y


def finish(track: np.ndarray, peak_db: float = -1.0) -> np.ndarray:
    track = highpass(room(track))
    # Fade the last 120 ms so nothing is cut mid-ring.
    fade = int(0.12 * RATE)
    track[-fade:] *= np.linspace(1, 0, fade) ** 2
    return track / np.max(np.abs(track)) * 10 ** (peak_db / 20)


def write(name: str, track: np.ndarray) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(track, -1, 1) * 32767).astype("<i2")
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    print(f"{name}.wav  {len(track) / RATE:.2f}s")


def soon() -> np.ndarray:
    track = np.zeros(int(1.9 * RATE))
    place(track, strike(hz("E5"), VIBES, 1.8, 0.8, tremolo=5.5), 0.0)
    place(track, strike(hz("B5"), VIBES, 1.7, 0.9, tremolo=5.5), 0.17)
    return finish(track, -3.0)


def rising(track: np.ndarray, at: float, velocity: float, ring: float) -> None:
    for i, note in enumerate(["G5", "B5", "D6"]):
        place(track, strike(hz(note), BELL, ring, velocity * (0.82 + 0.09 * i)), at + i * 0.11)
    # An octave sparkle over the top note.
    place(track, strike(hz("G6"), BELL, ring * 0.7, velocity * 0.45), at + 0.33)


def now() -> np.ndarray:
    track = np.zeros(int(2.6 * RATE))
    rising(track, 0.0, 1.0, 1.6)
    rising(track, 0.78, 0.9, 1.8)
    return finish(track)


def push() -> np.ndarray:
    track = np.zeros(int(2.4 * RATE))
    rising(track, 0.0, 1.0, 2.3)
    return finish(track)


if __name__ == "__main__":
    write("meeting-soon", soon())
    write("meeting-now", now())
    write("meeting-push", push())
