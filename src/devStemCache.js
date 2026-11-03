// Development only: keeps the separated stems of each song in Cache Storage, keyed by the file's
// SHA-256, so testing the same song again skips the stem separation. Not used in production
// builds, where a song's stems would cost ~170 MB of the user's storage.

const CACHE = 'chord-er-dev-stems';

async function requestFor(file) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return new Request(`/dev-stems/${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`);
}

// The stems as [left, right] Int16Arrays, or null when this file has none cached.
export async function loadStems(file, count) {
  try {
    const response = await (await caches.open(CACHE)).match(await requestFor(file));
    if (!response) return null;
    const data = new Int16Array(await response.arrayBuffer());
    const length = data.length / (2 * count);
    return Array.from({ length: count }, (_, k) => [0, 1].map((c) => data.subarray((2 * k + c) * length, (2 * k + c + 1) * length)));
  } catch {
    return null;
  }
}

export async function saveStems(file, stems) {
  try {
    const blob = new Blob(stems.flat());
    await (await caches.open(CACHE)).put(await requestFor(file), new Response(blob));
  } catch (err) {
    console.warn('Could not cache the stems:', err);
  }
}
