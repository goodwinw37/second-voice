// All audio routing, using the Web Audio API.
//
//   caller clip ──► tap ──► duck ──► pan left ──┐
//   coach clip  ─────────────────►  pan right ──┼──► your headphones
//   demo "you"  ──► tap ─────────►  centre ─────┘
//   microphone  ──► tap ──► muted (never played back)
//
// The tap sits before the duck, so turning the caller down for the coach never
// changes what speech recognition hears.
//
// The context runs at 16 kHz, the rate speech models expect, so there is no separate
// resampling step. It also sounds a little like a phone line, which suits the demo.

export const SAMPLE_RATE = 16000;

const CALLER_LEVEL = 1;
const DUCKED_LEVEL = 0.22;
const DUCK_SECONDS = 0.08;

export type FrameListener = (frame: Float32Array) => void;

export class AudioEngine {
  readonly context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  private clips = new Map<string, AudioBuffer>();
  private callerDuck = this.context.createGain();
  private callerOutput = this.context.createStereoPanner();
  private coachOutput = this.context.createStereoPanner();
  private callerTap!: AudioWorkletNode;
  private youTap!: AudioWorkletNode;
  private callerSource: AudioBufferSourceNode | null = null;
  private coachSource: AudioBufferSourceNode | null = null;
  private youSource: AudioBufferSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  onCallerFrame: FrameListener = () => {};
  onYouFrame: FrameListener = () => {};
  /** The browser stopped the microphone: permission revoked or device unplugged. */
  onMicLost: () => void = () => {};

  async start(): Promise<void> {
    await this.context.resume();
    await this.context.audioWorklet.addModule("/tap-worklet.js");
    if (this.context.state === "closed") return; // The person hung up while this was loading.

    this.callerOutput.pan.value = -1;
    this.coachOutput.pan.value = 1;
    this.callerDuck.connect(this.callerOutput).connect(this.context.destination);
    this.coachOutput.connect(this.context.destination);

    this.callerTap = new AudioWorkletNode(this.context, "tap");
    this.callerTap.port.onmessage = (e) => this.onCallerFrame(e.data);
    this.callerTap.connect(this.callerDuck);

    this.youTap = new AudioWorkletNode(this.context, "tap");
    this.youTap.port.onmessage = (e) => this.onYouFrame(e.data);
    this.youTap.connect(this.context.destination);
  }

  async preload(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        if (this.clips.has(id)) return;
        const response = await fetch(`/audio/${id}.wav`);
        if (!response.ok) throw new Error(`Missing audio clip: ${id}`);
        this.clips.set(id, await this.context.decodeAudioData(await response.arrayBuffer()));
      }),
    );
  }

  /** How long a clip lasts, or 0 if it isn't loaded. */
  clipSeconds(id: string): number {
    return this.clips.get(id)?.duration ?? 0;
  }

  private play(id: string, destination: AudioNode): { source: AudioBufferSourceNode; ended: Promise<void> } {
    const buffer = this.clips.get(id);
    if (!buffer) throw new Error(`Audio clip not loaded: ${id}`);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const ended = new Promise<void>((resolve) => (source.onended = () => resolve()));
    source.start();
    return { source, ended };
  }

  /** Plays a caller line in the left ear. Resolves when it finishes or is stopped. */
  playCaller(id: string): Promise<void> {
    const { source, ended } = this.play(id, this.callerTap);
    this.callerSource = source;
    return ended.then(() => {
      if (this.callerSource === source) this.callerSource = null;
    });
  }

  /** Plays a coach line in the right ear, with the caller turned down underneath. */
  playCoach(id: string): Promise<void> {
    this.stopCoach();
    const now = this.context.currentTime;
    this.callerDuck.gain.cancelScheduledValues(now);
    this.callerDuck.gain.setTargetAtTime(DUCKED_LEVEL, now, DUCK_SECONDS / 3);
    const { source, ended } = this.play(id, this.coachOutput);
    this.coachSource = source;
    return ended.then(() => {
      if (this.coachSource !== source) return;
      this.coachSource = null;
      this.callerDuck.gain.setTargetAtTime(CALLER_LEVEL, this.context.currentTime, DUCK_SECONDS);
    });
  }

  /** Plays a scripted reply for hands-free mode. It passes through the same tap as a microphone. */
  playYou(id: string): Promise<void> {
    const { source, ended } = this.play(id, this.youTap);
    this.youSource = source;
    return ended;
  }

  get coachSpeaking(): boolean {
    return this.coachSource !== null;
  }

  get callerSpeaking(): boolean {
    return this.callerSource !== null;
  }

  stopCaller(): void {
    this.callerSource?.stop();
    this.callerSource = null;
  }

  stopCoach(): void {
    const source = this.coachSource;
    this.coachSource = null;
    source?.stop();
  }

  stopYou(): void {
    this.youSource?.stop();
    this.youSource = null;
  }

  /** Connects the microphone. The returned audio is only transcribed, and never played back. */
  async openMic(): Promise<void> {
    // Echo cancellation is off because it made the mic deaf or garbled while the caller or coach was playing,
    // so "Hang up" went unheard. The cost is that this needs headphones, or the mic hears the coach.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // The person may have ended the call while the browser was asking for permission.
    if (this.context.state === "closed") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.micStream = stream;
    stream.getAudioTracks()[0]?.addEventListener("ended", () => this.onMicLost());
    this.micSource = this.context.createMediaStreamSource(stream);
  }

  /** Sends the microphone to the "you" channel (a practice call) or the "caller" channel (listen mode). */
  routeMicTo(channel: "you" | "caller"): void {
    if (!this.micSource) return;
    const tap = new AudioWorkletNode(this.context, "tap");
    tap.port.onmessage = (e) => (channel === "you" ? this.onYouFrame(e.data) : this.onCallerFrame(e.data));
    // A worklet only runs if it leads to the output, so this goes there through a muted gain.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.micSource.connect(tap).connect(mute).connect(this.context.destination);
  }

  /** Releases the microphone straight away, so the recording light goes off when the person says stop. */
  stopMic(): void {
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micSource?.disconnect();
    this.micStream = null;
    this.micSource = null;
  }

  async close(): Promise<void> {
    this.stopCaller();
    this.stopCoach();
    this.stopYou();
    this.stopMic();
    await this.context.close();
  }
}
