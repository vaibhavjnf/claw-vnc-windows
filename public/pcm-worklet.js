class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const i16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, input[i] * 32767));
      }
      this.port.postMessage(i16.buffer, [i16.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
