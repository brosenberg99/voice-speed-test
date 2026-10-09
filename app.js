// Voice speed test: times three small in-browser voice makers (Pocket TTS, Piper, Kokoro) next to the
// system voice, so we know whether any of them is fast enough on Ben's Surface before we build anything.
const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

const SENTENCES = [
  { key: "short", label: "Short", text: "I want to play a game.", limit: 1.0 },
  { key: "medium", label: "Medium", text: "Can you help me find my favorite game, please?", limit: 1.5 },
  { key: "long", label: "Long", text: "I would like to listen to a story about a brave knight and a friendly dragon who became best friends.", limit: 2.0 },
];
const LOOP_MS = (Number(params.get("loopsec")) || 600) * 1000; // 10 minutes; ?loopsec=20 is only for checking the page

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname) && !params.get("remote");
const POCKET_BASE = LOCAL ? "../models/pocket" : "https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main/onnx";
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/";
const PIPER_URL = "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js";
const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? "n/a" : Number(n).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- step 0: make the page use every core (service worker adds the headers GitHub Pages cannot) ---------- */
async function prepareIsolation() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;
    if (!self.crossOriginIsolated && !sessionStorage.getItem("isolation-reload")) {
      sessionStorage.setItem("isolation-reload", "1");
      location.reload();
      await new Promise(() => {});
    }
  } catch (err) {
    console.warn("service worker unavailable", err);
  }
}

/* ---------- audio player: plays chunks as they arrive and notices any gaps ---------- */
// Like Pocket TTS's own demo player, it waits until 0.3 s of speech is ready before it starts, so a slow second
// chunk does not leave a hole right at the beginning. Every voice maker is played the same way.
const PREBUFFER_SEC = 0.3;
class Player {
  constructor() { this.ctx = null; this.reset(); }
  async ensure() {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
    if (this.ctx.state !== "running") await this.ctx.resume();
  }
  reset() { this.next = 0; this.firstAt = null; this.gaps = 0; this.gapMs = 0; this.audioSec = 0; this.endTime = 0; this.queue = []; this.queuedSec = 0; this.started = false; }
  push(samples, rate) {
    this.audioSec += samples.length / rate;
    if (this.started) return this.schedule(samples, rate);
    this.queue.push([samples, rate]);
    this.queuedSec += samples.length / rate;
    if (this.queuedSec >= PREBUFFER_SEC) this.startQueue();
  }
  end() { if (!this.started && this.queue.length) this.startQueue(); } // a short sentence: play what there is
  startQueue() {
    this.started = true;
    this.firstAt = performance.now();
    this.next = this.ctx.currentTime + 0.03;
    for (const [samples, rate] of this.queue) this.schedule(samples, rate);
    this.queue = [];
  }
  schedule(samples, rate) {
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    let start = this.next;
    if (now > this.next + 0.005) { // the next piece was not ready in time: the voice stops for a moment
      this.gaps += 1;
      this.gapMs += (now - this.next) * 1000;
      start = now + 0.01;
    }
    src.start(start);
    this.next = start + buffer.duration;
    this.endTime = this.next;
  }
  async finished() {
    while (this.ctx.currentTime < this.endTime) await sleep(60);
  }
  latency() { return (this.ctx.outputLatency || this.ctx.baseLatency || 0) + 0.03; }
}
const player = new Player();

/* ---------- engines ---------- */
function floatsFromWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const format = v.getUint16(20, true), bits = v.getUint16(34, true), rate = v.getUint32(24, true);
  let pos = 12, dataStart = 44, dataLen = arrayBuffer.byteLength - 44;
  while (pos + 8 <= arrayBuffer.byteLength) { // find the "data" chunk instead of assuming a 44-byte header
    const id = String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1), v.getUint8(pos + 2), v.getUint8(pos + 3));
    const size = v.getUint32(pos + 4, true);
    if (id === "data") { dataStart = pos + 8; dataLen = Math.min(size, arrayBuffer.byteLength - dataStart); break; }
    pos += 8 + size + (size % 2);
  }
  let out;
  if (format === 3 && bits === 32) out = new Float32Array(arrayBuffer.slice(dataStart, dataStart + dataLen - (dataLen % 4)));
  else if (bits === 16) {
    const n = Math.floor(dataLen / 2); out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = v.getInt16(dataStart + i * 2, true) / 32768;
  } else throw new Error(`Unexpected audio format ${format}/${bits}`);
  return { samples: out, rate };
}

const engines = [];

// The voice already on the device: what Ben hears today. Gives the numbers the others have to beat.
engines.push({
  id: "system", name: "System voice (today's)", blurb: "The Windows voice the Hub keyboard speaks with now. Needs no download.",
  needsDownload: false,
  voices: () => speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)).map((v) => v.name),
  async load() { await new Promise((r) => { if (speechSynthesis.getVoices().length) r(); else speechSynthesis.onvoiceschanged = r; setTimeout(r, 1500); }); },
  run(text, voiceName) {
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = speechSynthesis.getVoices().find((x) => x.name === voiceName);
      if (v) u.voice = v;
      const t0 = performance.now();
      let startedAt = null;
      u.onstart = () => { startedAt = performance.now(); };
      u.onerror = (e) => reject(new Error(`System voice error: ${e.error}`));
      u.onend = () => resolve({ ttfs: startedAt === null ? null : (startedAt - t0) / 1000, made: (performance.now() - t0) / 1000, audio: null, gaps: 0, note: "speed not measurable" });
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  },
});

// Pocket TTS: copies a voice from a short clip. Runs in its own worker.
const pocket = {
  id: "pocket", name: "Pocket TTS", blurb: "Can copy a custom voice from a short clip. About 200 MB.", needsDownload: true,
  worker: null, voiceList: [], customReady: false, sampleRate: 24000, handlers: {},
  voices() { return this.customReady ? ["custom", ...this.voiceList] : this.voiceList; },
  async load(setStatus) {
    const url = `./pocket/inference-worker.js?base=${encodeURIComponent(POCKET_BASE)}`;
    this.worker = new Worker(url, { type: "module" });
    let loading = true; // the worker keeps sending status text later; only show it while loading
    await new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "status" && m.status && loading) setStatus(m.status);
        if (m.type === "loaded") loading = false;
        if (m.type === "voices_loaded") this.voiceList = m.voices || [];
        if (m.type === "bundle_loaded" && m.sampleRate) this.sampleRate = m.sampleRate;
        if (m.type === "loaded") resolve();
        if (m.type === "error") reject(new Error(m.error));
        this.handlers[m.type]?.(m);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
      this.worker.postMessage({ type: "load" });
    });
    // save the four sample voices too, so choosing one still works with Wi-Fi off
    setStatus("Saving the sample voices…");
    await Promise.all(["a2", "a5", "b2", "b4"].map((k) => fetch(`./voices/sample-${k}.wav`).then((r) => r.arrayBuffer())));
  },
  async setCustomVoice(samples24k, setStatus) {
    await new Promise((resolve, reject) => {
      const done = () => { this.handlers = {}; };
      this.handlers.voice_encoded = () => { done(); resolve(); };
      this.handlers.error = (m) => { done(); reject(new Error(m.error)); };
      this.handlers.status = (m) => m.status && setStatus(m.status);
      this.worker.postMessage({ type: "encode_voice", data: { audio: samples24k } });
    });
    this.customReady = true;
  },
  run(text, voice, t0) {
    const FADE = 480;
    return new Promise((resolve, reject) => {
      this.handlers.audio_chunk = (m) => {
        const a = m.data, k = m.metrics || {};
        if (k.isFirst || k.chunkStart) for (let i = 0, n = Math.min(FADE, a.length); i < n; i++) a[i] *= i / n;
        if (k.isLast) for (let i = 0, n = Math.min(FADE, a.length); i < n; i++) a[a.length - n + i] *= 1 - i / n;
        player.push(a, this.sampleRate);
      };
      this.handlers.stream_ended = () => { this.handlers = {}; resolve({ made: (performance.now() - t0) / 1000 }); };
      this.handlers.error = (m) => { this.handlers = {}; reject(new Error(m.error)); };
      this.worker.postMessage({ type: "generate", data: { text, voice } });
    });
  },
};
engines.push(pocket);

// Piper: very small and fast, stock voices.
const piper = {
  id: "piper", name: "Piper", blurb: "Very small and quick. Stock voices only. About 60 MB.", needsDownload: true,
  lib: null, session: null, voiceId: null,
  voices: () => ["en_US-ryan-medium", "en_US-hfc_male-medium", "en_US-lessac-medium", "en_US-amy-medium"],
  async load(setStatus, voiceId) {
    this.lib = this.lib || (await import(PIPER_URL));
    const w = { onnxWasm: ORT_DIST, piperData: `${this.lib.WASM_BASE}.data`, piperWasm: `${this.lib.WASM_BASE}.wasm` };
    this.session = await this.lib.TtsSession.create({
      voiceId, wasmPaths: w,
      progress: (p) => p.total && setStatus(`Downloading ${Math.round((p.loaded * 100) / p.total)}%`),
    });
    this.voiceId = voiceId;
    await this.session.predict("Ready."); // first run warms everything up, so timings below are fair
  },
  async ensureVoice(voice) { // the library keeps its first voice, so start a fresh session when the voice changes
    if (voice === this.voiceId) return;
    this.lib.TtsSession._instance = null;
    await this.load(() => {}, voice);
  },
  async run(text, voice, t0) {
    const blob = await this.session.predict(text);
    const { samples, rate } = floatsFromWav(await blob.arrayBuffer());
    player.push(samples, rate);
    return { made: (performance.now() - t0) / 1000 };
  },
};
engines.push(piper);

// Kokoro: clear stock voices, a bit larger.
const kokoro = {
  id: "kokoro", name: "Kokoro", blurb: "Clear, natural stock voices. About 90 MB.", needsDownload: true, tts: null,
  voices: () => ["am_michael", "am_adam", "af_heart", "af_bella"],
  async load(setStatus) {
    const { KokoroTTS, TextSplitterStream } = await import(KOKORO_URL);
    this.Splitter = TextSplitterStream;
    this.tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8", device: "wasm",
      progress_callback: (p) => { if (p && p.status === "progress" && p.total) setStatus(`Downloading ${Math.round(p.progress)}%`); },
    });
    await this.tts.generate("Ready.", { voice: "am_michael" });
  },
  async run(text, voice, t0) {
    const splitter = new this.Splitter(); // the stream only ends once it is closed
    splitter.push(text);
    splitter.close();
    for await (const piece of this.tts.stream(splitter, { voice })) {
      const a = piece.audio;
      player.push(a.audio, a.sampling_rate);
    }
    return { made: (performance.now() - t0) / 1000 };
  },
};
engines.push(kokoro);

/* ---------- state, table, cards ---------- */
const results = [];
const loadTimes = {};
const loaded = new Set();
let busy = false;

function verdict(r) {
  if (r.limit === undefined || r.ttfs === null) return "";
  if (r.gaps > 0) return "GAPS";
  return r.ttfs <= r.limit ? "OK" : "SLOW";
}

function addResult(r) {
  results.push(r);
  const tr = document.createElement("tr");
  const v = verdict(r);
  const cells = [r.voice, r.sentence, fmt(r.ttfs), fmt(r.made), r.audio === null || r.audio === undefined ? "n/a" : fmt(r.audio), r.audio ? fmt(r.audio / r.made, 1) : "n/a", r.gaps === undefined ? "" : `${r.gaps}${r.gaps ? ` (${Math.round(r.gapMs)} ms)` : ""}`, r.error ? `ERROR ${r.error}` : v];
  for (const [i, c] of cells.entries()) {
    const td = document.createElement("td");
    td.textContent = c;
    if (i === 7) td.className = v === "OK" ? "ok" : r.error || v ? "bad" : "";
    tr.appendChild(td);
  }
  $("#results tbody").appendChild(tr);
  refreshOutput();
}

function setBusy(on) {
  busy = on;
  document.querySelectorAll("button").forEach((b) => { if (b.id !== "btn-loop-stop" && b.id !== "btn-copy") b.disabled = on || b.dataset.locked === "1"; });
  if (!on) syncButtons();
}

function syncButtons() {
  for (const e of engines) {
    const card = $(`#card-${e.id}`);
    card.querySelector(".run").disabled = !loaded.has(e.id);
  }
  $("#btn-own").disabled = !loaded.has($("#own-engine").value);
  $("#btn-loop").disabled = !loaded.has($("#loop-engine").value);
  $("#btn-sample-voice").disabled = !loaded.has("pocket");
  $("#voice-file").disabled = !loaded.has("pocket");
  $("#sample-voice").disabled = !loaded.has("pocket");
}

function buildCards() {
  const host = $("#engines");
  for (const e of engines) {
    const card = document.createElement("section");
    card.className = "card";
    card.id = `card-${e.id}`;
    card.innerHTML = `<h2>${e.name}</h2><p class="muted tiny">${e.blurb}</p>
      <label>Voice <select class="voice" aria-label="${e.name} voice"></select></label>
      <div class="row"><button class="load">${e.needsDownload ? "Download &amp; load" : "Load"}</button>
      <button class="run" disabled>Run the 3 test sentences</button></div>
      <div class="status" aria-live="polite"></div>`;
    host.appendChild(card);
    card.querySelector(".load").addEventListener("click", () => loadEngine(e));
    card.querySelector(".run").addEventListener("click", () => runThree(e));
    fillVoices(e);
  }
  for (const sel of [$("#own-engine"), $("#loop-engine")]) {
    for (const e of engines) sel.add(new Option(e.name, e.id));
    sel.addEventListener("change", syncButtons);
  }
  $("#loop-engine").value = "pocket";
  $("#sentences").textContent = SENTENCES.map((s) => `${s.label}: "${s.text}"`).join("  ·  ");
}

function fillVoices(e) {
  const sel = $(`#card-${e.id} .voice`);
  const keep = sel.value;
  sel.innerHTML = "";
  for (const v of e.voices()) sel.add(new Option(v, v));
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  if (e.id === "pocket" && e.customReady) sel.value = "custom";
}
const voiceOf = (e) => $(`#card-${e.id} .voice`).value;
const statusOf = (e, text, cls = "") => { const s = $(`#card-${e.id} .status`); s.textContent = text; s.className = `status ${cls}`; };

async function loadEngine(e) {
  setBusy(true);
  const t0 = performance.now();
  try {
    statusOf(e, "Working…");
    await player.ensure();
    const setStatus = (t) => statusOf(e, t);
    await e.load(setStatus, voiceOf(e));
    const secs = (performance.now() - t0) / 1000;
    loadTimes[e.name] = secs;
    loaded.add(e.id);
    fillVoices(e);
    statusOf(e, `Ready. Download and load took ${fmt(secs, 1)} s.`, "ok");
  } catch (err) {
    console.error(err);
    statusOf(e, `Could not load: ${err.message}`, "bad");
    addResult({ voice: e.name, sentence: "(load)", ttfs: null, made: null, error: err.message });
  }
  setBusy(false);
}

async function speakOnce(e, text, voice) {
  await player.ensure();
  if (e.ensureVoice) await e.ensureVoice(voice); // before the timer starts: changing voice is not part of the speed
  player.reset();
  const t0 = performance.now();
  const r = await e.run(text, voice, t0);
  player.end();
  let ttfs = r.ttfs;
  if (ttfs === undefined) ttfs = player.firstAt === null ? null : (player.firstAt - t0) / 1000 + player.latency();
  await player.finished();
  return { ttfs, made: r.made, audio: e.id === "system" ? null : player.audioSec, gaps: r.gaps ?? player.gaps, gapMs: player.gapMs, note: r.note };
}

async function runThree(e) {
  setBusy(true);
  try {
    for (const s of SENTENCES) {
      statusOf(e, `Speaking the ${s.label.toLowerCase()} sentence…`);
      const r = await speakOnce(e, s.text, voiceOf(e));
      addResult({ voice: `${e.name} (${voiceOf(e)})`, sentence: s.label, limit: s.limit, ...r });
      await sleep(600);
    }
    statusOf(e, "Done. Results are in the table below.", "ok");
  } catch (err) {
    console.error(err);
    statusOf(e, `Problem: ${err.message}`, "bad");
    addResult({ voice: e.name, sentence: "(run)", ttfs: null, made: null, error: err.message });
  }
  setBusy(false);
}

async function runOwn() {
  const e = engines.find((x) => x.id === $("#own-engine").value);
  setBusy(true);
  try {
    const r = await speakOnce(e, $("#own-text").value, voiceOf(e));
    addResult({ voice: `${e.name} (${voiceOf(e)})`, sentence: "Your own", ...r });
  } catch (err) {
    addResult({ voice: e.name, sentence: "Your own", ttfs: null, made: null, error: err.message });
  }
  setBusy(false);
}

/* ---------- Pocket custom voice ---------- */
async function clipTo24k(arrayBuffer) {
  await player.ensure();
  const decoded = await player.ctx.decodeAudioData(arrayBuffer);
  const length = Math.min(Math.round(decoded.duration * 24000), 24000 * 10);
  const off = new OfflineAudioContext(1, length, 24000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}
async function useVoiceClip(arrayBuffer, label) {
  setBusy(true);
  const status = $("#voice-status");
  try {
    status.textContent = "Preparing the custom voice…";
    const t0 = performance.now();
    await pocket.setCustomVoice(await clipTo24k(arrayBuffer), (t) => (status.textContent = t));
    fillVoices(pocket);
    status.textContent = `Custom voice ready (${label}), prepared in ${fmt((performance.now() - t0) / 1000, 1)} s. Pocket TTS will now use it.`;
    status.className = "status ok";
  } catch (err) {
    status.textContent = `Could not use that clip: ${err.message}`;
    status.className = "status bad";
  }
  setBusy(false);
}

/* ---------- 10-minute repeat ---------- */
let loopStop = false;
async function battery() {
  try { const b = await navigator.getBattery(); return { pct: Math.round(b.level * 100), charging: b.charging }; } catch { return null; }
}
const batText = (b) => (b ? `${b.pct}% (${b.charging ? "plugged in" : "on battery"})` : "not available");

async function runLoop() {
  const e = engines.find((x) => x.id === $("#loop-engine").value);
  const text = SENTENCES[1].text;
  const pace = Number($("#loop-pace").value);
  const status = $("#loop-status");
  loopStop = false;
  setBusy(true);
  $("#btn-loop-stop").disabled = false;
  const start = performance.now();
  const b0 = await battery();
  const times = [];
  let gaps = 0;
  try {
    while (performance.now() - start < LOOP_MS && !loopStop) {
      const r = await speakOnce(e, text, voiceOf(e));
      if (r.ttfs !== null) times.push(r.ttfs);
      gaps += r.gaps || 0;
      const elapsed = (performance.now() - start) / 1000;
      status.textContent = `Running… ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")} of 10:00. ${times.length} sentences spoken. Battery at start: ${batText(b0)}.`;
      await sleep(pace * 1000);
    }
  } catch (err) {
    status.textContent = `Stopped: ${err.message}`;
    status.className = "status bad";
  }
  const b1 = await battery();
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const first = times.slice(0, 5), last = times.slice(-5);
  const mins = (performance.now() - start) / 60000;
  const summary = `${fmt(mins, 1)} min, ${times.length} sentences, first sound avg ${fmt(mean(times))} s, worst ${fmt(Math.max(0, ...times))} s, first five avg ${fmt(mean(first))} s vs last five avg ${fmt(mean(last))} s, gaps ${gaps}. Battery ${batText(b0)} to ${batText(b1)}.`;
  status.textContent = `Finished. ${summary}`;
  status.className = "status ok";
  loopSummaries.push(`${e.name} (${voiceOf(e)}), a sentence every ${pace} s: ${summary}`);
  refreshOutput();
  $("#btn-loop-stop").disabled = true;
  setBusy(false);
}
const loopSummaries = [];

/* ---------- device info and the text to send back ---------- */
async function deviceInfo() {
  const b = await battery();
  let storage = "n/a";
  try { const s = await navigator.storage.estimate(); storage = `${Math.round(s.usage / 1048576)} MB used of ${Math.round(s.quota / 1048576)} MB allowed`; } catch {}
  let cpu = "n/a", brand = "n/a";
  try {
    const h = await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"]);
    cpu = `${h.architecture || "?"} ${h.bitness || ""}-bit` + (h.architecture === "arm" ? " (native ARM, good)" : h.architecture === "x86" ? " (x86: on an ARM Surface this means it is running through emulation, which is slower)" : "");
    brand = navigator.userAgentData.brands.map((b) => `${b.brand} ${b.version}`).join(", ");
  } catch {}
  return [
    ["Date", new Date().toString()],
    ["Page", location.href],
    ["Browser", brand],
    ["Browser's processor type", cpu],
    ["Browser (full text)", navigator.userAgent],
    ["Processor cores", navigator.hardwareConcurrency],
    ["Memory (browser's rounded figure, GB)", navigator.deviceMemory ?? "n/a"],
    ["Using all cores (isolated)", self.crossOriginIsolated ? "yes" : "NO: one core only, results will look slower than real"],
    ["Models from", LOCAL ? "this computer (local test)" : "the internet (then saved)"],
    ["Online right now", navigator.onLine ? "yes" : "no (Wi-Fi off)"],
    ["Battery", batText(b)],
    ["Saved space", storage],
  ];
}
async function drawDevice() {
  const rows = await deviceInfo();
  const dl = $("#device");
  dl.innerHTML = "";
  for (const [k, v] of rows) { dl.insertAdjacentHTML("beforeend", "<dt></dt><dd></dd>"); dl.lastElementChild.previousElementSibling.textContent = k; dl.lastElementChild.textContent = String(v); }
  const banner = $("#isolation");
  banner.hidden = false;
  banner.className = self.crossOriginIsolated ? "banner good" : "banner";
  banner.textContent = self.crossOriginIsolated ? `Using all ${navigator.hardwareConcurrency} processor cores. Good.` : "This page is running on one core only, so speeds will look slower than they really are. Reload once; if this stays, tell Bryan.";
}

let lastDevice = [];
async function refreshOutput() {
  lastDevice = await deviceInfo();
  const lines = ["VOICE SPEED TEST RESULTS", ""];
  for (const [k, v] of lastDevice) lines.push(`${k}: ${v}`);
  lines.push("", "Download and load times (s):");
  for (const [k, v] of Object.entries(loadTimes)) lines.push(`  ${k}: ${fmt(v, 1)}`);
  lines.push("", "Voice | Sentence | First sound s | Finished making s | Speech length s | Speed x | Gaps | Result");
  for (const r of results) {
    lines.push([r.voice, r.sentence, fmt(r.ttfs), fmt(r.made), r.audio == null ? "n/a" : fmt(r.audio), r.audio ? fmt(r.audio / r.made, 1) : "n/a", r.gaps === undefined ? "" : `${r.gaps} (${Math.round(r.gapMs || 0)} ms)`, r.error ? `ERROR ${r.error}` : verdict(r)].join(" | "));
  }
  if (loopSummaries.length) { lines.push("", "10-minute runs:"); for (const s of loopSummaries) lines.push(`  ${s}`); }
  $("#out").value = lines.join("\n");
}

async function copyResults() {
  await refreshOutput();
  const text = $("#out").value;
  try { await navigator.clipboard.writeText(text); $("#btn-copy").textContent = "Copied!"; }
  catch { $("#out").select(); document.execCommand("copy"); $("#btn-copy").textContent = "Copied (or select all and copy)"; }
  setTimeout(() => ($("#btn-copy").textContent = "Copy results"), 2500);
}

async function clearDownloads() {
  if (!confirm("Delete the saved voice downloads? The next Download & load will fetch them again.")) return;
  try { (await navigator.serviceWorker.ready).active.postMessage({ type: "clear-cache" }); } catch {}
  try { await caches.delete("voice-speed-test-v1"); } catch {}
  try { const root = await navigator.storage.getDirectory(); for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true }); } catch {}
  alert("Cleared. Reload the page before testing the download times again.");
}

/* ---------- start ---------- */
await prepareIsolation();
buildCards();
await drawDevice();
refreshOutput();
syncButtons();
window.addEventListener("online", drawDevice);
window.addEventListener("offline", drawDevice);
$("#btn-own").addEventListener("click", runOwn);
$("#btn-loop").addEventListener("click", runLoop);
$("#btn-loop-stop").addEventListener("click", () => { loopStop = true; });
$("#btn-copy").addEventListener("click", copyResults);
$("#btn-clear").addEventListener("click", clearDownloads);
$("#btn-sample-voice").addEventListener("click", async () => {
  const key = $("#sample-voice").value, label = $("#sample-voice").selectedOptions[0].textContent;
  try { const res = await fetch(`./voices/sample-${key}.wav`); if (!res.ok) throw new Error(`HTTP ${res.status}`); await useVoiceClip(await res.arrayBuffer(), label); }
  catch (err) { $("#voice-status").textContent = `Could not load the sample voice: ${err.message}`; $("#voice-status").className = "status bad"; }
});
$("#voice-file").addEventListener("change", async (ev) => { const f = ev.target.files[0]; if (f) await useVoiceClip(await f.arrayBuffer(), f.name); });
window.__test = { engines, results, loaded, loadEngine, runThree, speakOnce, player, pocket, useVoiceClip }; // for automated checks
