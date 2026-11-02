# Chord-er

Load an MP3 (or any audio file your browser can decode) and get a scrolling chord chart that plays along with the song. All the analysis runs locally in the browser. Nothing is uploaded. The only download is the stem separation model, which is fetched once from Hugging Face and then cached by the browser.

## Run

```sh
npm install
npm run dev      # then open the printed http://localhost:5173 URL
npm run build    # static build in dist/ (serve it with `npm run preview`)
```

## Using it

- Drop an audio file on the page or click **Open audio**.
- **Chords from** (top bar): right after loading, chords come from the full mix. Meanwhile the song is split into stems in the background (progress shows in the top bar). When that finishes, the chords switch to the **harmony** (bass + other instruments, without vocals and drums), so the sung melody can't pull the detection off. Switch back to **Full mix** to compare.
- **Space** plays or pauses. **← / →** jump 5 s. Drag the timeline or scroll over it to seek, and **Ctrl + scroll** to zoom.
- **Music** and **Chord synth** set the volume of the song and of a piano-like synth that plays the detected chords. The synth plays each chord when it starts and again on every downbeat, so you can hear whether the detection matches the song. It plays the chords as detected, ignoring **Transpose**.
- **Click** sets the volume of a metronome on the detected beat grid, with a higher click on each downbeat. Use it to check the grid separately from the chords. The song, chord synth and clicks share one Web Audio clock and are scheduled ahead, so at 1× they line up within a few milliseconds. At slower speeds, the browser's pitch-preserving time-stretch shifts the music by tens of milliseconds, so check timing at 1×.
- **Tempo** picks the beat grid: the detected tempo, its double or half, or another candidate. Turn on **Shift ½ beat** if the beats fall between the hits.
- **Chords** sets the chord vocabulary (major/minor only, add sevenths, or add dim/sus4).
- **Smoothing** sets how readily chords change. Raise it if the chart flickers, lower it if quick changes are missed.
- **Key bias** pulls chords toward the song's detected key. This matters for power chords and other voicings without a third: the 5th overtone of a low E sounds like a G#, so without the bias an E5 in an E minor song reads as E major. Lower it for songs that really use chords from outside the key (secondary dominants, borrowed chords).
- **Meter** and **Transpose** take effect immediately; there's no re-analysis.

## How it works

1. **Decode** (`src/audio.js`): `decodeAudioData` decodes and resamples to 22.05 kHz mono.
2. **Analyze** (`src/analysis/`, in a Web Worker):
   - **Beats** (`tempo.js`, ported from the drumcoach project): onset curves at 1 ms resolution from a kick band (< 150 Hz) and a snare/cymbal band (> 2.5 kHz). Tempo candidates come from windowed autocorrelation, preferring the double-tempo partner. Period and phase are refined with a comb search and a robust line fit through clear onsets, and drift is followed in 16-beat chunks.
   - **Chroma** (`chroma.js`): an 8192-point STFT (46 ms hop) with global tuning estimation, then a semitone spectrogram (A1–B6). Next come log compression, a temporal median filter (to suppress drums), whitening across pitch, and finally folding into treble and bass chroma.
3. **Beat grid** (`grid.js`, main thread): beats are built from the chosen tempo candidate (with the ×2 / ½ and half-beat-shift options), and the chroma (of the mix or of the harmony stems) is averaged per beat.
4. **Stem separation** (`src/separation/`, in a Web Worker): [HTDemucs](https://github.com/facebookresearch/demucs) v4 (Meta, MIT license) splits the song into drums, bass, other and vocals. It uses the [Ghilda/htdemucs-onnx](https://huggingface.co/Ghilda/htdemucs-onnx) export (166 MB, MIT, pinned to a commit) and runs with onnxruntime-web on WebGPU, falling back to WebAssembly. The model graph leaves out the STFT, so `demucs.js` reproduces the reference padding, STFT/iSTFT and overlapping 7.8 s segments in JS. Bass + other are resampled and analyzed for chroma like the full mix. Tempo detection keeps using the full mix, since it needs the drums.
5. **Decode chords** (`chords.js`, main thread, cheap): each beat's chroma is compared with chord templates that include harmonics, with a bonus when the bass note matches the root. Chords whose notes all fit the detected key (natural minor plus the raised 7th, for minor keys) get a small bonus. A Viterbi pass then smooths the result, and chord changes cost less on downbeats. Downbeats are inferred from where chord changes cluster. The key comes from Krumhansl–Schmuckler and sets sharp vs. flat spelling.
6. **View** (`src/view/timeline.js`): a canvas timeline with a fixed playhead, bar and beat grid, chord blocks colored by the circle of fifths, and a waveform.

## Notes

- The dev server and `npm run preview` send cross-origin isolation headers (`vite.config.js`), which lets onnxruntime-web use several CPU threads. Static hosting without these headers still works, but the CPU fallback is single-threaded.

## Limitations

Chord recognition from mixed audio is approximate. Expect mistakes with dense arrangements, heavy distortion, chords beyond the vocabulary (9ths, slash chords, etc.), tempo changes, and songs whose meter isn't 4/4 or 3/4.
