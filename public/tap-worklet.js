// Copies audio to the main thread as it flows past, so that it can be transcribed,
// and passes it through unchanged. AudioWorklets cannot be bundled, so this lives in public/.
class TapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0));
      for (let channel = 0; channel < outputs[0].length; channel++) {
        outputs[0][channel].set(input[channel] ?? input[0]);
      }
    }
    return true;
  }
}
registerProcessor("tap", TapProcessor);
