
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

export const playPcmAudio = async (base64String: string, onEnded?: () => void) => {
  // Stop any existing playback first to prevent overlap
  stopAudio();

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: 24000 });
    currentContext = audioContext;
    
    // Decode Base64 to binary
    const binaryString = atob(base64String);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert Int16 PCM to Float32 for Web Audio API
    const dataInt16 = new Int16Array(bytes.buffer);
    const buffer = audioContext.createBuffer(1, dataInt16.length, 24000);
    const channelData = buffer.getChannelData(0);
    
    for (let i = 0; i < dataInt16.length; i++) {
      channelData[i] = dataInt16[i] / 32768.0;
    }

    // Play
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    
    currentSource = source;

    source.onended = () => {
      // Trigger callback when audio finishes (naturally or stopped)
      if (onEnded) onEnded();
    };
    
    source.start();
    return source;
  } catch (e) {
    console.error("Failed to play audio", e);
    stopAudio();
    if (onEnded) onEnded();
  }
};
