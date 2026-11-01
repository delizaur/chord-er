// Decodes a compressed audio file and returns a mono Float32Array resampled
// to `sampleRate` (the OfflineAudioContext does the resampling for us).
export async function decodeToMono(arrayBuffer, sampleRate) {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();

  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
  }
  return mono;
}
