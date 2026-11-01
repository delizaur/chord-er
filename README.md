# Chord-er

Load an MP3 (or any audio file your browser can decode) and get a scrolling chord chart that plays along with the song. All the analysis runs locally in the browser. Nothing is uploaded.

## Run

```sh
npm install
npm run dev      # then open the printed http://localhost:5173 URL
npm run build    # static build in dist/ (serve it with `npm run preview`)
```

## Using it

- Drop an audio file on the page or click **Open audio**.
- **Space** plays or pauses. **← / →** jump 5 s. Drag the timeline or scroll over it to seek, and **Ctrl + scroll** to zoom.
- **Chords** sets the chord vocabulary (major/minor only, add sevenths, or add dim/sus4).
- **Smoothing** sets how readily chords change. Raise it if the chart flickers, lower it if quick changes are missed.
- **Meter** and **Transpose** take effect immediately; there's no re-analysis.

## How it works

1. **Decode** (`src/audio.js`): `decodeAudioData` decodes and resamples to 22.05 kHz mono.
2. **Analyze** (`src/analysis/`, in a Web Worker):
   - **Beats** (`beats.js`): a spectral-flux onset envelope, tempo from autocorrelation with a 120 BPM prior, then Ellis' dynamic-programming beat tracker.
   - **Chroma** (`chroma.js`): an 8192-point STFT with global tuning estimation, then a semitone spectrogram (A1–B6). Next come log compression, a temporal median filter (to suppress drums), whitening across pitch, and finally folding into treble and bass chroma.
   - The chroma is averaged per beat.
3. **Decode chords** (`chords.js`, main thread, cheap): each beat's chroma is compared with chord templates that include harmonics, with a bonus when the bass note matches the root. A Viterbi pass then smooths the result, and chord changes cost less on downbeats. Downbeats are inferred from where chord changes cluster. The key comes from Krumhansl–Schmuckler and sets sharp vs. flat spelling.
4. **View** (`src/view/timeline.js`): a canvas timeline with a fixed playhead, bar and beat grid, chord blocks colored by the circle of fifths, and a waveform.

## Limitations

Chord recognition from mixed audio is approximate. Expect mistakes with dense arrangements, heavy distortion, chords beyond the vocabulary (9ths, slash chords, etc.), tempo changes, and songs whose meter isn't 4/4 or 3/4.
