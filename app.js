const MAX_TRACKS = 18;
const DEFAULT_BPM = 90;
const SETTINGS_VERSION = 2;
const UNITY_VOLUME = 0.7;
const DEFAULT_VOLUME = UNITY_VOLUME;
const DEFAULT_PAN = 0;
const SCHEDULE_AHEAD_SECONDS = 0.14;
const LOOKAHEAD_MS = 25;

const soundBank = [
  { id: "bells", label: "Bells" },
  { id: "frogs", label: "Frogs" },
  { id: "pipes", label: "Pipes" },
  { id: "clarinets", label: "Clarinets" },
];

const noteOffsets = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const starterTracks = [
  { sound: "clarinets", sequence: "C3, B3, G3, A3, A4" },
  { sound: "bells", sequence: "E5, B4, G4, B4, E5, G5" },
];

const state = {
  audioContext: null,
  master: null,
  recorderDestination: null,
  mediaRecorder: null,
  recordingChunks: [],
  recordingMimeType: "",
  recording: false,
  recordingStarting: false,
  timer: null,
  playing: false,
  bpm: DEFAULT_BPM,
  nextStepTime: 0,
  tick: 0,
  visualRunId: 0,
  tracks: [],
};

const els = {
  tracks: document.querySelector("#party-roster"),
  addTrack: document.querySelector("#summon-voice"),
  record: document.querySelector("#record-session"),
  recordLabel: document.querySelector("#record-session .record-label"),
  save: document.querySelector("#save-session"),
  upload: document.querySelector("#upload-session"),
  uploadInput: document.querySelector("#upload-state"),
  playToggle: document.querySelector("#open-portal"),
  tempo: document.querySelector("#haste-dial"),
  tempoReadout: document.querySelector("#haste-oracle"),
  pulseLight: document.querySelector("#heartbeat-rune"),
};

const eighthSeconds = () => {
  return 30 / state.bpm;
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
};

const normalizeVolume = (volume) => {
  return clamp(volume, 0, 1, DEFAULT_VOLUME);
};

const volumeToGain = (volume) => {
  return normalizeVolume(volume) / UNITY_VOLUME;
};

const normalizePan = (pan) => {
  return clamp(pan, -1, 1, DEFAULT_PAN);
};

const migrateSavedVolume = (track, version) => {
  if (version === SETTINGS_VERSION) {
    return normalizeVolume(track.volume);
  }
  if (track.volume === undefined) {
    return DEFAULT_VOLUME;
  }
  return normalizeVolume(normalizeVolume(track.volume) * UNITY_VOLUME);
};

const normalizeSoundId = (sound) => {
  return soundBank.some(({ id }) => id === sound) ? sound : soundBank[0].id;
};

const makeTrack = (seed = {}) => {
  const id =
    window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : String(Date.now() + Math.random());
  return {
    id,
    sound: normalizeSoundId(seed.sound),
    sequence: seed.sequence || "C3, E3, G3, A3",
    notes: [],
    error: "",
    muted: Boolean(seed.muted),
    volume: normalizeVolume(seed.volume),
    pan: normalizePan(seed.pan),
    settingsOpen: false,
    channel: null,
    activeStep: -1,
  };
};

const accidentalOffset = (accidental) => {
  if (!accidental) {
    return 0;
  }
  if (accidental.toLowerCase() === "x") {
    return 2;
  }
  if (accidental.startsWith("#")) {
    return accidental.length;
  }
  return -accidental.length;
};

const normalizeAccidental = (accidental) => {
  if (!accidental) {
    return "";
  }
  if (accidental.toLowerCase() === "x") {
    return "x";
  }
  if (accidental.startsWith("#")) {
    return accidental;
  }
  return "b".repeat(accidental.length);
};

const parseSequence = (value) => {
  const trimmed = value.trim();
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;

  if (!inner.trim()) {
    return { notes: [], error: "" };
  }

  const tokens = inner
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const notes = [];
  const rest = () => ({ label: "R", rest: true });

  tokens.forEach((token) => {
    const normalizedRest = token.toUpperCase();
    if (
      normalizedRest === "R" ||
      normalizedRest === "REST" ||
      token === "-" ||
      token === "_"
    ) {
      notes.push(rest());
      return;
    }

    const match = token.match(
      /^([A-Ga-g])(#{1,2}|[bB]{1,2}|[xX])?(-?\d{1,2})?$/,
    );
    if (!match) {
      notes.push(rest());
      return;
    }

    const letter = match[1].toUpperCase();
    const accidental = match[2] || "";
    const octave = match[3] === undefined ? 3 : Number(match[3]);

    if (!(letter in noteOffsets) || octave < 0 || octave > 8) {
      notes.push(rest());
      return;
    }

    const midi =
      (octave + 1) * 12 + noteOffsets[letter] + accidentalOffset(accidental);
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const label = `${letter}${normalizeAccidental(accidental)}${octave}`;
    notes.push({ label, frequency, rest: false });
  });

  return { notes, error: "" };
};

const syncParsedTracks = () => {
  state.tracks.forEach((track) => {
    const parsed = parseSequence(track.sequence);
    track.notes = parsed.notes;
    track.error = parsed.error;
    if (track.notes.length && track.activeStep >= track.notes.length) {
      track.activeStep = -1;
    }
  });
};

const initAudio = () => {
  if (state.audioContext) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  const master = audioContext.createGain();
  const compressor = audioContext.createDynamicsCompressor();
  const recorderDestination = audioContext.createMediaStreamDestination
    ? audioContext.createMediaStreamDestination()
    : null;

  master.gain.value = 0.72;
  compressor.threshold.value = -24;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.012;
  compressor.release.value = 0.2;

  master.connect(compressor);
  compressor.connect(audioContext.destination);
  if (recorderDestination) {
    compressor.connect(recorderDestination);
  }

  state.audioContext = audioContext;
  state.master = master;
  state.recorderDestination = recorderDestination;
};

const shapeGain = (gainParam, when, points) => {
  gainParam.cancelScheduledValues(when);
  points.forEach(([time, value, curve]) => {
    if (curve === "exp") {
      gainParam.exponentialRampToValueAtTime(
        Math.max(value, 0.0001),
        when + time,
      );
    } else if (time === 0) {
      gainParam.setValueAtTime(value, when);
    } else {
      gainParam.linearRampToValueAtTime(value, when + time);
    }
  });
};

const makeFilter = (audioContext, type, frequency, q = 0.5) => {
  const filter = audioContext.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
};

const syncTrackChannel = (track) => {
  if (!state.audioContext || !track.channel) {
    return;
  }

  const now = state.audioContext.currentTime;
  track.channel.gain.gain.setTargetAtTime(
    volumeToGain(track.volume),
    now,
    0.01,
  );
  if (track.channel.panner) {
    track.channel.panner.pan.setTargetAtTime(normalizePan(track.pan), now, 0.01);
  }
};

const ensureTrackChannel = (track) => {
  if (track.channel) {
    syncTrackChannel(track);
    return track.channel;
  }

  const gain = state.audioContext.createGain();
  const panner =
    state.audioContext.createStereoPanner &&
    state.audioContext.createStereoPanner();

  if (panner) {
    gain.connect(panner);
    panner.connect(state.master);
  } else {
    gain.connect(state.master);
  }

  track.channel = { input: gain, gain, panner };
  syncTrackChannel(track);
  return track.channel;
};

const destroyTrackChannel = (track) => {
  if (!track.channel) {
    return;
  }

  track.channel.input.disconnect();
  if (track.channel.panner) {
    track.channel.panner.disconnect();
  }
  track.channel = null;
};

const playBells = (note, when, duration, destination) => {
  const audioContext = state.audioContext;
  const out = audioContext.createGain();
  const tone = audioContext.createOscillator();
  const chime = audioContext.createOscillator();
  const filter = makeFilter(audioContext, "lowpass", 2600, 0.4);

  tone.type = "sine";
  chime.type = "triangle";
  tone.frequency.setValueAtTime(note.frequency, when);
  chime.frequency.setValueAtTime(note.frequency * 2.01, when);

  shapeGain(out.gain, when, [
    [0, 0.0001],
    [0.012, 0.32],
    [duration * 0.62, 0.11, "exp"],
    [duration + 0.22, 0.0001, "exp"],
  ]);

  tone.connect(filter);
  chime.connect(filter);
  filter.connect(out);
  out.connect(destination);

  tone.start(when);
  chime.start(when);
  tone.stop(when + duration + 0.26);
  chime.stop(when + duration + 0.26);
};

const playFrogs = (note, when, duration, destination) => {
  const audioContext = state.audioContext;
  const out = audioContext.createGain();
  const carrier = audioContext.createOscillator();
  const upper = audioContext.createOscillator();
  const filter = makeFilter(
    audioContext,
    "bandpass",
    Math.min(note.frequency * 3, 2800),
    0.85,
  );

  carrier.type = "sine";
  upper.type = "sine";
  carrier.frequency.setValueAtTime(note.frequency, when);
  upper.frequency.setValueAtTime(note.frequency * 1.5, when);

  shapeGain(out.gain, when, [
    [0, 0.0001],
    [0.018, 0.24],
    [duration * 0.48, 0.13, "exp"],
    [duration + 0.16, 0.0001, "exp"],
  ]);

  carrier.connect(filter);
  upper.connect(filter);
  filter.connect(out);
  out.connect(destination);

  carrier.start(when);
  upper.start(when);
  carrier.stop(when + duration + 0.2);
  upper.stop(when + duration + 0.2);
};

const playPipes = (note, when, duration, destination) => {
  const audioContext = state.audioContext;
  const out = audioContext.createGain();
  const oscA = audioContext.createOscillator();
  const oscB = audioContext.createOscillator();
  const filter = makeFilter(audioContext, "lowpass", 1150, 0.7);

  oscA.type = "triangle";
  oscB.type = "sine";
  oscA.frequency.setValueAtTime(note.frequency, when);
  oscB.frequency.setValueAtTime(note.frequency * 0.997, when);
  oscA.detune.setValueAtTime(-6, when);
  oscB.detune.setValueAtTime(5, when);

  shapeGain(out.gain, when, [
    [0, 0.0001],
    [0.055, 0.19],
    [Math.max(duration * 0.74, 0.08), 0.15],
    [duration + 0.3, 0.0001, "exp"],
  ]);

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(out);
  out.connect(destination);

  oscA.start(when);
  oscB.start(when);
  oscA.stop(when + duration + 0.34);
  oscB.stop(when + duration + 0.34);
};

const playClarinets = (note, when, duration, destination) => {
  const audioContext = state.audioContext;
  const out = audioContext.createGain();
  const oscA = audioContext.createOscillator();
  const oscB = audioContext.createOscillator();
  const filter = makeFilter(audioContext, "lowpass", 780, 0.45);

  oscA.type = "sine";
  oscB.type = "triangle";
  oscA.frequency.setValueAtTime(note.frequency * 0.5, when);
  oscB.frequency.setValueAtTime(note.frequency, when);
  oscB.detune.setValueAtTime(8, when);
  filter.frequency.setValueAtTime(520, when);
  filter.frequency.linearRampToValueAtTime(920, when + duration * 0.65);

  shapeGain(out.gain, when, [
    [0, 0.0001],
    [0.04, 0.2],
    [duration * 0.8, 0.17],
    [duration + 0.42, 0.0001, "exp"],
  ]);

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(out);
  out.connect(destination);

  oscA.start(when);
  oscB.start(when);
  oscA.stop(when + duration + 0.46);
  oscB.stop(when + duration + 0.46);
};

const players = {
  bells: playBells,
  frogs: playFrogs,
  pipes: playPipes,
  clarinets: playClarinets,
};

const playNote = (track, note, when) => {
  if (track.muted || note.rest || !players[track.sound]) {
    return;
  }
  const channel = ensureTrackChannel(track);
  players[track.sound](note, when, eighthSeconds() * 0.86, channel.input);
};

const scheduleStep = (tick, when) => {
  const runId = state.visualRunId;
  const plannedSteps = new Map();

  state.tracks.forEach((track) => {
    if (!track.notes.length) {
      return;
    }

    const step = tick % track.notes.length;
    plannedSteps.set(track.id, step);
    playNote(track, track.notes[step], when);
  });

  const visualDelay = Math.max(
    0,
    (when - state.audioContext.currentTime) * 1000,
  );
  window.setTimeout(() => {
    if (state.visualRunId !== runId || !state.playing) {
      return;
    }
    state.tracks.forEach((track) => {
      if (plannedSteps.has(track.id)) {
        track.activeStep = plannedSteps.get(track.id);
      }
    });
    paintActiveSteps();
    flashPulse(tick);
  }, visualDelay);
};

const scheduler = () => {
  while (
    state.nextStepTime <
    state.audioContext.currentTime + SCHEDULE_AHEAD_SECONDS
  ) {
    scheduleStep(state.tick, state.nextStepTime);
    state.nextStepTime += eighthSeconds();
    state.tick += 1;
  }
};

const startPlayback = async () => {
  syncParsedTracks();
  if (!state.tracks.some((track) => track.notes.length)) {
    return;
  }

  initAudio();
  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }

  if (state.playing) {
    return;
  }

  state.playing = true;
  state.visualRunId += 1;
  state.tick = 0;
  state.nextStepTime = state.audioContext.currentTime + 0.08;
  els.playToggle.textContent = "Pause";
  renderTracks();
  state.timer = window.setInterval(scheduler, LOOKAHEAD_MS);
  scheduler();
};

const pausePlayback = () => {
  if (!state.playing) {
    return;
  }

  state.playing = false;
  state.visualRunId += 1;
  window.clearInterval(state.timer);
  state.timer = null;
  els.playToggle.textContent = "Play";
  els.pulseLight.classList.toggle("is-lit", state.recording);
};

const timestampForFilename = () => {
  return new Date().toISOString().replace(/[:.]/g, "-");
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const recordingMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const getRecordingMimeType = () => {
  if (
    !window.MediaRecorder ||
    typeof window.MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }
  return (
    recordingMimeTypes.find((type) =>
      window.MediaRecorder.isTypeSupported(type),
    ) || ""
  );
};

const recordingExtension = (mimeType) => {
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("mp4")) {
    return "m4a";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "webm";
};

const updateRecordButton = () => {
  els.recordLabel.textContent = state.recording ? "Stop Rec" : "Record";
  els.record.disabled = state.recordingStarting;
  els.record.setAttribute("aria-pressed", String(state.recording));
  els.record.ariaLabel = state.recording
    ? "Stop recording"
    : "Record audio";
  els.pulseLight.classList.toggle("is-lit", state.recording);
};

const startRecording = async () => {
  if (state.recording || state.recordingStarting) {
    return;
  }

  state.recordingStarting = true;
  updateRecordButton();

  if (!window.MediaRecorder) {
    state.recordingStarting = false;
    updateRecordButton();
    window.alert("Audio recording is not supported in this browser.");
    return;
  }

  try {
    initAudio();
  } catch {
    state.recordingStarting = false;
    updateRecordButton();
    window.alert("Audio recording could not access the audio engine.");
    return;
  }

  if (!state.recorderDestination) {
    state.recordingStarting = false;
    updateRecordButton();
    window.alert("Audio recording is not supported in this browser.");
    return;
  }

  if (state.audioContext.state === "suspended") {
    try {
      await state.audioContext.resume();
    } catch {
      state.recordingStarting = false;
      updateRecordButton();
      window.alert("Audio recording could not access the audio engine.");
      return;
    }
  }

  const mimeType = getRecordingMimeType();
  let recorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(state.recorderDestination.stream, { mimeType })
      : new MediaRecorder(state.recorderDestination.stream);
  } catch {
    state.recordingStarting = false;
    updateRecordButton();
    window.alert("Audio recording could not be started in this browser.");
    return;
  }

  state.recordingChunks = [];
  state.recordingMimeType = mimeType || recorder.mimeType || "audio/webm";
  state.mediaRecorder = recorder;
  state.recording = true;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      state.recordingChunks.push(event.data);
    }
  });

  recorder.addEventListener(
    "stop",
    () => {
      const mime = state.recordingMimeType || recorder.mimeType || "audio/webm";
      const blob = new Blob(state.recordingChunks, { type: mime });
      state.recordingChunks = [];
      state.mediaRecorder = null;
      state.recording = false;
      state.recordingStarting = false;
      updateRecordButton();
      if (blob.size > 0) {
        downloadBlob(
          blob,
          `phase-process-recording-${timestampForFilename()}.${recordingExtension(
            mime,
          )}`,
        );
      }
    },
    { once: true },
  );

  try {
    recorder.start();
  } catch {
    state.recordingChunks = [];
    state.mediaRecorder = null;
    state.recording = false;
    state.recordingStarting = false;
    updateRecordButton();
    window.alert("Audio recording could not be started in this browser.");
    return;
  }
  state.recordingStarting = false;
  updateRecordButton();
};

const stopRecording = () => {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") {
    return;
  }
  state.mediaRecorder.stop();
};

const toggleRecording = () => {
  if (state.recordingStarting) {
    return;
  }

  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
};

const serializeNote = (note) => ({
  label: note.rest ? "R" : note.label,
  rest: Boolean(note.rest),
});

const serializeTrack = (track) => {
  const parsed = parseSequence(track.sequence);
  return {
    sound: track.sound,
    sequence: track.sequence,
    notes: parsed.notes.map(serializeNote),
    muted: track.muted,
    volume: normalizeVolume(track.volume),
    pan: normalizePan(track.pan),
  };
};

const buildProjectPayload = () => {
  syncParsedTracks();
  return {
    app: "phase-process",
    settingsVersion: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    bpm: state.bpm,
    tracks: state.tracks.map(serializeTrack),
  };
};

const saveProject = () => {
  const blob = new Blob([JSON.stringify(buildProjectPayload(), null, 2)], {
    type: "application/json",
  });
  downloadBlob(blob, `phase-process-${timestampForFilename()}.json`);
};

const sequenceFromNotes = (notes) => {
  if (!Array.isArray(notes) || !notes.length) {
    return undefined;
  }

  const labels = notes.map((note) => {
    if (typeof note === "string") {
      return note.trim() || "R";
    }
    if (!note || note.rest) {
      return "R";
    }
    return typeof note.label === "string" && note.label.trim()
      ? note.label.trim()
      : "R";
  });

  return labels.join(", ");
};

const normalizeImportedTrack = (track, settingsVersion) => {
  const source = track || {};
  return makeTrack({
    ...source,
    sequence:
      typeof source.sequence === "string" && source.sequence.trim()
        ? source.sequence
        : sequenceFromNotes(source.notes),
    volume: migrateSavedVolume(source, settingsVersion),
  });
};

const applyProjectPayload = (payload) => {
  const tracks = Array.isArray(payload) ? payload : payload && payload.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error("Project JSON must include at least one track.");
  }

  const settingsVersion = Array.isArray(payload)
    ? SETTINGS_VERSION
    : payload.settingsVersion;
  const nextTracks = tracks
    .slice(0, MAX_TRACKS)
    .map((track) => normalizeImportedTrack(track, settingsVersion));

  pausePlayback();
  state.tracks.forEach(destroyTrackChannel);
  state.bpm = Array.isArray(payload)
    ? DEFAULT_BPM
    : clamp(payload.bpm, 48, 218, DEFAULT_BPM);
  state.tracks = nextTracks;
  syncParsedTracks();
  renderTracks();
  persist();
};

const handleProjectUpload = async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    applyProjectPayload(JSON.parse(await file.text()));
  } catch (error) {
    window.alert(
      error instanceof Error
        ? error.message
        : "Project JSON could not be uploaded.",
    );
  } finally {
    event.target.value = "";
  }
};

const flashPulse = (tick) => {
  void tick;
};

const persist = () => {
  const payload = {
    settingsVersion: SETTINGS_VERSION,
    bpm: state.bpm,
    tracks: state.tracks.map(({ sound, sequence, muted, volume, pan }) => ({
      sound,
      sequence,
      muted,
      volume,
      pan,
    })),
  };
  localStorage.setItem("tide-index-state", JSON.stringify(payload));
};

const restore = () => {
  try {
    const raw = localStorage.getItem("tide-index-state");
    if (!raw) {
      return false;
    }
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved.tracks)) {
      return false;
    }
    state.bpm = Number(saved.bpm) || DEFAULT_BPM;
    state.tracks = saved.tracks
      .slice(0, MAX_TRACKS)
      .map((track) =>
        makeTrack({
          ...track,
          volume: migrateSavedVolume(track, saved.settingsVersion),
        }),
      );
    return state.tracks.length > 0;
  } catch {
    return false;
  }
};

const addTrack = (seed) => {
  if (state.tracks.length >= MAX_TRACKS) {
    return;
  }

  const track = makeTrack(seed);
  const parsed = parseSequence(track.sequence);
  track.notes = parsed.notes;
  track.error = parsed.error;
  state.tracks.push(track);
  els.tracks.append(renderTrack(track, state.tracks.length - 1));
  updateAddTrackButton();
  persist();
};

const removeTrack = (id) => {
  const index = state.tracks.findIndex((track) => track.id === id);
  if (index === -1) {
    return;
  }

  const [track] = state.tracks.splice(index, 1);
  destroyTrackChannel(track);

  const trackEl = [...els.tracks.querySelectorAll(".adventurer-card")].find(
    (candidate) => candidate.dataset.adventurerId === id,
  );
  if (trackEl) {
    trackEl.remove();
  }

  updateTrackOrder();
  updateAddTrackButton();
  persist();
};

const noteCountLabel = (count) => {
  return `${count} ${count === 1 ? "note" : "notes"}`;
};

const formatVolume = (volume) => {
  return `${Math.round(normalizeVolume(volume) * 100)}%`;
};

const formatPan = (pan) => {
  const normalized = normalizePan(pan);
  if (Math.abs(normalized) < 0.005) {
    return "0";
  }
  return String(Math.round(normalized * 100));
};

const updateSettingsReadouts = (trackEl, track) => {
  const volume = trackEl.querySelector("[data-readout='volume']");
  if (volume) {
    volume.textContent = formatVolume(track.volume);
  }

  const pan = trackEl.querySelector("[data-readout='pan']");
  if (pan) {
    pan.textContent = formatPan(track.pan);
  }
};

const syncCardFlipState = (trackEl, track) => {
  const settingsButton = trackEl.querySelector("button[data-action='settings']");
  const front = trackEl.querySelector(".track-front");
  const back = trackEl.querySelector(".track-back");
  const displayIndex = Number(trackEl.dataset.initiative) || 1;

  trackEl.classList.toggle("is-flipped", track.settingsOpen);
  if (settingsButton) {
    settingsButton.setAttribute("aria-pressed", String(track.settingsOpen));
    settingsButton.setAttribute(
      "aria-label",
      track.settingsOpen
        ? `Close track ${displayIndex} settings`
        : `Open track ${displayIndex} settings`,
    );
  }

  if (front) {
    front.inert = track.settingsOpen;
    front.setAttribute("aria-hidden", String(track.settingsOpen));
  }

  if (back) {
    back.inert = !track.settingsOpen;
    back.setAttribute("aria-hidden", String(!track.settingsOpen));
  }
};

const createSettingControl = ({
  track,
  action,
  label,
  min,
  max,
  step,
  value,
  format,
}) => {
  const control = document.createElement("label");
  control.className = "track-setting-control";

  const inputId = `${action}-${track.id}`;
  const header = document.createElement("span");
  header.className = "track-setting-header";

  const labelText = document.createElement("span");
  labelText.textContent = label;

  const readout = document.createElement("output");
  readout.dataset.readout = action;
  readout.setAttribute("for", inputId);
  readout.textContent = format(value);

  const slider = document.createElement("input");
  slider.id = inputId;
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.dataset.action = action;

  header.append(labelText, readout);
  control.append(header, slider);
  return control;
};

const createStepElement = (note, stepIndex, activeStep) => {
  const step = document.createElement("span");
  step.className = [
    "rune-stone",
    stepIndex === activeStep ? "is-glowing" : "",
    note.rest ? "is-resting" : "",
  ]
    .filter(Boolean)
    .join(" ");
  step.textContent = note.label;
  return step;
};

const updateTrackIndicators = (trackEl, track) => {
  const count = trackEl.querySelector(".initiative-count span");
  const front = trackEl.querySelector(".track-front") || trackEl;
  if (count) {
    count.textContent = noteCountLabel(track.notes.length || 0);
  }

  const steps = trackEl.querySelector(".rune-chain");
  if (steps) {
    steps.replaceChildren(
      ...track.notes.map((note, stepIndex) =>
        createStepElement(note, stepIndex, track.activeStep),
      ),
    );
  }

  let error = trackEl.querySelector(".curse-warning");
  if (track.error && !error) {
    error = document.createElement("p");
    error.className = "curse-warning";
    front.append(error);
  }

  if (error) {
    if (track.error) {
      error.textContent = track.error;
    } else {
      error.remove();
    }
  }
};

const renderTrack = (track, index) => {
  const article = document.createElement("article");
  article.className = [
    "adventurer-card",
    track.muted ? "is-silenced" : "",
    track.settingsOpen ? "is-flipped" : "",
  ]
    .filter(Boolean)
    .join(" ");
  article.dataset.adventurerId = track.id;
  article.dataset.initiative = String(index + 1);
  article.style.animationDelay = `${index * 55}ms`;

  const trackNumber = document.createElement("div");
  trackNumber.className = "initiative-count";
  trackNumber.innerHTML = `<strong>${index + 1}</strong><span>${noteCountLabel(track.notes.length || 0)}</span>`;
  const settings = document.createElement("button");
  settings.className = "track-settings-button";
  settings.type = "button";
  settings.dataset.action = "settings";
  settings.textContent = "Settings";
  trackNumber.append(settings);

  const front = document.createElement("div");
  front.className = "track-face track-front";

  const back = document.createElement("div");
  back.className = "track-face track-back";

  const soundBlock = document.createElement("div");
  soundBlock.className = "voice-grimoire";
  const soundLabel = document.createElement("label");
  const soundId = `voice-${track.id}`;
  soundLabel.setAttribute("for", soundId);
  soundLabel.textContent = "Sound";
  const select = document.createElement("select");
  select.id = soundId;
  select.dataset.action = "voice";
  soundBank.forEach((sound) => {
    const option = document.createElement("option");
    option.value = sound.id;
    option.textContent = sound.label;
    option.selected = sound.id === track.sound;
    select.append(option);
  });
  soundBlock.append(soundLabel, select);

  const sequenceBlock = document.createElement("div");
  sequenceBlock.className = "incantation-block";
  const sequenceLabel = document.createElement("label");
  const sequenceId = `incantation-${track.id}`;
  sequenceLabel.setAttribute("for", sequenceId);
  sequenceLabel.textContent = "Sequence";
  const textarea = document.createElement("textarea");
  textarea.id = sequenceId;
  textarea.dataset.action = "incantation";
  textarea.spellcheck = false;
  textarea.value = track.sequence;
  textarea.placeholder = "C3, D3, E3, G3";
  sequenceBlock.append(sequenceLabel, textarea);

  const tools = document.createElement("div");
  tools.className = "adventurer-tools";
  const mute = document.createElement("button");
  mute.className = "squire-action silence-button";
  mute.type = "button";
  mute.dataset.action = "silence";
  mute.textContent = track.muted ? "Unmute" : "Mute";
  const remove = document.createElement("button");
  remove.className = "banish-button";
  remove.type = "button";
  remove.dataset.action = "banish";
  remove.textContent = "X";
  remove.ariaLabel = `Remove track ${index + 1}`;
  tools.append(mute, remove);

  const settingsPanel = document.createElement("div");
  settingsPanel.className = "track-settings-panel";
  settingsPanel.append(
    createSettingControl({
      track,
      action: "volume",
      label: "Volume",
      min: 0,
      max: 1,
      step: 0.01,
      value: track.volume,
      format: formatVolume,
    }),
    createSettingControl({
      track,
      action: "pan",
      label: "Pan",
      min: -1,
      max: 1,
      step: 0.01,
      value: track.pan,
      format: formatPan,
    }),
  );
  back.append(settingsPanel);

  const steps = document.createElement("div");
  steps.className = "rune-chain";
  track.notes.forEach((note, stepIndex) => {
    steps.append(createStepElement(note, stepIndex, track.activeStep));
  });

  front.append(soundBlock, sequenceBlock, tools, steps);
  article.append(trackNumber, front, back);

  if (track.error) {
    const error = document.createElement("p");
    error.className = "curse-warning";
    error.textContent = track.error;
    front.append(error);
  }

  syncCardFlipState(article, track);
  return article;
};

const updateTrackOrder = () => {
  els.tracks.querySelectorAll(".adventurer-card").forEach((trackEl, index) => {
    const displayIndex = index + 1;
    const track = state.tracks.find(
      (candidate) => candidate.id === trackEl.dataset.adventurerId,
    );
    trackEl.dataset.initiative = String(displayIndex);

    const number = trackEl.querySelector(".initiative-count strong");
    if (number) {
      number.textContent = String(displayIndex);
    }

    const remove = trackEl.querySelector("button[data-action='banish']");
    if (remove) {
      remove.ariaLabel = `Remove track ${displayIndex}`;
    }

    const settings = trackEl.querySelector("button[data-action='settings']");
    if (settings && track) {
      syncCardFlipState(trackEl, track);
    } else if (settings) {
      settings.setAttribute("aria-label", `Open track ${displayIndex} settings`);
    }
  });
};

const updateAddTrackButton = () => {
  els.addTrack.disabled = state.tracks.length >= MAX_TRACKS;
  els.addTrack.textContent = "Add track";
  els.addTrack.ariaLabel =
    state.tracks.length >= MAX_TRACKS ? "Track limit reached" : "Add track";
};

const renderTracks = () => {
  syncParsedTracks();
  els.tracks.replaceChildren(...state.tracks.map(renderTrack));
  updateAddTrackButton();
  els.tempo.value = String(state.bpm);
  els.tempoReadout.textContent = `${state.bpm} BPM`;
};

const paintActiveSteps = () => {
  els.tracks.querySelectorAll(".adventurer-card").forEach((trackEl) => {
    const track = state.tracks.find(
      (candidate) => candidate.id === trackEl.dataset.adventurerId,
    );
    if (!track) {
      return;
    }
    trackEl.querySelectorAll(".rune-stone").forEach((stepEl, stepIndex) => {
      stepEl.classList.toggle("is-glowing", stepIndex === track.activeStep);
    });
  });
};

const handleTrackSettingInput = (trackEl, track, action, value) => {
  if (action === "volume") {
    track.volume = normalizeVolume(value);
  } else if (action === "pan") {
    track.pan = normalizePan(value);
  } else {
    return false;
  }

  syncTrackChannel(track);
  updateSettingsReadouts(trackEl, track);
  persist();
  return true;
};

const handleTrackInput = (event) => {
  const trackEl = event.target.closest(".adventurer-card");
  if (!trackEl) {
    return;
  }

  const track = state.tracks.find(
    (candidate) => candidate.id === trackEl.dataset.adventurerId,
  );
  if (!track) {
    return;
  }

  const action = event.target.dataset.action;

  if (handleTrackSettingInput(trackEl, track, action, event.target.value)) {
    return;
  }

  if (action === "voice") {
    track.sound = event.target.value;
    persist();
    return;
  }

  if (action === "incantation") {
    track.sequence = event.target.value;
    track.activeStep = -1;
    const parsed = parseSequence(track.sequence);
    track.notes = parsed.notes;
    track.error = parsed.error;
    updateTrackIndicators(trackEl, track);
    persist();
    return;
  }
};

const handleTrackDraftInput = (event) => {
  const action = event.target.dataset.action;
  if (!["incantation", "volume", "pan"].includes(action)) {
    return;
  }

  const trackEl = event.target.closest(".adventurer-card");
  if (!trackEl) {
    return;
  }

  const track = state.tracks.find(
    (candidate) => candidate.id === trackEl.dataset.adventurerId,
  );
  if (!track) {
    return;
  }

  if (handleTrackSettingInput(trackEl, track, action, event.target.value)) {
    return;
  }

  track.sequence = event.target.value;
  track.activeStep = -1;
  const parsed = parseSequence(track.sequence);
  track.notes = parsed.notes;
  track.error = parsed.error;
  updateTrackIndicators(trackEl, track);
  persist();
};

const handleTrackClick = (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const trackEl = button.closest(".adventurer-card");
  if (!trackEl) {
    return;
  }

  const track = state.tracks.find(
    (candidate) => candidate.id === trackEl.dataset.adventurerId,
  );
  if (!track) {
    return;
  }

  if (button.dataset.action === "settings") {
    track.settingsOpen = !track.settingsOpen;
    syncCardFlipState(trackEl, track);
    return;
  }

  if (button.dataset.action === "silence") {
    track.muted = !track.muted;
    trackEl.classList.toggle("is-silenced", track.muted);
    button.textContent = track.muted ? "Unmute" : "Mute";
    persist();
  }

  if (button.dataset.action === "banish") {
    removeTrack(track.id);
  }
};

const bindEvents = () => {
  els.addTrack.addEventListener("click", () => addTrack());
  els.record.addEventListener("click", toggleRecording);
  els.save.addEventListener("click", saveProject);
  els.upload.addEventListener("click", () => els.uploadInput.click());
  els.uploadInput.addEventListener("change", handleProjectUpload);
  els.playToggle.addEventListener("click", () => {
    if (state.playing) {
      pausePlayback();
    } else {
      startPlayback();
    }
  });
  els.tempo.addEventListener("input", (event) => {
    state.bpm = Number(event.target.value);
    els.tempoReadout.textContent = `${state.bpm} BPM`;
    persist();
  });
  els.tracks.addEventListener("change", handleTrackInput);
  els.tracks.addEventListener("input", handleTrackDraftInput);
  els.tracks.addEventListener("click", handleTrackClick);
};

const boot = () => {
  const restored = restore();
  if (!restored) {
    state.tracks = starterTracks.map((track) => makeTrack(track));
  }

  state.bpm = Math.max(48, Math.min(218, state.bpm));
  bindEvents();
  updateRecordButton();
  renderTracks();
};

boot();
