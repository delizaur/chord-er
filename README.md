# Chord-er

Load an MP3 (or any audio file your browser can decode) and get a scrolling chord chart that plays along with the song. All the analysis runs locally in the browser. Nothing is uploaded. The only downloads are two models, for beat tracking (82 MB) and stem separation (166 MB). Each is fetched once from Hugging Face and then cached by the browser.

## Run

```sh
npm install
npm run dev      # then open the printed http://localhost:5173 URL
npm run build    # static build in dist/ (serve it with `npm run preview`)
```

## Using it

- Drop an audio file on the page or click **Open audio**.
- Right after loading, the song is playable with a steady-tempo beat grid and chords from the full mix. Two steps then run in the background, with progress in the top bar:
  1. **Beat tracking** (a few seconds): the grid switches to beats from the Beat This! model, which follow tempo changes, and to the downbeats it found.
  2. **Stem separation** (tens of seconds): **Chords from** switches to the **harmony** (bass + other instruments, without vocals and drums), so the sung melody can't pull the detection off. Switch back to **Full mix** to compare. The bass stem also gives the bass line for slash chords.
- **Slash chords** (top bar, on by default once the stems are separated): when the bass plays a note other than the chord's root, the chord shows it, as in C/E. A chord is split wherever the bass moves under it, so a bass walking down under a held C reads C, C/B, C/A, C/G. The chord synth plays the detected bass note. A short piece that can't fit its full name shows just the bass ("/E").
- **Space** plays or pauses. **← / →** jump 5 s. Drag the timeline or scroll over it to seek, and **Ctrl + scroll** to zoom.
- **Music** and **Chord synth** set the volume of the song and of a piano-like synth that plays the detected chords. The synth plays each chord when it starts and again on every downbeat, so you can hear whether the detection matches the song. It plays the chords as detected, ignoring **Transpose**.
- **Click** sets the volume of a metronome on the detected beat grid, with a higher click on each downbeat. Use it to check the grid separately from the chords. The song, chord synth and clicks share one Web Audio clock and are scheduled ahead, so at 1× they line up within a few milliseconds. At slower speeds, the browser's pitch-preserving time-stretch shifts the music by tens of milliseconds, so check timing at 1×.
- **Tempo** picks the beat grid. **Beat This!** (the default once ready) follows tempo changes, at the tracked tempo or its half or double. **Steady tempo** options are a single tempo for the whole song: the detected one, its double or half, or another candidate. Turn on **Shift ½ beat** if the beats fall between the hits. The top bar shows the tempo, or its range when it moves.
- **Chords** sets the chord vocabulary (major/minor only, add sevenths, or add dim/sus4).
- **Smoothing** sets how readily chords change. Raise it if the chart flickers, lower it if quick changes are missed.
- **Key bias** pulls chords toward the song's detected key. This matters for power chords and other voicings without a third: the 5th overtone of a low E sounds like a G#, so without the bias an E5 in an E minor song reads as E major. Lower it for songs that really use chords from outside the key (secondary dominants, borrowed chords).
- **Meter** sets the beats per bar for the steady-tempo grids, where bars are inferred from where chords change. With Beat This! the bars come from its downbeats, can change length, and Meter is disabled.
- All of these take effect immediately; there's no re-analysis.

## How it works

1. **Decode** (`src/audio.js`): `decodeAudioData` decodes and resamples to 22.05 kHz mono.
2. **Analyze** (`src/analysis/`, in a Web Worker):
   - **Steady-tempo beats** (`tempo.js`, ported from the drumcoach project): onset curves at 1 ms resolution from a kick band (< 150 Hz) and a snare/cymbal band (> 2.5 kHz). Tempo candidates come from windowed autocorrelation, preferring the double-tempo partner. Period and phase are refined with a comb search and a robust line fit through clear onsets, and drift is followed in 16-beat chunks.
   - **Chroma** (`chroma.js`): an 8192-point STFT (46 ms hop) with global tuning estimation, then a semitone spectrogram (E1–B6). Next come log compression, a temporal median filter (to suppress drums), whitening across pitch, and finally folding into treble and bass chroma.
   - **Bass-note salience** (`chroma.js`): each candidate bass note from E1 to E3 sums its fundamental and first overtones in the semitone spectrogram (subharmonic summation). The fundamental of a bass line then outscores its own octave, fifth and third partials.
3. **Beat tracking** (`src/beats/`, in a Web Worker): [Beat This!](https://github.com/CPJKU/beat_this) (Foscarin, Schlüter & Widmer, ISMIR 2024, MIT license) predicts beat and downbeat activations. It uses the [aaatmy/beat-this-onnx](https://huggingface.co/aaatmy/beat-this-onnx) export (82 MB, MIT, pinned to a commit). `beatThis.js` reproduces the reference log-mel front end and the overlapping 30 s chunks. `dbn.js` ports madmom's DBN beat tracker (55–215 BPM), which follows tempo drift without jumping between half and double time. A small HMM then groups the beats into bars of 3 or 4. Each beat is moved to the network's activation peak and refined between frames.
4. **Beat grid** (`grid.js`, main thread): beats come from Beat This! or a steady-tempo candidate (with the ×2 / ½ and half-beat-shift options). The grid is extended to the start and end of the song, and the chroma (of the mix or of the harmony stems) is averaged per beat.
5. **Stem separation** (`src/separation/`, in a Web Worker): [HTDemucs](https://github.com/facebookresearch/demucs) v4 (Meta, MIT license) splits the song into drums, bass, other and vocals. It uses the [Ghilda/htdemucs-onnx](https://huggingface.co/Ghilda/htdemucs-onnx) export (166 MB, MIT, pinned to a commit) and runs with onnxruntime-web on WebGPU, falling back to WebAssembly. The model graph leaves out the STFT, so `demucs.js` reproduces the reference padding, STFT/iSTFT and overlapping 7.8 s segments in JS. It returns the bass and other stems separately from one pass. Bass + other (the harmony) are analyzed for chroma like the full mix, and the bass stem alone for bass-note salience. Tempo detection keeps using the full mix, since it needs the drums.
6. **Decode chords** (`chords.js`, main thread, cheap): each beat's chroma is compared with chord templates that include harmonics, with a bonus when the bass plays the root (or, less, the third or fifth, so inversions keep their chord). Chords whose notes all fit the detected key (natural minor plus the raised 7th, for minor keys) get a small bonus. A Viterbi pass then smooths the result, and chord changes cost less on downbeats. Downbeats come from Beat This!, or, for steady-tempo grids, are inferred from where chord changes cluster. The key comes from Krumhansl–Schmuckler and sets sharp vs. flat spelling. With the bass stem, the bass note of each beat (smoothed by its own Viterbi pass, or none where the bass is silent) splits chords where it changes and adds the slash.
7. **View** (`src/view/timeline.js`): a canvas timeline with a fixed playhead, bar and beat grid, chord blocks colored by the circle of fifths, and a waveform.

## Notes

- The dev server and `npm run preview` send cross-origin isolation headers (`vite.config.js`), which lets onnxruntime-web use several CPU threads. Static hosting without these headers still works, but the CPU fallback is single-threaded.

## Limitations

Chord recognition from mixed audio is approximate. Expect mistakes with dense arrangements, heavy distortion, chords beyond the vocabulary (9ths, slash chords, etc.), and songs whose meter isn't 3/4 or 4/4. Beat This! can still switch between half and double time where the music changes feel, and its beats tend to sit a few milliseconds after the drum hits.
