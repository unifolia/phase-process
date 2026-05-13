const CHANNEL_COUNT = 2;
const CHUNK_FRAMES = 4096;

class WavRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.left = new Float32Array(CHUNK_FRAMES);
    this.right = new Float32Array(CHUNK_FRAMES);
    this.offset = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "start") {
        this.reset();
        this.recording = true;
      } else if (message.type === "stop") {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  reset() {
    this.left = new Float32Array(CHUNK_FRAMES);
    this.right = new Float32Array(CHUNK_FRAMES);
    this.offset = 0;
  }

  flush() {
    if (this.offset === 0) {
      return;
    }

    const left = this.left.slice(0, this.offset);
    const right = this.right.slice(0, this.offset);
    this.port.postMessage(
      {
        type: "chunk",
        channels: [left, right],
        frames: this.offset,
      },
      [left.buffer, right.buffer],
    );
    this.reset();
  }

  append(leftInput, rightInput) {
    let sourceOffset = 0;
    const frameCount = leftInput.length;

    while (sourceOffset < frameCount) {
      const copyFrames = Math.min(
        CHUNK_FRAMES - this.offset,
        frameCount - sourceOffset,
      );
      this.left.set(
        leftInput.subarray(sourceOffset, sourceOffset + copyFrames),
        this.offset,
      );
      this.right.set(
        rightInput.subarray(sourceOffset, sourceOffset + copyFrames),
        this.offset,
      );
      this.offset += copyFrames;
      sourceOffset += copyFrames;

      if (this.offset === CHUNK_FRAMES) {
        this.flush();
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      output.forEach((channel) => channel.fill(0));
    }

    if (!this.recording) {
      return true;
    }

    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const leftInput = input[0];
    const rightInput = input[1] || input[0];
    this.append(leftInput, rightInput);
    return true;
  }
}

registerProcessor("wav-recorder-processor", WavRecorderProcessor);
