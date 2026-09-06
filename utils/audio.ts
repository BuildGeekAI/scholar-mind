let currentContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

export const stopAudio = () => {
  if (currentSource) {
    try {
      currentSource.stop();
      currentSource.disconnect();
    } catch (e) {
      // Ignore errors if already stopped or invalid
    }
    currentSource = null;
  }

  if (currentContext) {
    try {
      if (currentContext.state !== 'closed') {
        currentContext.close();
      }
    } catch (e) {
      // Ignore
    }
    currentContext = null;
  }
};

/**
 * The server wraps the model's headerless PCM into WAV before serving it, so
 * playback is a standard decode rather than hand-rolled sample conversion.
 * Only one clip plays at a time: every call stops whatever came before.
 */
const playBuffer = async (bytes: ArrayBuffer, onEnded?: () => void) => {
  stopAudio();
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext: AudioContext = new AudioContextClass();
    currentContext = audioContext;

    const buffer = await audioContext.decodeAudioData(bytes);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    currentSource = source;
    source.onended = () => {
      if (onEnded) onEnded();
    };
    source.start();
    return source;
  } catch (e) {
    console.error('Failed to play audio', e);
    stopAudio();
    if (onEnded) onEnded();
  }
};

export const playAudioUrl = async (url: string, onEnded?: () => void) => {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Audio request failed (${res.status})`);
    return await playBuffer(await res.arrayBuffer(), onEnded);
  } catch (e) {
    console.error('Failed to load audio', e);
    if (onEnded) onEnded();
  }
};

export const playAudioBlob = async (blob: Blob, onEnded?: () => void) =>
  playBuffer(await blob.arrayBuffer(), onEnded);
