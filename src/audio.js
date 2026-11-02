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

// Decodes to [left, right] at `sampleRate`; mono files get the same signal on both sides.
export async function decodeToStereo(arrayBuffer, sampleRate) {
  const buffer = await new OfflineAudioContext(2, 1, sampleRate).decodeAudioData(arrayBuffer);
  const left = buffer.getChannelData(0).slice();
  return [left, buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice()];
}

// Mixes [left, right] to mono and resamples from `fromRate` to `toRate`.
export async function resampleToMono([left, right], fromRate, toRate) {
  const length = Math.ceil((left.length * toRate) / fromRate);
  const ctx = new OfflineAudioContext(1, length, toRate);
  const buffer = ctx.createBuffer(2, left.length, fromRate);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination); // the destination's single channel downmixes
  source.start();
  return (await ctx.startRendering()).getChannelData(0);
}
