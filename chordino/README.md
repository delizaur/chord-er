# Chordino for the browser

[Chordino](http://www.isophonics.net/nnls-chroma) (NNLS Chroma, by Matthias Mauch, Centre for Digital Music, Queen Mary University of London; GPL v2 or later) compiled to WebAssembly with Emscripten, so chord-er can show its chords next to its own.

- `nnls-chroma/`: the Chordino sources from [c4dm/nnls-chroma](https://github.com/c4dm/nnls-chroma) at commit `4c5f214a75cb354f8d8c933e161377c5b4d83713` (only the files Chordino needs). The one change is in `chromamethods.cpp`: with `CHORDINO_NO_DICT_FILE` defined, the external `chord.dict` file is not looked up and Boost is not needed, so the built-in chord dictionary is used, as when no `chord.dict` is installed.
- `vamp-plugin-sdk/`: the needed parts of the [Vamp plugin SDK](https://github.com/vamp-plugins/vamp-plugin-sdk) v2.10 (`67adfc2bf9486912a0fce5123cf54360ea2678bc`, BSD-style license, unchanged).
- `web/`: the glue. `plugin.cpp` exposes Chordino through the Vamp C API, and `host.cpp` runs it the way Vamp hosts do: `PluginHostAdapter` around the plugin, `PluginInputDomainAdapter` for the windowed FFT frames, default parameters and the plugin's preferred block (16384) and step (2048) sizes. `chordino_run()` returns the `simplechord` output as `<seconds>\t<label>` lines.

## Build

Needs the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), by default in `%USERPROFILE%\emsdk` (or set `EMSDK`). On Windows, run

```
chordino\build.bat
```

It writes `src/chordino/chordino.js`, an ES module with the WebAssembly embedded. That file is committed, so building the app doesn't need Emscripten.
