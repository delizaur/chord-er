# Chord-er

Load an MP3 (or any audio file your browser can decode) and get a scrolling chord chart that plays along with the song. All the analysis runs locally in the browser. Nothing is uploaded. The only downloads are two optional AI models, for beat tracking (82 MB) and stem separation (166 MB). Each is fetched once from Hugging Face, only when you choose an option that needs it, and then cached by the browser.

**Live:** https://delizaur.github.io/chord-er/ (Chrome or Edge on desktop recommended, for WebGPU).

## Run

```sh
npm install
npm run dev      # then open the printed http://localhost:5173 URL
npm run build    # static build in dist/ (serve it with `npm run preview`)
```

In development (`npm run dev`), the separated stems of each song are kept in the browser's Cache Storage (`chord-er-dev-stems`, keyed by the file's SHA-256), so loading the same song again skips the stem separation. Clear the site data to drop them. Production builds don't include this.

## Using it

Drop an audio file on the page or click **Open audio**. The song is playable right away, with the chords from chord-er's detector on the full mix. Everything in the sidebar on the right is remembered, across songs and visits.

**AI models.** Three choices need an AI model: **Chords from → Harmony** and **Slash chords** need stem separation (166 MB), and **Tempo → Beat This!** needs beat tracking (82 MB). Choosing one asks before the model is downloaded the first time; **Not now** turns the choice back off. Once a model is cached, it runs whenever the settings need it, with progress in the top bar.

### Song setup

- **Chords from**: the **full mix**, or the **harmony** (bass + other instruments, without vocals and drums), so the sung melody can't pull the detection off.
- **Timing** sets when chords may change. **Free** (the default) lets chords change wherever the harmony and bass do, independent of the beats, which suits songs without drums or a steady pulse. **On beats** snaps changes to the beat grid, which helps on songs with a clear beat. **Auto** uses free timing when the separated drums are (nearly) silent, else beats. Bar lines, beat dots and the click always follow the beat grid.
- **Tempo** picks the beat grid. **Steady tempo** options are a single tempo for the whole song: the detected one, its double or half, or another candidate. **Beat This!** follows tempo changes, at the tracked tempo or its half or double, and finds the downbeats. Turn on **Shift beats by ½** if the beats fall between the hits. The top bar shows the tempo, or its range when it moves.
- **Meter** sets the beats per bar for the steady-tempo grids, where bars are inferred from where chords change. With Beat This! the bars come from its downbeats, can change length, and Meter is disabled.

### Harmony detector

- **chord-er** (the default) is this app's own detector, with two settings:
  - **Smoothing** sets how readily chords and bass notes change. Raise it if the chart flickers, lower it if quick changes are missed. Above the middle, short slash chords are also left out: up to 1 beat long at 7.5, up to 2 beats at the maximum.
  - **Key bias** pulls chords toward the song's detected key. This matters for voicings without a third: the 5th overtone of a low E sounds like a G#, so without the bias an E5 in an E minor song reads as E major. Lower it for songs that really use chords from outside the key (secondary dominants, borrowed chords).
- **Chordino** shows the chords [Chordino](http://www.isophonics.net/nnls-chroma) finds, for comparison: the same chord-estimation plugin as in Sonic Visualiser, compiled to WebAssembly and run in the browser (a few seconds per song, no download beyond the app). It analyzes the source chosen in **Chords from**. Its chords keep Chordino's slash chords. With **Timing** on beats (or Auto choosing beats), its chord changes are put on the beat grid: each beat takes the Chordino chord that covers most of it. With free timing they keep Chordino's own timing. Its settings, the same as in Sonic Visualiser and at the same defaults (**Reset to defaults** restores them), re-run it when changed (sliders apply when released; each combination is kept, so going back is instant):
  - **NNLS transcription**: estimates which notes are played, taking their overtones out, before matching chords. Off uses the plain spectrum.
  - **Spectral shape** (0.5–0.9): how strong each note's higher harmonics are assumed to be. Higher suits bright, harmonic-rich sounds such as distorted guitars, and can stop overtones from reading as a major third.
  - **Whitening** (0–1): evens out loud and quiet frequency regions before the transcription. Low values can leave Chordino's chroma out of range, so most of the song reads as no chord.
  - **Bass noise** (0–5 %): ignores the lowest part of the spectrum, up to that share of the total energy, against rumble or a boomy kick.
  - **N.C. boost** (0–1): how readily it says there is no chord.
  - **Tuning**: **Global** estimates the tuning once; **Local** follows tuning that drifts.

### Chord namer

- **Allowed chords**: the chord qualities the detector may use. Major and minor are always allowed; **Sevenths** (7, maj7, m7), **sus2, sus4**, **Power chords**, **dim** and **aug** can be added. **Power chords**: a major or minor chord whose third is essentially silent (only the root and the fifth, typical of distorted guitars) is shown as a power chord, like E5, instead of guessing major or minor (chord-er's detector only). Chordino's chords outside the allowed ones are reduced to the nearest allowed chord, e.g. Bm7 → Bm without sevenths.
- **Slash chords**: when the bass plays a note other than the chord's root, the chord shows it, as in C/E. A chord is split wherever the bass moves under it, so a bass walking down under a held C reads C, C/B, C/A, C/G. The bass synth plays the detected bass note. A short piece that can't fit its full name shows just the bass ("/E"). The options below work on the slash chords:
  - **Re-spell slashes**: a slash chord is renamed as the chord built on its bass note, when its notes plus the bass make exactly a major, minor, 7, maj7, m7, dim, sus4, sus2 or 6 chord, or a maj7 has its 6th in the bass (which makes an m9). F#sus4/B becomes Bsus2, C/A becomes Am7, F/D becomes Dm7 and Dbmaj7/Bb becomes Bbm9. Slash chords that would need a complicated name, such as C/B, and plain inversions, such as C/E, stay as they are.
  - **Early changes** (chord-er's detector): when the bass moves to the next chord's root up to 2 beats before the harmony changes (Bb/D → Dm), that chord starts where the bass moved, instead of a short slash chord before it. This catches syncopated changes that come ahead of the downbeat, which the smoothed harmony picks up late. Turn it off for songs where the bass really moves under a held chord first.
  - **Rebuild on bass** (chord-er's detector, experimental): a slash chord X/Y that's still left is re-read as a chord built on its bass note Y that fits the key, when the audio supports it. In B minor, Bm7/F# can become F#m or F#m7. Unlike re-spelling, this looks at the audio again and counts quieter notes the chord detection passed over (the C# and E of F#m7). The new chord must fit the piece's notes nearly as well as X/Y, all its notes must actually sound, and the notes of X it leaves out must be quiet; otherwise the slash chord stays. Only major, minor, 7, maj7 and m7 chords are tried.

### Mixer

- **Music**, **Chord synth** and **Bass synth** set the volume of the song, of a piano-like synth that plays the detected chords, and of a synth bass that plays the detected bass note. The chord synth plays each chord when it starts and again on every downbeat. The bass synth plays whenever the bass note changes and on every downbeat; it follows the chord roots where no bass line is known. Together they let you hear whether the detection matches the song. Both play what was detected, ignoring **Transpose**.
- **Click** sets the volume of a metronome on the detected beat grid, with a higher click on each downbeat. Use it to check the grid separately from the chords. The song, chord synth and clicks share one Web Audio clock and are scheduled ahead, so at 1× they line up within a few milliseconds. At slower speeds, the browser's pitch-preserving time-stretch shifts the music by tens of milliseconds, so check timing at 1×.
- **Stems**: **Vocals**, **Drums**, **Bass** and **Other** once the stems are separated (or **Separate stems** to do it just for the mixer), e.g. to mute the vocals or to practice along without the bass. The stems are remixed into a single track that replaces the original, so the song briefly reloads after a change (it keeps its position and speed); with all four at full volume the original file plays.
- Every channel has **M** (mute) and **S** (solo). While any channel is soloed, only soloed channels play; soloing a stem keeps the music on with just the soloed stems.

### Player

- The **Notes in the harmony** graph highlights the current chord's tones in yellow and the bass note in blue.
- The timeline shows, between the chord blocks and the waveform, how strongly each of the 12 notes sounds over time (brighter is stronger, from the same data as the notes graph). The detected chord tones are overlaid in translucent yellow and the bass note in blue, so you can see where the detection follows the audio and where it doesn't.
- **Space** plays or pauses. **← / →** jump 5 s. Drag the timeline or scroll over it to seek, and **Ctrl + scroll** to zoom.
- All settings take effect immediately; only the AI models and Chordino take a moment, the first time they're needed for a song.

## How it works

1. **Decode** (`src/audio.js`): `decodeAudioData` decodes and resamples to 22.05 kHz mono.
2. **Analyze** (`src/analysis/`, in a Web Worker):
   - **Steady-tempo beats** (`tempo.js`, ported from the drumcoach project): onset curves at 1 ms resolution from a kick band (< 150 Hz) and a snare/cymbal band (> 2.5 kHz). Tempo candidates come from windowed autocorrelation, preferring the double-tempo partner. Period and phase are refined with a comb search and a robust line fit through clear onsets, and drift is followed in 16-beat chunks.
   - **Chroma** (`chroma.js`): an 8192-point STFT (46 ms hop) with global tuning estimation, then a semitone spectrogram (E1–B6). Next come log compression, a temporal median filter (to suppress drums), whitening across pitch, and finally folding into treble and bass chroma.
   - **Bass-note salience** (`chroma.js`): each candidate bass note from E1 to E3 sums its fundamental and first overtones in the semitone spectrogram (subharmonic summation). The fundamental of a bass line then outscores its own octave, fifth and third partials.
3. **Beat tracking** (`src/beats/`, in a Web Worker): [Beat This!](https://github.com/CPJKU/beat_this) (Foscarin, Schlüter & Widmer, ISMIR 2024, MIT license) predicts beat and downbeat activations. It uses the [aaatmy/beat-this-onnx](https://huggingface.co/aaatmy/beat-this-onnx) export (82 MB, MIT, pinned to a commit). `beatThis.js` reproduces the reference log-mel front end and the overlapping 30 s chunks. `dbn.js` ports madmom's DBN beat tracker (55–215 BPM), which follows tempo drift without jumping between half and double time. A small HMM then groups the beats into bars of 3 or 4. Each beat is moved to the network's activation peak and refined between frames.
4. **Beat grid** (`grid.js`, main thread): beats come from Beat This! or a steady-tempo candidate (with the ×2 / ½ and half-beat-shift options). The grid is extended to the start and end of the song, and the chroma (of the mix or of the harmony stems) is averaged per beat.
5. **Stem separation** (`src/separation/`, in a Web Worker): [HTDemucs](https://github.com/facebookresearch/demucs) v4 (Meta, MIT license) splits the song into drums, bass, other and vocals. It uses the [Ghilda/htdemucs-onnx](https://huggingface.co/Ghilda/htdemucs-onnx) export (166 MB, MIT, pinned to a commit) and runs with onnxruntime-web on WebGPU, falling back to WebAssembly. The model graph leaves out the STFT, so `demucs.js` reproduces the reference padding, STFT/iSTFT and overlapping 7.8 s segments in JS. It returns all four stems separately from one pass (kept as 16-bit audio for the stem volume sliders, mixed into a WAV by `stemMix.js`); the drums only measure whether the song has a beat to follow. Bass + other (the harmony) are analyzed for chroma like the full mix, and the bass stem alone for bass-note salience. Tempo detection keeps using the full mix, since it needs the drums.
6. **Decode chords** (`chords.js`, main thread, cheap): each beat's chroma is compared with chord templates that include harmonics, with a bonus when the bass plays the root (or, less, the third or fifth, so inversions keep their chord). Chords whose notes all fit the detected key (natural minor plus the raised 7th, for minor keys) get a small bonus. A Viterbi pass then smooths the result, and chord changes cost less on downbeats. Downbeats come from Beat This!, or, for steady-tempo grids, are inferred from where chord changes cluster. The key comes from Krumhansl–Schmuckler and sets sharp vs. flat spelling. With **Power chords** on, each major or minor chord's chroma, averaged over the whole chord, is compared with the triad's template and a root + fifth template (both with harmonics, so the third that the root's own overtones add doesn't count); it becomes a power chord when neither third reaches a fifth of the root and fifth level and root + fifth fit at least as well. With the bass stem, the bass note of each beat (smoothed by its own Viterbi pass, or none where the bass is silent) splits chords where it changes and adds the slash. With free timing, the same decoding runs on 0.2 s time slots instead of beats, with costlier changes for about the same smoothing per second. Each change then moves to the frame (46 ms) within ±0.3 s that best separates the two chords (or bass notes), and pieces shorter than 0.4 s join a neighbour.
7. **View** (`src/view/timeline.js`): a canvas timeline with a fixed playhead, bar and beat grid, chord blocks colored by the circle of fifths, a chromagram (one row per note, rendered once into a 12-pixel-tall image and scaled; each moment scaled to its loudest note) with the detected chord tones and bass note overlaid, and a waveform.

## Notes

- The dev server and `npm run preview` send cross-origin isolation headers (`vite.config.js`), which lets onnxruntime-web use several CPU threads. Static hosts can't send them, so `public/coi-serviceworker.js` ([coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), MIT) adds them from a service worker instead; the first visit reloads the page once to activate it.
- **Deployment:** `.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages on every push to `main` (Settings → Pages → Source: GitHub Actions). The build uses relative paths (`base: './'`), so it works from any subpath.

## Limitations

Chord recognition from mixed audio is approximate. Expect mistakes with dense arrangements, heavy distortion, chords beyond the vocabulary (9ths, slash chords, etc.), and songs whose meter isn't 3/4 or 4/4. Beat This! can still switch between half and double time where the music changes feel, and its beats tend to sit a few milliseconds after the drum hits.

## License

chord-er is licensed under the GNU General Public License, version 2 or (at your option) any later version; see `LICENSE`. It includes Chordino (GPL v2 or later) and parts of the Vamp plugin SDK (BSD-style license); see `chordino/README.md`.
