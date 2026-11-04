@echo off
rem Builds src/chordino/chordino.js (WebAssembly embedded) from the sources in this folder.
rem Needs the Emscripten SDK, by default in %USERPROFILE%\emsdk (or set EMSDK).
setlocal
if not defined EMSDK set "EMSDK=%USERPROFILE%\emsdk"
call "%EMSDK%\emsdk_env.bat" >nul 2>&1
cd /d "%~dp0"
if not exist build mkdir build

set SDK=vamp-plugin-sdk
set FLAGS=-O3 -DCHORDINO_NO_DICT_FILE -I%SDK% -Wno-deprecated-declarations

call emcc %FLAGS% -c nnls-chroma\nnls.c -o build\nnls.o || exit /b 1
call em++ %FLAGS% -std=c++14 ^
  web\plugin.cpp web\host.cpp ^
  nnls-chroma\Chordino.cpp nnls-chroma\NNLSBase.cpp nnls-chroma\chromamethods.cpp nnls-chroma\viterbi.cpp ^
  %SDK%\src\vamp-sdk\PluginAdapter.cpp %SDK%\src\vamp-sdk\RealTime.cpp ^
  %SDK%\src\vamp-hostsdk\PluginHostAdapter.cpp %SDK%\src\vamp-hostsdk\PluginInputDomainAdapter.cpp ^
  %SDK%\src\vamp-hostsdk\PluginWrapper.cpp %SDK%\src\vamp-hostsdk\RealTime.cpp %SDK%\src\vamp-hostsdk\Files.cpp ^
  build\nnls.o ^
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sSINGLE_FILE=1 -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH=1 ^
  -sEXPORTED_FUNCTIONS=_chordino_run,_malloc,_free -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPF32 ^
  -o ..\src\chordino\chordino.js || exit /b 1
echo Built src\chordino\chordino.js
