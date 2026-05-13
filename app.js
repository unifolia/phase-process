const MAX_TRACKS = 18,
  DEFAULT_BPM = 90,
  SETTINGS_VERSION = 2,
  UNITY_VOLUME = 0.7,
  DEFAULT_VOLUME = 0.7,
  DEFAULT_PAN = 0,
  SCHEDULE_AHEAD_SECONDS = 0.36,
  SCHEDULE_LATE_GRACE_SECONDS = 0.035,
  SCHEDULE_START_OFFSET_SECONDS = 0.08,
  LOOKAHEAD_MS = 50,
  IDLE_SUSPEND_MS = 1500,
  PERSIST_DEBOUNCE_MS = 250,
  WAV_RECORDER_WORKLET_URL = "./wav-recorder-worklet.js",
  RECORDING_CHANNELS = 2,
  WAV_BITS_PER_SAMPLE = 16,
  soundBank = [
    { id: "bells", label: "Bells" },
    { id: "frogs", label: "Frogs" },
    { id: "pipes", label: "Pipes" },
    { id: "clarinets", label: "Clarinets" },
  ],
  noteOffsets = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 },
  starterTracks = [
    { sound: "clarinets", sequence: "C3, B3, G3, A3, A4" },
    { sound: "bells", sequence: "E5, B4, G4, B4, E5, G5" },
  ],
  state = {
    audioContext: null,
    master: null,
    compressor: null,
    recorderNode: null,
    recorderSilence: null,
    wavRecorderModulePromise: null,
    recorderConnected: !1,
    audioResumePromise: null,
    audioSuspendPromise: null,
    idleSuspendTimer: null,
    recordingChunks: [],
    recordingFrameCount: 0,
    recordingSampleRate: 0,
    recording: !1,
    recordingStarting: !1,
    recordingStopping: !1,
    playbackStarting: !1,
    timer: null,
    playing: !1,
    bpm: 90,
    nextStepTime: 0,
    tick: 0,
    visualRunId: 0,
    scheduledVoices: new Set(),
    persistTimer: null,
    trackElements: new Map(),
    tracks: [],
  },
  els = {
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
  },
  eighthSeconds = () => 30 / state.bpm,
  clamp = (e, t, a, n) => {
    const r = Number(e);
    return Number.isFinite(r) ? Math.min(a, Math.max(t, r)) : n;
  },
  normalizeVolume = (e) => clamp(e, 0, 1, 0.7),
  volumeToGain = (e) => normalizeVolume(e) / 0.7,
  normalizePan = (e) => clamp(e, -1, 1, 0),
  migrateSavedVolume = (e, t) =>
    2 === t
      ? normalizeVolume(e.volume)
      : void 0 === e.volume
        ? 0.7
        : normalizeVolume(0.7 * normalizeVolume(e.volume)),
  normalizeSoundId = (e) =>
    soundBank.some(({ id: t }) => t === e) ? e : soundBank[0].id,
  makeId = () =>
    window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : String(Date.now() + Math.random()),
  makeTrack = (e = {}) => ({
    id: makeId(),
    sound: normalizeSoundId(e.sound),
    sequence: e.sequence || "C3, E3, G3, A3",
    notes: [],
    error: "",
    muted: Boolean(e.muted),
    volume: normalizeVolume(e.volume),
    pan: normalizePan(e.pan),
    settingsOpen: !1,
    channel: null,
    activeStep: -1,
    activeStepId: "",
    nextStepIndex: 0,
  }),
  accidentalOffset = (e) =>
    e
      ? "x" === e.toLowerCase()
        ? 2
        : e.startsWith("#")
          ? e.length
          : -e.length
      : 0,
  normalizeAccidental = (e) =>
    e
      ? "x" === e.toLowerCase()
        ? "x"
        : e.startsWith("#")
          ? e
          : "b".repeat(e.length)
      : "",
  parseSequence = (e) => {
    const t = e.trim(),
      a = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
    if (!a.trim()) return { notes: [], error: "" };
    const n = a
        .split(/[,\s]+/)
        .map((e) => e.trim())
        .filter(Boolean),
      r = [];
    return (
      n.forEach((e) => {
        const t = e.toUpperCase();
        if ("R" === t || "REST" === t || "-" === e || "_" === e)
          return void r.push({ stepId: makeId(), label: "R", rest: !0 });
        const a = e.match(/^([A-Ga-g])(#{1,2}|[bB]{1,2}|[xX])?(-?\d{1,2})?$/);
        if (!a) return void r.push({ stepId: makeId(), label: "R", rest: !0 });
        const n = a[1].toUpperCase(),
          s = a[2] || "",
          o = void 0 === a[3] ? 3 : Number(a[3]);
        if (!(n in noteOffsets) || o < 0 || o > 8)
          return void r.push({ stepId: makeId(), label: "R", rest: !0 });
        const c =
            440 *
            2 **
              ((12 * (o + 1) + noteOffsets[n] + accidentalOffset(s) - 69) / 12),
          i = `${n}${normalizeAccidental(s)}${o}`;
        r.push({ stepId: makeId(), label: i, frequency: c, rest: !1 });
      }),
      { notes: r, error: "" }
    );
  },
  syncParsedTracks = () => {
    state.tracks.forEach((e) => {
      const t = parseSequence(e.sequence),
        a = e.notes;
      (reconcileStepIds(a, t.notes),
        (e.notes = t.notes),
        (e.error = t.error),
        syncActiveStep(e));
    });
  },
  normalizeStepIndex = (e, t) => {
    const a = Number.isFinite(e) ? Math.trunc(e) : 0;
    return t > 0 ? ((a % t) + t) % t : 0;
  },
  normalizeCursorBoundary = (e, t) => {
    const a = Number.isFinite(e) ? Math.trunc(e) : 0,
      n = normalizeStepIndex(a, t);
    return t > 0 && a > 0 && 0 === n ? t : n;
  },
  sameParsedNote = (e, t) =>
    Boolean(e) &&
    Boolean(t) &&
    e.label === t.label &&
    Boolean(e.rest) === Boolean(t.rest),
  noteEditBounds = (e, t) => {
    let a = 0;
    for (; a < e.length && a < t.length && sameParsedNote(e[a], t[a]); )
      a += 1;
    let n = e.length,
      r = t.length;
    for (; n > a && r > a && sameParsedNote(e[n - 1], t[r - 1]); )
      ((n -= 1), (r -= 1));
    return { prefix: a, oldEnd: n, newEnd: r };
  },
  reconcileStepIds = (e, t) => {
    const { prefix: a, oldEnd: n, newEnd: r } = noteEditBounds(e, t);
    for (let n = 0; n < a; n += 1) t[n].stepId = e[n].stepId || t[n].stepId;
    for (let a = n, s = r; a < e.length && s < t.length; a += 1, s += 1)
      t[s].stepId = e[a].stepId || t[s].stepId;
  },
  syncActiveStep = (e) => {
    const t = e.activeStepId
      ? e.notes.findIndex((t) => t.stepId === e.activeStepId)
      : -1;
    ((e.activeStep = t), t < 0 && (e.activeStepId = ""));
  },
  reconcileTrackCursor = (e, t, a) => {
    if (!a.length) return void (e.nextStepIndex = 0);
    if (!t.length)
      return void (e.nextStepIndex = normalizeCursorBoundary(e.nextStepIndex, a.length));
    const n = normalizeCursorBoundary(e.nextStepIndex, t.length);
    const { prefix: r, oldEnd: s, newEnd: o } = noteEditBounds(t, a);
    const c = o - r - (s - r);
    let i = n;
    (s < n || (s === n && c < 0)
      ? (i = n + c)
      : r <= n && n <= s && (i = r),
      (e.nextStepIndex = normalizeCursorBoundary(i, a.length)));
  },
  advanceCursor = (e, t, a = 1) =>
    a > 0 ? normalizeStepIndex(normalizeStepIndex(e, t) + a - 1, t) + 1 : e,
  resetTrackCursors = () => {
    state.tracks.forEach((e) => {
      e.nextStepIndex = 0;
    });
  },
  advanceTrackCursors = (e) => {
    const t = Math.max(0, Math.trunc(e));
    t &&
      state.tracks.forEach((e) => {
        e.notes.length &&
          (e.nextStepIndex = advanceCursor(e.nextStepIndex, e.notes.length, t));
      });
  },
  takeNextTrackStep = (e) => {
    if (!e.notes.length) return -1;
    const t = normalizeStepIndex(e.nextStepIndex, e.notes.length);
    return ((e.nextStepIndex = advanceCursor(e.nextStepIndex, e.notes.length)), t);
  },
  initAudio = () => {
    if (state.audioContext) return;
    const e = window.AudioContext || window.webkitAudioContext;
    if (!e) throw new Error("Web Audio is not supported in this browser.");
    const t = new e(),
      a = t.createGain(),
      n = t.createDynamicsCompressor();
    ((a.gain.value = 0.8),
      (n.threshold.value = -24),
      (n.knee.value = 18),
      (n.ratio.value = 3),
      (n.attack.value = 0.012),
      (n.release.value = 0.2),
      a.connect(n),
      n.connect(t.destination),
      (state.audioContext = t),
      (state.master = a),
      (state.compressor = n));
  },
  cancelIdleSuspend = () => {
    state.idleSuspendTimer &&
      (window.clearTimeout(state.idleSuspendTimer),
      (state.idleSuspendTimer = null));
  },
  resumeAudioContext = async () => {
    (cancelIdleSuspend(), initAudio());
    const e = state.audioContext;
    if (state.audioSuspendPromise)
      try {
        await state.audioSuspendPromise;
      } catch {}
    return (
      "running" === e.state ||
        (state.audioResumePromise ||
          (state.audioResumePromise = e.resume().finally(() => {
            state.audioResumePromise = null;
          })),
        await state.audioResumePromise),
      e
    );
  },
  suspendAudioContext = async () => {
    if (state.audioContext && !state.playing && !state.recording) {
      if (state.audioResumePromise)
        try {
          await state.audioResumePromise;
        } catch {
          return;
        }
      if ("running" === state.audioContext.state) {
        if (!state.audioSuspendPromise) {
          const e = state.audioContext;
          state.audioSuspendPromise = e.suspend().finally(() => {
            state.audioSuspendPromise = null;
          });
        }
        await state.audioSuspendPromise;
      }
    }
  },
  scheduleIdleSuspend = () => {
    (cancelIdleSuspend(),
      !state.audioContext ||
        state.playing ||
        state.recording ||
        (state.idleSuspendTimer = window.setTimeout(() => {
          ((state.idleSuspendTimer = null),
            suspendAudioContext().catch(() => {}));
        }, 1500)));
  },
  shapeGain = (e, t, a) => {
    (e.cancelScheduledValues(t),
      a.forEach(([a, n, r]) => {
        "exp" === r
          ? e.exponentialRampToValueAtTime(Math.max(n, 1e-4), t + a)
          : 0 === a
            ? e.setValueAtTime(n, t)
            : e.linearRampToValueAtTime(n, t + a);
      }));
  },
  makeFilter = (e, t, a, n = 0.5) => {
    const r = e.createBiquadFilter();
    return ((r.type = t), (r.frequency.value = a), (r.Q.value = n), r);
  },
  syncTrackChannel = (e) => {
    if (!state.audioContext || !e.channel) return;
    const t = state.audioContext.currentTime;
    (e.channel.gain.gain.setTargetAtTime(volumeToGain(e.volume), t, 0.01),
      e.channel.panner &&
        e.channel.panner.pan.setTargetAtTime(normalizePan(e.pan), t, 0.01));
  },
  ensureTrackChannel = (e) => {
    if (e.channel) return (syncTrackChannel(e), e.channel);
    const t = state.audioContext.createGain(),
      a =
        state.audioContext.createStereoPanner &&
        state.audioContext.createStereoPanner();
    return (
      a ? (t.connect(a), a.connect(state.master)) : t.connect(state.master),
      (e.channel = { input: t, gain: t, panner: a }),
      syncTrackChannel(e),
      e.channel
    );
  },
  destroyTrackChannel = (e) => {
    (stopScheduledVoices(e.id),
      e.channel &&
        (e.channel.input.disconnect(),
        e.channel.panner && e.channel.panner.disconnect(),
        (e.channel = null)));
  },
  disconnectAudioNode = (e) => {
    try {
      e.disconnect();
    } catch {}
  },
  registerVoice = (e, t, a) => {
    const n = { trackId: e, sources: t, nodes: a, cleanup: null };
    let r = t.length,
      s = !1;
    return (
      (n.cleanup = () => {
        s ||
          ((s = !0),
          a.forEach(disconnectAudioNode),
          state.scheduledVoices.delete(n));
      }),
      t.forEach((e) => {
        e.addEventListener(
          "ended",
          () => {
            ((r -= 1), r <= 0 && n.cleanup && n.cleanup());
          },
          { once: !0 },
        );
      }),
      state.scheduledVoices.add(n),
      n
    );
  },
  stopScheduledVoices = (e) => {
    [...state.scheduledVoices].forEach((t) => {
      (e && t.trackId !== e) ||
        (t.sources.forEach((e) => {
          try {
            e.stop(0);
          } catch {}
        }),
        t.cleanup && t.cleanup());
    });
  },
  playBells = (e, t, a, n, r) => {
    const s = state.audioContext,
      o = s.createGain(),
      c = s.createOscillator(),
      i = s.createOscillator(),
      l = makeFilter(s, "lowpass", 2600, 0.4);
    ((c.type = "sine"),
      (i.type = "triangle"),
      c.frequency.setValueAtTime(e.frequency, t),
      i.frequency.setValueAtTime(2.01 * e.frequency, t),
      shapeGain(o.gain, t, [
        [0, 1e-4],
        [0.012, 0.32],
        [0.62 * a, 0.11, "exp"],
        [a + 0.22, 1e-4, "exp"],
      ]),
      c.connect(l),
      i.connect(l),
      l.connect(o),
      o.connect(n),
      c.start(t),
      i.start(t),
      c.stop(t + a + 0.26),
      i.stop(t + a + 0.26),
      registerVoice(r, [c, i], [c, i, l, o]));
  },
  playFrogs = (e, t, a, n, r) => {
    const s = state.audioContext,
      o = s.createGain(),
      c = s.createOscillator(),
      i = s.createOscillator(),
      l = makeFilter(s, "bandpass", Math.min(3 * e.frequency, 2800), 0.85);
    ((c.type = "sine"),
      (i.type = "sine"),
      c.frequency.setValueAtTime(e.frequency, t),
      i.frequency.setValueAtTime(1.5 * e.frequency, t),
      shapeGain(o.gain, t, [
        [0, 1e-4],
        [0.018, 0.24],
        [0.48 * a, 0.13, "exp"],
        [a + 0.16, 1e-4, "exp"],
      ]),
      c.connect(l),
      i.connect(l),
      l.connect(o),
      o.connect(n),
      c.start(t),
      i.start(t),
      c.stop(t + a + 0.2),
      i.stop(t + a + 0.2),
      registerVoice(r, [c, i], [c, i, l, o]));
  },
  playPipes = (e, t, a, n, r) => {
    const s = state.audioContext,
      o = s.createGain(),
      c = s.createOscillator(),
      i = s.createOscillator(),
      l = makeFilter(s, "lowpass", 1150, 0.7);
    ((c.type = "triangle"),
      (i.type = "sine"),
      c.frequency.setValueAtTime(e.frequency, t),
      i.frequency.setValueAtTime(0.997 * e.frequency, t),
      c.detune.setValueAtTime(-6, t),
      i.detune.setValueAtTime(5, t),
      shapeGain(o.gain, t, [
        [0, 1e-4],
        [0.055, 0.19],
        [Math.max(0.74 * a, 0.08), 0.15],
        [a + 0.3, 1e-4, "exp"],
      ]),
      c.connect(l),
      i.connect(l),
      l.connect(o),
      o.connect(n),
      c.start(t),
      i.start(t),
      c.stop(t + a + 0.34),
      i.stop(t + a + 0.34),
      registerVoice(r, [c, i], [c, i, l, o]));
  },
  playClarinets = (e, t, a, n, r) => {
    const s = state.audioContext,
      o = s.createGain(),
      c = s.createOscillator(),
      i = s.createOscillator(),
      l = makeFilter(s, "lowpass", 780, 0.45);
    ((c.type = "sine"),
      (i.type = "triangle"),
      c.frequency.setValueAtTime(0.5 * e.frequency, t),
      i.frequency.setValueAtTime(e.frequency, t),
      i.detune.setValueAtTime(8, t),
      l.frequency.setValueAtTime(520, t),
      l.frequency.linearRampToValueAtTime(920, t + 0.65 * a),
      shapeGain(o.gain, t, [
        [0, 1e-4],
        [0.04, 0.2],
        [0.8 * a, 0.17],
        [a + 0.42, 1e-4, "exp"],
      ]),
      c.connect(l),
      i.connect(l),
      l.connect(o),
      o.connect(n),
      c.start(t),
      i.start(t),
      c.stop(t + a + 0.46),
      i.stop(t + a + 0.46),
      registerVoice(r, [c, i], [c, i, l, o]));
  },
  players = {
    bells: playBells,
    frogs: playFrogs,
    pipes: playPipes,
    clarinets: playClarinets,
  },
  playNote = (e, t, a) => {
    if (e.muted || t.rest || !players[e.sound]) return;
    const n = ensureTrackChannel(e);
    players[e.sound](t, a, 0.86 * eighthSeconds(), n.input, e.id);
  },
  scheduleStep = (e) => {
    const a = state.visualRunId,
      n = new Map();
    state.tracks.forEach((a) => {
      const r = takeNextTrackStep(a);
      -1 !== r && (n.set(a.id, a.notes[r].stepId), playNote(a, a.notes[r], e));
    });
    const r = Math.max(0, 1e3 * (e - state.audioContext.currentTime));
    window.setTimeout(() => {
      state.visualRunId === a && state.playing && paintActiveSteps(n);
    }, r);
  },
  recoverSchedulerClock = () => {
    const e = state.audioContext.currentTime;
    if (state.nextStepTime >= e - 0.035) return e;
    const t = eighthSeconds(),
      a = Math.floor((e - state.nextStepTime) / t) + 1;
    return (
      (state.tick += a),
      advanceTrackCursors(a),
      (state.nextStepTime += a * t),
      state.nextStepTime < e + 0.08 && (state.nextStepTime = e + 0.08),
      e
    );
  },
  scheduler = () => {
    if (
      !state.playing ||
      !state.audioContext ||
      "running" !== state.audioContext.state
    )
      return;
    const e = recoverSchedulerClock();
    for (; state.nextStepTime < e + 0.36; )
      (scheduleStep(state.nextStepTime),
        (state.nextStepTime += eighthSeconds()),
        (state.tick += 1));
  },
  startPlayback = async () => {
    if (
      !state.playing &&
      !state.playbackStarting &&
      (syncParsedTracks(), state.tracks.some((e) => e.notes.length))
    ) {
      state.playbackStarting = !0;
      try {
        await resumeAudioContext();
      } catch {
        return void window.alert(
          "Audio could not be started. Please try again!",
        );
      } finally {
        state.playbackStarting = !1;
      }
      state.playing ||
        ((state.playing = !0),
        (state.visualRunId += 1),
        (state.tick = 0),
        resetTrackCursors(),
        (state.nextStepTime = state.audioContext.currentTime + 0.08),
        (els.playToggle.textContent = "Pause"),
        (state.timer = window.setInterval(scheduler, 50)),
        scheduler());
    }
  },
  pausePlayback = () => {
    state.playing &&
      ((state.playing = !1),
      (state.visualRunId += 1),
      window.clearInterval(state.timer),
      (state.timer = null),
      stopScheduledVoices(),
      clearActiveSteps(),
      (els.playToggle.textContent = "Play"),
      els.pulseLight.classList.toggle("is-lit", state.recording),
      scheduleIdleSuspend());
  },
  timestampForFilename = () => new Date().toISOString().replace(/[:.]/g, "-"),
  downloadBlob = (e, t) => {
    const a = URL.createObjectURL(e),
      n = document.createElement("a");
    ((n.href = a),
      (n.download = t),
      (n.rel = "noopener"),
      document.body.append(n),
      n.click(),
      n.remove(),
      window.setTimeout(() => URL.revokeObjectURL(a), 1e3));
  },
  writeAscii = (e, t, a) => {
    for (let n = 0; n < a.length; n += 1) e.setUint8(t + n, a.charCodeAt(n));
  },
  sampleToInt16 = (e) => {
    const t = Math.min(1, Math.max(-1, e || 0));
    return Math.round(t < 0 ? 32768 * t : 32767 * t);
  },
  encodeWav = (e, t, a) => {
    const n = 4 * t,
      r = new ArrayBuffer(44 + n),
      s = new DataView(r);
    (writeAscii(s, 0, "RIFF"),
      s.setUint32(4, 36 + n, !0),
      writeAscii(s, 8, "WAVE"),
      writeAscii(s, 12, "fmt "),
      s.setUint32(16, 16, !0),
      s.setUint16(20, 1, !0),
      s.setUint16(22, 2, !0),
      s.setUint32(24, a, !0),
      s.setUint32(28, 4 * a, !0),
      s.setUint16(32, 4, !0),
      s.setUint16(34, 16, !0),
      writeAscii(s, 36, "data"),
      s.setUint32(40, n, !0));
    let o = 44,
      c = 0;
    return (
      e.forEach((e) => {
        const a = e[0],
          n = e[1] || e[0],
          r = Math.min(a.length, t - c);
        for (let e = 0; e < r; e += 1)
          (s.setInt16(o, sampleToInt16(a[e]), !0),
            (o += 2),
            s.setInt16(o, sampleToInt16(n[e]), !0),
            (o += 2));
        c += r;
      }),
      new Blob([r], { type: "audio/wav" })
    );
  },
  connectWavRecorder = () => {
    state.recorderConnected ||
      (state.compressor.connect(state.recorderNode),
      (state.recorderConnected = !0));
  },
  disconnectWavRecorder = () => {
    if (state.recorderConnected) {
      try {
        state.compressor.disconnect(state.recorderNode);
      } catch {}
      state.recorderConnected = !1;
    }
  },
  finishWavRecording = () => {
    disconnectWavRecorder();
    const e = state.recordingChunks,
      t = state.recordingFrameCount,
      a = state.recordingSampleRate || state.audioContext.sampleRate;
    ((state.recordingChunks = []),
      (state.recordingFrameCount = 0),
      (state.recordingSampleRate = 0),
      (state.recording = !1),
      (state.recordingStarting = !1),
      (state.recordingStopping = !1),
      updateRecordButton(),
      scheduleIdleSuspend(),
      t > 0 &&
        downloadBlob(
          encodeWav(e, t, a),
          `phase-process-recording-${timestampForFilename()}.wav`,
        ));
  },
  handleWavRecorderError = () => {
    (disconnectWavRecorder(),
      (state.recordingChunks = []),
      (state.recordingFrameCount = 0),
      (state.recordingSampleRate = 0),
      (state.recording = !1),
      (state.recordingStarting = !1),
      (state.recordingStopping = !1),
      updateRecordButton(),
      scheduleIdleSuspend(),
      window.alert(
        "Something went wrong with the recording machine. Try again.",
      ));
  },
  handleWavRecorderMessage = (e) => {
    const t = e.data || {};
    if ("chunk" === t.type && (state.recording || state.recordingStopping))
      return (
        state.recordingChunks.push(t.channels),
        void (state.recordingFrameCount +=
          t.frames || (t.channels[0] && t.channels[0].length) || 0)
      );
    "stopped" === t.type && finishWavRecording();
  },
  ensureWavRecorder = async () => {
    if (
      !state.audioContext.audioWorklet ||
      "function" != typeof AudioWorkletNode
    )
      throw new Error("AudioWorklet is not supported in this browser.");
    if (
      (state.wavRecorderModulePromise ||
        (state.wavRecorderModulePromise =
          state.audioContext.audioWorklet.addModule(WAV_RECORDER_WORKLET_URL)),
      await state.wavRecorderModulePromise,
      state.recorderNode)
    )
      return state.recorderNode;
    const e = new AudioWorkletNode(
        state.audioContext,
        "wav-recorder-processor",
        { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] },
      ),
      t = state.audioContext.createGain();
    return (
      (t.gain.value = 0),
      e.connect(t),
      t.connect(state.audioContext.destination),
      e.port.addEventListener("message", handleWavRecorderMessage),
      e.addEventListener("processorerror", handleWavRecorderError),
      e.port.start && e.port.start(),
      (state.recorderNode = e),
      (state.recorderSilence = t),
      e
    );
  },
  updateRecordButton = () => {
    ((els.recordLabel.textContent = state.recording ? "Stop Rec" : "Record"),
      (els.record.disabled =
        state.recordingStarting || state.recordingStopping),
      els.record.setAttribute("aria-pressed", String(state.recording)),
      (els.record.ariaLabel = state.recording
        ? "Stop recording"
        : "Record audio"),
      els.pulseLight.classList.toggle("is-lit", state.recording));
  },
  startRecording = async () => {
    if (state.recording || state.recordingStarting || state.recordingStopping)
      return;
    let e;
    ((state.recordingStarting = !0), updateRecordButton());
    try {
      (await resumeAudioContext(), (e = await ensureWavRecorder()));
    } catch {
      return (
        (state.recordingStarting = !1),
        updateRecordButton(),
        void window.alert(
          "AudioWorklet only supported over HTTPS or localhost. I don't make the rules! Sorry!",
        )
      );
    }
    ((state.recordingChunks = []),
      (state.recordingFrameCount = 0),
      (state.recordingSampleRate = state.audioContext.sampleRate),
      (state.recording = !0),
      (state.recordingStarting = !1),
      connectWavRecorder(),
      e.port.postMessage({ type: "start" }),
      updateRecordButton());
  },
  stopRecording = () => {
    state.recording &&
      !state.recordingStopping &&
      state.recorderNode &&
      ((state.recordingStopping = !0),
      updateRecordButton(),
      state.recorderNode.port.postMessage({ type: "stop" }));
  },
  toggleRecording = () => {
    state.recordingStarting ||
      state.recordingStopping ||
      (state.recording ? stopRecording() : startRecording());
  },
  serializeNote = (e) => ({
    label: e.rest ? "R" : e.label,
    rest: Boolean(e.rest),
  }),
  serializeTrack = (e) => {
    const t = parseSequence(e.sequence);
    return {
      sound: e.sound,
      sequence: e.sequence,
      notes: t.notes.map(serializeNote),
      muted: e.muted,
      volume: normalizeVolume(e.volume),
      pan: normalizePan(e.pan),
    };
  },
  buildProjectPayload = () => (
    syncParsedTracks(),
    {
      app: "phase-process",
      settingsVersion: 2,
      exportedAt: new Date().toISOString(),
      bpm: state.bpm,
      tracks: state.tracks.map(serializeTrack),
    }
  ),
  saveProject = () => {
    const e = new Blob([JSON.stringify(buildProjectPayload(), null, 2)], {
      type: "application/json",
    });
    downloadBlob(e, `phase-process-${timestampForFilename()}.json`);
  },
  sequenceFromNotes = (e) => {
    if (Array.isArray(e) && e.length)
      return e
        .map((e) =>
          "string" == typeof e
            ? e.trim() || "R"
            : !e || e.rest
              ? "R"
              : "string" == typeof e.label && e.label.trim()
                ? e.label.trim()
                : "R",
        )
        .join(", ");
  },
  normalizeImportedTrack = (e, t) => {
    const a = e || {};
    return makeTrack({
      ...a,
      sequence:
        "string" == typeof a.sequence && a.sequence.trim()
          ? a.sequence
          : sequenceFromNotes(a.notes),
      volume: migrateSavedVolume(a, t),
    });
  },
  applyProjectPayload = (e) => {
    const t = Array.isArray(e) ? e : e && e.tracks;
    if (!Array.isArray(t) || 0 === t.length)
      throw new Error("Project JSON must include at least one track.");
    const a = Array.isArray(e) ? 2 : e.settingsVersion,
      n = t.slice(0, 18).map((e) => normalizeImportedTrack(e, a));
    (pausePlayback(),
      state.tracks.forEach(destroyTrackChannel),
      (state.bpm = Array.isArray(e) ? 90 : clamp(e.bpm, 48, 218, 90)),
      (state.tracks = n),
      syncParsedTracks(),
      renderTracks(),
      persist());
  },
  handleProjectUpload = async (e) => {
    const [t] = e.target.files || [];
    if (t)
      try {
        applyProjectPayload(JSON.parse(await t.text()));
      } catch (e) {
        window.alert(
          e instanceof Error ? e.message : "Project could not be uploaded.",
        );
      } finally {
        e.target.value = "";
      }
  },
  persistNow = () => {
    state.persistTimer &&
      (window.clearTimeout(state.persistTimer), (state.persistTimer = null));
    const e = {
      settingsVersion: 2,
      bpm: state.bpm,
      tracks: state.tracks.map(
        ({ sound: e, sequence: t, muted: a, volume: n, pan: r }) => ({
          sound: e,
          sequence: t,
          muted: a,
          volume: n,
          pan: r,
        }),
      ),
    };
    try {
      localStorage.setItem("tide-index-state", JSON.stringify(e));
    } catch {}
  },
  persist = () => {
    (state.persistTimer && window.clearTimeout(state.persistTimer),
      (state.persistTimer = window.setTimeout(() => {
        ((state.persistTimer = null), persistNow());
      }, 250)));
  },
  restore = () => {
    try {
      const e = localStorage.getItem("tide-index-state");
      if (!e) return !1;
      const t = JSON.parse(e);
      return (
        !!Array.isArray(t.tracks) &&
        ((state.bpm = Number(t.bpm) || 90),
        (state.tracks = t.tracks.slice(0, 18).map((e) =>
          makeTrack({
            ...e,
            volume: migrateSavedVolume(e, t.settingsVersion),
          }),
        )),
        state.tracks.length > 0)
      );
    } catch {
      return !1;
    }
  },
  addTrack = (e) => {
    if (state.tracks.length >= 18) return;
    const t = makeTrack(e),
      a = parseSequence(t.sequence);
    ((t.notes = a.notes), (t.error = a.error), state.tracks.push(t));
    const n = renderTrack(t, state.tracks.length - 1);
    (state.trackElements.set(t.id, n),
      els.tracks.append(n),
      updateAddTrackButton(),
      persist());
  },
  removeTrack = (e) => {
    const t = state.tracks.findIndex((t) => t.id === e);
    if (-1 === t) return;
    const [a] = state.tracks.splice(t, 1);
    destroyTrackChannel(a);
    const n = state.trackElements.get(e);
    (n && n.remove(),
      state.trackElements.delete(e),
      updateTrackOrder(),
      updateAddTrackButton(),
      persist());
  },
  noteCountLabel = (e) => `${e} ${1 === e ? "note" : "notes"}`,
  formatVolume = (e) => `${Math.round(100 * normalizeVolume(e))}%`,
  formatPan = (e) => {
    const t = normalizePan(e);
    return Math.abs(t) < 0.005 ? "0" : String(Math.round(100 * t));
  },
  updateSettingsReadouts = (e, t) => {
    const a = e.querySelector("[data-readout='volume']");
    a && (a.textContent = formatVolume(t.volume));
    const n = e.querySelector("[data-readout='pan']");
    n && (n.textContent = formatPan(t.pan));
  },
  syncCardFlipState = (e, t) => {
    const a = e.querySelector("button[data-action='settings']"),
      n = e.querySelector(".track-front"),
      r = e.querySelector(".track-back"),
      s = Number(e.dataset.initiative) || 1;
    (e.classList.toggle("is-flipped", t.settingsOpen),
      a &&
        (a.setAttribute("aria-pressed", String(t.settingsOpen)),
        a.setAttribute(
          "aria-label",
          t.settingsOpen
            ? `Close track ${s} settings`
            : `Open track ${s} settings`,
        )),
      n &&
        ((n.inert = t.settingsOpen),
        n.setAttribute("aria-hidden", String(t.settingsOpen))),
      r &&
        ((r.inert = !t.settingsOpen),
        r.setAttribute("aria-hidden", String(!t.settingsOpen))));
  },
  createSettingControl = ({
    track: e,
    action: t,
    label: a,
    min: n,
    max: r,
    step: s,
    value: o,
    format: c,
  }) => {
    const i = document.createElement("label");
    i.className = "track-setting-control";
    const l = `${t}-${e.id}`,
      d = document.createElement("span");
    d.className = "track-setting-header";
    const u = document.createElement("span");
    u.textContent = a;
    const p = document.createElement("output");
    ((p.dataset.readout = t), p.setAttribute("for", l), (p.textContent = c(o)));
    const m = document.createElement("input");
    return (
      (m.id = l),
      (m.type = "range"),
      (m.min = String(n)),
      (m.max = String(r)),
      (m.step = String(s)),
      (m.value = String(o)),
      (m.dataset.action = t),
      d.append(u, p),
      i.append(d, m),
      i
    );
  },
  createStepElement = (e, t) => {
    const n = document.createElement("span");
    return (
      (n.dataset.stepId = e.stepId),
      (n.className = [
        "rune-stone",
        e.stepId === t ? "is-glowing" : "",
        e.rest ? "is-resting" : "",
      ]
        .filter(Boolean)
        .join(" ")),
      (n.textContent = e.label),
      n
    );
  },
  updateTrackIndicators = (e, t) => {
    const a = e.querySelector(".initiative-count span"),
      n = e.querySelector(".track-front") || e;
    a && (a.textContent = noteCountLabel(t.notes.length || 0));
    const r = e.querySelector(".rune-chain");
    r &&
      r.replaceChildren(
        ...t.notes.map((e) => createStepElement(e, t.activeStepId)),
      );
    let s = e.querySelector(".curse-warning");
    (t.error &&
      !s &&
      ((s = document.createElement("p")),
      (s.className = "curse-warning"),
      n.append(s)),
      s && (t.error ? (s.textContent = t.error) : s.remove()));
  },
  renderTrack = (e, t) => {
    const a = document.createElement("article");
    ((a.className = [
      "adventurer-card",
      e.muted ? "is-silenced" : "",
      e.settingsOpen ? "is-flipped" : "",
    ]
      .filter(Boolean)
      .join(" ")),
      (a.dataset.adventurerId = e.id),
      (a.dataset.initiative = String(t + 1)),
      (a.style.animationDelay = 55 * t + "ms"));
    const n = document.createElement("div");
    ((n.className = "initiative-count"),
      (n.innerHTML = `<strong>${t + 1}</strong><span>${noteCountLabel(e.notes.length || 0)}</span>`));
    const r = document.createElement("button");
    ((r.className = "track-settings-button"),
      (r.type = "button"),
      (r.dataset.action = "settings"),
      (r.textContent = "Settings"),
      n.append(r));
    const s = document.createElement("div");
    s.className = "track-face track-front";
    const o = document.createElement("div");
    o.className = "track-face track-back";
    const c = document.createElement("div");
    c.className = "voice-grimoire";
    const i = document.createElement("label"),
      l = `voice-${e.id}`;
    (i.setAttribute("for", l), (i.textContent = "Sound"));
    const d = document.createElement("select");
    ((d.id = l),
      (d.dataset.action = "voice"),
      soundBank.forEach((t) => {
        const a = document.createElement("option");
        ((a.value = t.id),
          (a.textContent = t.label),
          (a.selected = t.id === e.sound),
          d.append(a));
      }),
      c.append(i, d));
    const u = document.createElement("div");
    u.className = "incantation-block";
    const p = document.createElement("label"),
      m = `incantation-${e.id}`;
    (p.setAttribute("for", m), (p.textContent = "Sequence"));
    const g = document.createElement("textarea");
    ((g.id = m),
      (g.dataset.action = "incantation"),
      (g.spellcheck = !1),
      (g.value = e.sequence),
      (g.placeholder = "C3, D3, E3, G3"),
      u.append(p, g));
    const h = document.createElement("div");
    h.className = "adventurer-tools";
    const S = document.createElement("button");
    ((S.className = "squire-action silence-button"),
      (S.type = "button"),
      (S.dataset.action = "silence"),
      (S.textContent = e.muted ? "Unmute" : "Mute"));
    const k = document.createElement("button");
    ((k.className = "banish-button"),
      (k.type = "button"),
      (k.dataset.action = "banish"),
      (k.textContent = "X"),
      (k.ariaLabel = `Remove track ${t + 1}`),
      h.append(S, k));
    const y = document.createElement("div");
    ((y.className = "track-settings-panel"),
      y.append(
        createSettingControl({
          track: e,
          action: "volume",
          label: "Volume",
          min: 0,
          max: 1,
          step: 0.01,
          value: e.volume,
          format: formatVolume,
        }),
        createSettingControl({
          track: e,
          action: "pan",
          label: "Pan",
          min: -1,
          max: 1,
          step: 0.01,
          value: e.pan,
          format: formatPan,
        }),
      ),
      o.append(y));
    const v = document.createElement("div");
    if (
      ((v.className = "rune-chain"),
      e.notes.forEach((t, a) => {
        v.append(createStepElement(t, e.activeStepId));
      }),
      s.append(c, u, h, v),
      a.append(n, s, o),
      e.error)
    ) {
      const t = document.createElement("p");
      ((t.className = "curse-warning"), (t.textContent = e.error), s.append(t));
    }
    return (syncCardFlipState(a, e), a);
  },
  updateTrackOrder = () => {
    state.tracks.forEach((e, t) => {
      const a = state.trackElements.get(e.id);
      if (!a) return;
      const n = t + 1;
      a.dataset.initiative = String(n);
      const r = a.querySelector(".initiative-count strong");
      r && (r.textContent = String(n));
      const s = a.querySelector("button[data-action='banish']");
      (s && (s.ariaLabel = `Remove track ${n}`),
        a.querySelector("button[data-action='settings']") &&
          syncCardFlipState(a, e));
    });
  },
  updateAddTrackButton = () => {
    ((els.addTrack.disabled = state.tracks.length >= 18),
      (els.addTrack.textContent = "Add track"),
      (els.addTrack.ariaLabel =
        state.tracks.length >= 18 ? "Track limit reached" : "Add track"));
  },
  renderTracks = () => {
    (syncParsedTracks(), state.trackElements.clear());
    const e = state.tracks.map((e, t) => {
      const a = renderTrack(e, t);
      return (state.trackElements.set(e.id, a), a);
    });
    (els.tracks.replaceChildren(...e),
      updateAddTrackButton(),
      (els.tempo.value = String(state.bpm)),
      (els.tempoReadout.textContent = `${state.bpm} BPM`));
  },
  findStepElement = (e, t) => {
    const a = t && e.querySelector(".rune-chain");
    if (!a) return null;
    for (const e of a.children) if (e.dataset.stepId === t) return e;
    return null;
  },
  paintActiveSteps = (e) => {
    e.forEach((e, t) => {
      const a = state.tracks.find((e) => e.id === t),
        n = state.trackElements.get(t);
      if (!a || !n) return;
      const r = a.activeStepId,
        s = findStepElement(n, r),
        o = findStepElement(n, e);
      (r !== e && s && s.classList.remove("is-glowing"),
        o
          ? ((a.activeStepId = e),
            (a.activeStep = a.notes.findIndex((t) => t.stepId === e)),
            o.classList.add("is-glowing"))
          : ((a.activeStepId = ""), (a.activeStep = -1)));
    });
  },
  clearActiveSteps = () => {
    state.tracks.forEach((e) => {
      const a = state.trackElements.get(e.id),
        n = a && findStepElement(a, e.activeStepId);
      ((e.activeStep = -1),
        (e.activeStepId = ""),
        n && n.classList.remove("is-glowing"));
    });
  },
  handleTrackSettingInput = (e, t, a, n) => {
    if ("volume" === a) t.volume = normalizeVolume(n);
    else {
      if ("pan" !== a) return !1;
      t.pan = normalizePan(n);
    }
    return (syncTrackChannel(t), updateSettingsReadouts(e, t), persist(), !0);
  },
  handleTrackInput = (e) => {
    if ("voice" !== e.target.dataset.action) return;
    const t = e.target.closest(".adventurer-card");
    if (!t) return;
    const a = state.tracks.find((e) => e.id === t.dataset.adventurerId);
    a && ((a.sound = e.target.value), stopScheduledVoices(a.id), persist());
  },
  handleTrackDraftInput = (e) => {
    const t = e.target.dataset.action;
    if (!["incantation", "volume", "pan"].includes(t)) return;
    const a = e.target.closest(".adventurer-card");
    if (!a) return;
    const n = state.tracks.find((e) => e.id === a.dataset.adventurerId);
    if (!n) return;
    if (handleTrackSettingInput(a, n, t, e.target.value)) return;
    n.sequence = e.target.value;
    const r = parseSequence(n.sequence),
      s = n.notes;
    (reconcileStepIds(s, r.notes),
      reconcileTrackCursor(n, s, r.notes),
      (n.notes = r.notes),
      (n.error = r.error),
      syncActiveStep(n),
      updateTrackIndicators(a, n),
      persist());
  },
  handleTrackClick = (e) => {
    const t = e.target.closest("button[data-action]");
    if (!t) return;
    const a = t.closest(".adventurer-card");
    if (!a) return;
    const n = state.tracks.find((e) => e.id === a.dataset.adventurerId);
    if (n) {
      if ("settings" === t.dataset.action)
        return (
          (n.settingsOpen = !n.settingsOpen),
          void syncCardFlipState(a, n)
        );
      ("silence" === t.dataset.action &&
        ((n.muted = !n.muted),
        n.muted && stopScheduledVoices(n.id),
        a.classList.toggle("is-silenced", n.muted),
        (t.textContent = n.muted ? "Unmute" : "Mute"),
        persist()),
        "banish" === t.dataset.action && removeTrack(n.id));
    }
  },
  bindEvents = () => {
    (els.addTrack.addEventListener("click", () => addTrack()),
      els.record.addEventListener("click", toggleRecording),
      els.save.addEventListener("click", saveProject),
      els.upload.addEventListener("click", () => els.uploadInput.click()),
      els.uploadInput.addEventListener("change", handleProjectUpload),
      els.playToggle.addEventListener("click", () => {
        state.playing ? pausePlayback() : startPlayback();
      }),
      els.tempo.addEventListener("input", (e) => {
        ((state.bpm = Number(e.target.value)),
          (els.tempoReadout.textContent = `${state.bpm} BPM`),
          persist());
      }),
      els.tracks.addEventListener("change", handleTrackInput),
      els.tracks.addEventListener("input", handleTrackDraftInput),
      els.tracks.addEventListener("click", handleTrackClick),
      window.addEventListener("pagehide", () => {
        (persistNow(), state.playing ? pausePlayback() : scheduleIdleSuspend());
      }));
  },
  boot = () => {
    (restore() || (state.tracks = starterTracks.map((e) => makeTrack(e))),
      (state.bpm = Math.max(48, Math.min(218, state.bpm))),
      bindEvents(),
      updateRecordButton(),
      renderTracks());
  };
boot();
