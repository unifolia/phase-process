const MAX_TRACKS = 18;
const DEFAULT_BPM = 90;
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
  { sound: "clarinets", sequence: "[C3, B3, G3, A3, A4]" },
  { sound: "bells", sequence: "[E5, B4, G4, B4, E5, G5]" },
];

const state = {
  audioContext: null,
  master: null,
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
  playToggle: document.querySelector("#open-portal"),
  stopButton: document.querySelector("#seal-portal"),
  tempo: document.querySelector("#haste-dial"),
  tempoReadout: document.querySelector("#haste-oracle"),
  pulseLight: document.querySelector("#heartbeat-rune"),
};

const eighthSeconds = () => {
  return 30 / state.bpm;
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
    sequence: seed.sequence || "[C3, E3, G3, A3]",
    notes: [],
    error: "",
    muted: false,
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
    .split(",")
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
      /^([A-Ga-g])(#{1,2}|[bB]{1,2}|[xX])?(-?\d{1,2})$/,
    );
    if (!match) {
      notes.push(rest());
      return;
    }

    const letter = match[1].toUpperCase();
    const accidental = match[2] || "";
    const octave = Number(match[3]);

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

  master.gain.value = 0.72;
  compressor.threshold.value = -24;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.012;
  compressor.release.value = 0.2;

  master.connect(compressor);
  compressor.connect(audioContext.destination);

  state.audioContext = audioContext;
  state.master = master;
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

const playBells = (note, when, duration) => {
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
  out.connect(state.master);

  tone.start(when);
  chime.start(when);
  tone.stop(when + duration + 0.26);
  chime.stop(when + duration + 0.26);
};

const playFrogs = (note, when, duration) => {
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
  out.connect(state.master);

  carrier.start(when);
  upper.start(when);
  carrier.stop(when + duration + 0.2);
  upper.stop(when + duration + 0.2);
};

const playPipes = (note, when, duration) => {
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
  out.connect(state.master);

  oscA.start(when);
  oscB.start(when);
  oscA.stop(when + duration + 0.34);
  oscB.stop(when + duration + 0.34);
};

const playClarinets = (note, when, duration) => {
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
  out.connect(state.master);

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
  players[track.sound](note, when, eighthSeconds() * 0.86);
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
  els.pulseLight.classList.remove("is-lit");
};

const stopPlayback = () => {
  pausePlayback();
  state.tick = 0;
  state.tracks.forEach((track) => {
    track.activeStep = -1;
  });
  renderTracks();
};

const flashPulse = (tick) => {
  if (tick % 2 !== 0) {
    return;
  }
  els.pulseLight.classList.add("is-lit");
  window.setTimeout(() => els.pulseLight.classList.remove("is-lit"), 82);
};

const persist = () => {
  const payload = {
    bpm: state.bpm,
    tracks: state.tracks.map(({ sound, sequence, muted }) => ({
      sound,
      sequence,
      muted,
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
      .map((track) => makeTrack(track));
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

  state.tracks.splice(index, 1);

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
    trackEl.append(error);
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
  article.className = `adventurer-card${track.muted ? " is-silenced" : ""}`;
  article.dataset.adventurerId = track.id;
  article.dataset.initiative = String(index + 1);
  article.style.animationDelay = `${index * 55}ms`;

  const trackNumber = document.createElement("div");
  trackNumber.className = "initiative-count";
  trackNumber.innerHTML = `<strong>${index + 1}</strong><span>${noteCountLabel(track.notes.length || 0)}</span>`;

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
  textarea.placeholder = "[C3, D3, E3, G3]";
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

  const steps = document.createElement("div");
  steps.className = "rune-chain";
  track.notes.forEach((note, stepIndex) => {
    steps.append(createStepElement(note, stepIndex, track.activeStep));
  });

  article.append(trackNumber, soundBlock, sequenceBlock, tools, steps);

  if (track.error) {
    const error = document.createElement("p");
    error.className = "curse-warning";
    error.textContent = track.error;
    article.append(error);
  }

  return article;
};

const updateTrackOrder = () => {
  els.tracks.querySelectorAll(".adventurer-card").forEach((trackEl, index) => {
    const displayIndex = index + 1;
    trackEl.dataset.initiative = String(displayIndex);

    const number = trackEl.querySelector(".initiative-count strong");
    if (number) {
      number.textContent = String(displayIndex);
    }

    const remove = trackEl.querySelector("button[data-action='banish']");
    if (remove) {
      remove.ariaLabel = `Remove track ${displayIndex}`;
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
  if (event.target.dataset.action !== "incantation") {
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
  els.playToggle.addEventListener("click", () => {
    if (state.playing) {
      pausePlayback();
    } else {
      startPlayback();
    }
  });
  els.stopButton.addEventListener("click", stopPlayback);
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

  state.bpm = Math.max(48, Math.min(176, state.bpm));
  bindEvents();
  renderTracks();
};

boot();
