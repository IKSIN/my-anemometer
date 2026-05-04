'use strict';

// Bumped together with the service worker CACHE name in sw.js so the footer
// reliably reflects which build is actually running on the user's device.
const APP_VERSION = 'v9';

// BLE GATT identifiers — must match the firmware in src/main.cpp.
const BLE_SERVICE_UUID        = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_TELEMETRY_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CONFIG_CHAR_UUID    = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);

const els = {
  connect: $('btn-connect'),
  disconnect: $('btn-disconnect'),
  gps: $('btn-gps'),
  bleDot: $('ble-dot'),
  bleState: $('ble-state'),
  gpsDot: $('gps-dot'),
  gpsState: $('gps-state'),
  blePill: $('ble-pill'),
  recPill: $('rec-pill'),
  recElapsed: $('rec-elapsed'),
  toastRegion: $('toast-region'),
  confirmDialog: $('confirm-dialog'),
  confirmBody: $('confirm-body'),
  confirmCancel: $('confirm-cancel'),
  confirmOk: $('confirm-ok'),

  liveHz: $('live-hz'),
  liveRpm: $('live-rpm'),
  liveKmh: $('live-kmh'),
  liveMps: $('live-mps'),

  sessionName: $('session-name'),
  sessionStart: $('btn-session-start'),
  sessionStop: $('btn-session-stop'),
  sessionInfo: $('session-info'),

  fitEmpty: $('fit-empty'),
  fitTable: $('fit-table'),
  fit1k: $('fit1-k'),
  fit1r: $('fit1-r'),
  fit2k: $('fit2-k'),
  fit2b: $('fit2-b'),
  fit2r: $('fit2-r'),

  sessionsList: $('sessions-list'),
  exportJson: $('btn-export-json'),
  exportCsv: $('btn-export-csv'),

  pushFit1: $('push-fit1'),
  pushFit2: $('push-fit2'),
  devReadout: $('dev-readout'),
  unitBtns: Array.from(document.querySelectorAll('.unit-btn')),
  manualK: $('manual-k'),
  manualB: $('manual-b'),
  pushManual: $('push-manual'),

  manPairHz: $('man-pair-hz'),
  manPairV: $('man-pair-v'),
  manUnitBtns: Array.from(document.querySelectorAll('.man-unit-btn')),
  manPairAdd: $('man-pair-add'),
  manPairsList: $('man-pairs-list'),
  manFitTable: $('man-fit-table'),
  manFit1k: $('man-fit1-k'),
  manFit1r: $('man-fit1-r'),
  manFit2k: $('man-fit2-k'),
  manFit2b: $('man-fit2-b'),
  manFit2r: $('man-fit2-r'),
  manPushFit1: $('man-push-fit1'),
  manPushFit2: $('man-push-fit2'),

  tabBtns: Array.from(document.querySelectorAll('.tab')),
  views: { monitor: $('view-monitor'), calib: $('view-calib') },
  monWindUnit: $('mon-wind-unit'),
  monWindTitle: $('mon-wind-title'),
  monWindMin: $('mon-wind-min'),
  monWindAvg: $('mon-wind-avg'),
  monWindMax: $('mon-wind-max'),
  monHzMin: $('mon-hz-min'),
  monHzAvg: $('mon-hz-avg'),
  monHzMax: $('mon-hz-max'),
  monCalcUnit: $('mon-calc-unit'),
  monCalcTitle: $('mon-calc-title'),
  monCalcMin: $('mon-calc-min'),
  monCalcAvg: $('mon-calc-avg'),
  monCalcMax: $('mon-calc-max'),
  monPreviewK: $('mon-preview-k'),
  windowBtns: Array.from(document.querySelectorAll('.window-btn')),
};

// Toast notifications. `kind` is 'error' | 'info' | 'success'.
function showToast(msg, kind) {
  if (!msg) return;
  if (!els.toastRegion) return;
  const t = document.createElement('div');
  t.className = `toast toast--${kind || 'info'}`;
  t.textContent = msg;
  const ttl = kind === 'error' ? 8000 : 4000;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 180);
  };
  t.addEventListener('click', dismiss);
  els.toastRegion.appendChild(t);
  setTimeout(dismiss, ttl);
}

// Backwards-compatible wrapper. Empty msg used to clear the red strip — toasts
// auto-clear themselves, so empty calls are no-ops.
function showError(msg) {
  if (msg) showToast(msg, 'error');
}

// Tactile feedback. iOS Safari ignores navigator.vibrate, which is fine.
function buzz(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (_) {}
  }
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- State ----------
const state = {
  bleDevice: null,
  bleChar: null,
  bleConfigChar: null,
  deviceConfig: { k: null, b: null, unit: null },
  bleConnected: false,

  gpsWatchId: null,
  gpsLatest: { speed: null, accuracy: null, ts: 0 }, // m/s

  hzLatest: null,
  rpmLatest: null,
  msLatest: 0,

  currentSession: null,             // { name, startedAt, samples: [] }
  selectedSessionIds: new Set(),    // for fit/chart
  sessions: [],                     // in-memory mirror of IDB
  lastFit: { noOff: null, withOff: null },

  activeTab: 'monitor',
  monitor: {
    samples: [],                    // rolling [{ t, hz, vMps }]
    windowSec: 60,
    previewK: 0,                    // m/s per Hz, used for "Calc wind" chart
  },

  manualPairs: [],                  // [{ hz, vMps, unitEntered }]
  manualEntryUnit: 'kn',            // current unit for new pair entry

  ble: {
    reconnecting: false,
    reconnectTimer: null,
    userDisconnected: false,
  },

  recTimer: null,
  firstSessionsLoad: true,
};

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('anemo-calib', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAddSession(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const req = tx.objectStore('sessions').add(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAllSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const req = tx.objectStore('sessions').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const req = tx.objectStore('sessions').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- BLE ----------

function saveLastBleName(name) {
  try { localStorage.setItem('anemoBleName', name || ''); } catch (_) {}
}
function loadLastBleName() {
  try { return localStorage.getItem('anemoBleName') || ''; } catch (_) { return ''; }
}

async function attachCharacteristics(server) {
  const svc = await server.getPrimaryService(BLE_SERVICE_UUID);
  const ch  = await svc.getCharacteristic(BLE_TELEMETRY_CHAR_UUID);
  state.bleChar = ch;
  await ch.startNotifications();
  ch.addEventListener('characteristicvaluechanged', onBleNotify);

  const cfg = await svc.getCharacteristic(BLE_CONFIG_CHAR_UUID);
  state.bleConfigChar = cfg;
  cfg.addEventListener('characteristicvaluechanged', onConfigNotify);
  await cfg.startNotifications();
  const initial = await cfg.readValue();
  handleConfigBytes(initial);
}

async function bleConnect() {
  showError('');
  if (!navigator.bluetooth) {
    showError('Web Bluetooth не поддерживается в этом браузере.');
    return;
  }
  try {
    const saved = loadLastBleName();
    let dev;
    try {
      const filter = { services: [BLE_SERVICE_UUID] };
      if (saved) filter.name = saved;
      dev = await navigator.bluetooth.requestDevice({ filters: [filter] });
    } catch (err) {
      // Saved name no longer matches a nearby device — fall back to service-only filter.
      if (saved && err && (err.name === 'NotFoundError' || err.name === 'SecurityError')) {
        dev = await navigator.bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE_UUID] }],
        });
      } else {
        throw err;
      }
    }
    state.bleDevice = dev;
    state.ble.userDisconnected = false;
    dev.addEventListener('gattserverdisconnected', onBleDisconnected);
    setBleState('connecting');
    const srv = await dev.gatt.connect();
    await attachCharacteristics(srv);

    state.bleConnected = true;
    setBleState('connected: ' + (dev.name || dev.id));
    saveLastBleName(dev.name || '');
    if (dev.name) els.connect.textContent = `Reconnect to ${dev.name}`;
    els.connect.disabled = true;
    els.disconnect.disabled = false;
    setDeviceControlsEnabled(true);
    buzz(15);
  } catch (e) {
    showError('BLE: ' + e.message);
    setBleState('disconnected');
  }
}

function bleDisconnect() {
  state.ble.userDisconnected = true;
  if (state.ble.reconnectTimer) {
    clearTimeout(state.ble.reconnectTimer);
    state.ble.reconnectTimer = null;
  }
  state.ble.reconnecting = false;
  if (state.bleDevice && state.bleDevice.gatt.connected) {
    state.bleDevice.gatt.disconnect();
  }
  onBleDisconnected();
}

function scheduleReconnect() {
  if (state.ble.reconnectTimer) return;
  if (state.ble.userDisconnected || !state.bleDevice) return;
  state.ble.reconnecting = true;
  setBleState('auto-reconnecting…');

  const tryOnce = async () => {
    state.ble.reconnectTimer = null;
    if (state.ble.userDisconnected || !state.bleDevice) {
      state.ble.reconnecting = false;
      return;
    }
    try {
      const srv = await state.bleDevice.gatt.connect();
      await attachCharacteristics(srv);
      state.bleConnected = true;
      state.ble.reconnecting = false;
      setBleState('connected: ' + (state.bleDevice.name || ''));
      els.connect.disabled = true;
      els.disconnect.disabled = false;
      setDeviceControlsEnabled(true);
      buzz(15);
    } catch (_) {
      state.ble.reconnectTimer = setTimeout(tryOnce, 2500);
    }
  };
  state.ble.reconnectTimer = setTimeout(tryOnce, 1500);
}

function onBleDisconnected() {
  state.bleConnected = false;
  state.bleChar = null;
  state.bleConfigChar = null;
  state.deviceConfig = { k: null, b: null, unit: null };
  els.connect.disabled = false;
  els.disconnect.disabled = true;
  setDeviceControlsEnabled(false);
  renderDeviceReadout();
  if (!state.ble.userDisconnected && state.bleDevice) {
    scheduleReconnect();
  } else {
    setBleState('disconnected');
  }
}

function onConfigNotify(e) {
  handleConfigBytes(e.target.value);
}

function handleConfigBytes(view) {
  const txt = new TextDecoder().decode(view);
  try {
    const obj = JSON.parse(txt);
    state.deviceConfig = {
      k: Number(obj.k),
      b: Number(obj.b),
      unit: String(obj.unit),
    };
    renderDeviceReadout();
  } catch (err) {
    console.warn('bad config payload', txt);
  }
}

function renderDeviceReadout() {
  const c = state.deviceConfig;
  if (c.k == null) {
    els.devReadout.textContent = 'device config: not connected';
  } else if (!isFinite(c.k) || c.k <= 0) {
    els.devReadout.textContent = `device: uncalibrated · unit ${c.unit}`;
  } else {
    els.devReadout.textContent =
      `device: k=${c.k.toFixed(4)} m/s/Hz · b=${c.b.toFixed(3)} · unit ${c.unit}`;
  }
  for (const btn of els.unitBtns) {
    btn.classList.toggle('primary', btn.dataset.unit === c.unit);
  }
  syncManualInputs();
  // Unit change repaints monitor labels and recomputes wind stats.
  if (typeof updateMonitor === 'function') updateMonitor();
  if (typeof renderManualPanel === 'function') renderManualPanel();
}

function syncManualInputs() {
  // Mirror device values into the manual fields, but never clobber what the
  // user is currently typing.
  const c = state.deviceConfig;
  if (c.k != null && isFinite(c.k) && document.activeElement !== els.manualK) {
    els.manualK.value = c.k.toFixed(4);
  }
  if (c.b != null && isFinite(c.b) && document.activeElement !== els.manualB) {
    els.manualB.value = c.b.toFixed(3);
  }
}

function setDeviceControlsEnabled(en) {
  for (const btn of els.unitBtns) btn.disabled = !en;
  els.pushManual.disabled = !en;
  els.manualK.disabled = !en;
  els.manualB.disabled = !en;
  // fit push buttons depend additionally on having a non-empty fit; rerenderFitAndChart manages.
  rerenderFitAndChart();
  if (typeof renderManualPanel === 'function') renderManualPanel();
}

async function pushManual() {
  const kRaw = els.manualK.value.trim();
  const bRaw = els.manualB.value.trim();
  const k = parseFloat(kRaw);
  if (!isFinite(k)) { showError('manual: k must be a number'); return; }
  const payload = { k };
  if (bRaw !== '') {
    const b = parseFloat(bRaw);
    if (!isFinite(b)) { showError('manual: b must be a number'); return; }
    payload.b = b;
  } else {
    payload.b = 0;
  }
  await confirmAndPush(payload);
}

async function pushConfig(partial) {
  if (!state.bleConfigChar) {
    showError('BLE not connected');
    return;
  }
  try {
    const json = JSON.stringify(partial);
    await state.bleConfigChar.writeValue(new TextEncoder().encode(json));
    // Device will notify back; we rely on that to update the readout.
  } catch (e) {
    showError('config push: ' + e.message);
  }
}

function onBleNotify(e) {
  const txt = new TextDecoder().decode(e.target.value);
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch (err) {
    console.warn('bad BLE payload', txt);
    return;
  }
  state.hzLatest = Number(obj.hz);
  state.rpmLatest = Number(obj.rpm);
  state.msLatest = Number(obj.ms || 0);
  updateLive();
  ingestSample(obj);
  pushMonitorSample(state.hzLatest, Number(obj.v_mps));
}

function setBleState(text) {
  els.bleState.textContent = text;
  els.bleDot.classList.toggle('on', state.bleConnected);
  if (els.blePill) {
    els.blePill.classList.toggle('is-reconnecting',
      !state.bleConnected && !!state.ble.reconnecting);
  }
}

// ---------- GPS ----------
function gpsStart() {
  if (!navigator.geolocation) {
    showError('Geolocation не поддерживается.');
    return;
  }
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
    setGpsState('off');
    els.gps.textContent = 'Start GPS';
    return;
  }
  setGpsState('waiting fix…');
  els.gps.textContent = 'Stop GPS';
  state.gpsWatchId = navigator.geolocation.watchPosition(
    onGps,
    (err) => showError('GPS: ' + err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
  );
}

function onGps(pos) {
  const c = pos.coords;
  state.gpsLatest = {
    speed: c.speed,           // m/s, may be null
    accuracy: c.accuracy,     // m
    ts: pos.timestamp,
  };
  setGpsState(c.speed != null
    ? `${c.speed.toFixed(2)} m/s · acc ${Math.round(c.accuracy)} m`
    : `no speed · acc ${Math.round(c.accuracy)} m`);
  updateLive();
}

function setGpsState(text) {
  els.gpsState.textContent = text;
  els.gpsDot.classList.toggle('on', state.gpsWatchId !== null && state.gpsLatest.speed != null);
}

// ---------- Live UI ----------
function updateLive() {
  if (state.hzLatest != null) {
    els.liveHz.textContent = state.hzLatest.toFixed(1);
    els.liveRpm.textContent = `${state.rpmLatest} RPM`;
  }
  const s = state.gpsLatest.speed;
  if (s != null) {
    els.liveKmh.textContent = (s * 3.6).toFixed(1);
    els.liveMps.textContent = `${s.toFixed(2)} m/s · acc ${Math.round(state.gpsLatest.accuracy)} m`;
  } else if (state.gpsLatest.accuracy != null) {
    els.liveKmh.textContent = '—';
    els.liveMps.textContent = `acc ${Math.round(state.gpsLatest.accuracy)} m`;
  }
}

// ---------- Sample ingestion ----------
function ingestSample(obj) {
  if (!state.currentSession) return;
  // Pair the BLE notification with the most recent GPS sample (if any).
  const sample = {
    ts: Date.now(),
    ms: state.msLatest,
    hz: state.hzLatest,
    rpm: state.rpmLatest,
    pulses: Number(obj.pulses) || 0,
    total: Number(obj.total) || 0,
    gpsSpeed: state.gpsLatest.speed,
    gpsAcc: state.gpsLatest.accuracy,
    gpsTs: state.gpsLatest.ts,
  };
  state.currentSession.samples.push(sample);
  els.sessionInfo.textContent = `recording… ${state.currentSession.samples.length} samples`;
}

// ---------- Session controls ----------
function startRecPill(startedAt) {
  if (!els.recPill) return;
  els.recPill.hidden = false;
  const tick = () => {
    if (els.recElapsed) els.recElapsed.textContent = formatElapsed(Date.now() - startedAt);
  };
  tick();
  if (state.recTimer) clearInterval(state.recTimer);
  state.recTimer = setInterval(tick, 1000);
}

function stopRecPill() {
  if (state.recTimer) {
    clearInterval(state.recTimer);
    state.recTimer = null;
  }
  if (els.recPill) els.recPill.hidden = true;
  if (els.recElapsed) els.recElapsed.textContent = '0:00';
}

async function sessionStart() {
  if (state.currentSession) return;
  const name = els.sessionName.value.trim() || `session-${new Date().toISOString().slice(0,16)}`;
  state.currentSession = {
    name,
    startedAt: Date.now(),
    endedAt: null,
    samples: [],
  };
  els.sessionStart.disabled = true;
  els.sessionStop.disabled = false;
  els.sessionInfo.textContent = `recording… 0 samples`;
  startRecPill(state.currentSession.startedAt);
  buzz(15);
  showToast(`Recording started: ${name}`, 'success');
}

async function sessionStop() {
  if (!state.currentSession) return;
  state.currentSession.endedAt = Date.now();
  const sampleCount = state.currentSession.samples.length;
  const id = await dbAddSession(state.currentSession);
  state.currentSession = null;
  els.sessionStart.disabled = false;
  els.sessionStop.disabled = true;
  els.sessionInfo.textContent = `saved (id ${id})`;
  els.sessionName.value = '';
  stopRecPill();
  buzz([10, 60, 10]);
  showToast(`Saved session #${id} · ${sampleCount} samples`, 'success');
  await refreshSessions();
  state.selectedSessionIds.add(id);
  rerenderFitAndChart();
}

// ---------- Sessions list ----------
function renderSessionsSkeleton() {
  const row = '<div class="session-row skeleton"><div class="meta"><div class="bar long" style="margin-bottom:6px"></div><div class="bar short"></div></div></div>';
  els.sessionsList.innerHTML = row + row + row;
}

async function refreshSessions() {
  if (state.firstSessionsLoad) renderSessionsSkeleton();
  state.sessions = await dbAllSessions();
  state.firstSessionsLoad = false;
  if (!state.sessions.length) {
    els.sessionsList.innerHTML = '<div class="empty-state">No recordings yet. Connect to BLE and tap «Start session».</div>';
    return;
  }
  els.sessionsList.innerHTML = '';
  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    const dur = ((s.endedAt - s.startedAt) / 1000) | 0;
    const checked = state.selectedSessionIds.has(s.id) ? 'checked' : '';
    row.innerHTML = `
      <input type="checkbox" data-id="${s.id}" ${checked}>
      <div class="meta">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="info">${new Date(s.startedAt).toLocaleString()} · ${s.samples.length} samples · ${dur}s</div>
      </div>
      <div class="actions">
        <button data-act="export" data-id="${s.id}">CSV</button>
        <button data-act="delete" data-id="${s.id}" class="danger">Del</button>
      </div>
    `;
    els.sessionsList.appendChild(row);
  }
  els.sessionsList.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) state.selectedSessionIds.add(id);
      else state.selectedSessionIds.delete(id);
      rerenderFitAndChart();
    });
  });
  els.sessionsList.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.dataset.id);
      const act = e.target.dataset.act;
      if (act === 'delete') {
        if (!confirm('Delete this session?')) return;
        await dbDeleteSession(id);
        state.selectedSessionIds.delete(id);
        await refreshSessions();
        rerenderFitAndChart();
      } else if (act === 'export') {
        const s = state.sessions.find(x => x.id === id);
        if (s) downloadCsv(s);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ---------- Regression ----------
function collectPairs() {
  const pairs = []; // { hz, v, sessionId }
  for (const s of state.sessions) {
    if (!state.selectedSessionIds.has(s.id)) continue;
    for (const sm of s.samples) {
      if (sm.hz == null) continue;
      if (sm.gpsSpeed == null) continue;
      // Filter out parked samples (no rotation, GPS noise).
      if (sm.hz < 0.05 && sm.gpsSpeed < 0.5) continue;
      pairs.push({ hz: sm.hz, v: sm.gpsSpeed, sessionId: s.id });
    }
  }
  return pairs;
}

function fitNoOffset(pairs) {
  let sff = 0, sfv = 0;
  for (const p of pairs) { sff += p.hz * p.hz; sfv += p.hz * p.v; }
  const k = sff > 0 ? sfv / sff : 0;
  return { k, b: 0 };
}

function fitWithOffset(pairs) {
  const n = pairs.length;
  if (n < 2) return { k: 0, b: 0 };
  let sf = 0, sv = 0, sff = 0, sfv = 0;
  for (const p of pairs) { sf += p.hz; sv += p.v; sff += p.hz * p.hz; sfv += p.hz * p.v; }
  const denom = n * sff - sf * sf;
  if (Math.abs(denom) < 1e-12) return { k: 0, b: sv / n };
  const k = (n * sfv - sf * sv) / denom;
  const b = (sv - k * sf) / n;
  return { k, b };
}

function rSquared(pairs, k, b) {
  if (!pairs.length) return 0;
  let sv = 0;
  for (const p of pairs) sv += p.v;
  const mean = sv / pairs.length;
  let ssRes = 0, ssTot = 0;
  for (const p of pairs) {
    const pred = k * p.hz + b;
    ssRes += (p.v - pred) ** 2;
    ssTot += (p.v - mean) ** 2;
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

// ---------- Chart ----------
let chart = null;
const sessionColors = ['#7cd4fd', '#f7b955', '#6cd17f', '#ef6f6c', '#c084fc', '#fb7185'];

function colorForSession(id) {
  const idx = state.sessions.findIndex(s => s.id === id);
  return sessionColors[idx % sessionColors.length] || '#9aa3b2';
}

function ensureChart() {
  if (chart) return;
  const ctx = document.getElementById('chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'scatter',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { title: { display: true, text: 'Hz' }, grid: { color: '#2a2f3a' }, ticks: { color: '#8b94a3' } },
        y: { title: { display: true, text: 'm/s' }, grid: { color: '#2a2f3a' }, ticks: { color: '#8b94a3' } },
      },
      plugins: {
        legend: { labels: { color: '#e6e8ec' } },
      },
    },
  });
}

function rerenderFitAndChart() {
  const pairs = collectPairs();
  const noOff = fitNoOffset(pairs);
  const withOff = fitWithOffset(pairs);
  const r1 = rSquared(pairs, noOff.k, 0);
  const r2 = rSquared(pairs, withOff.k, withOff.b);

  if (!pairs.length) {
    els.fitTable.hidden = true;
    els.fitEmpty.style.display = '';
    els.fitEmpty.textContent = 'Select one or more sessions below to compute a fit.';
    els.pushFit1.disabled = true;
    els.pushFit2.disabled = true;
    state.lastFit = { noOff: null, withOff: null };
  } else {
    els.fitEmpty.style.display = 'none';
    els.fitTable.hidden = false;
    els.fit1k.textContent = noOff.k.toFixed(4);
    els.fit1r.textContent = r1.toFixed(3);
    els.fit2k.textContent = withOff.k.toFixed(4);
    els.fit2b.textContent = withOff.b.toFixed(3);
    els.fit2r.textContent = r2.toFixed(3);
    state.lastFit = { noOff, withOff };
    const canPush = state.bleConnected && state.bleConfigChar;
    els.pushFit1.disabled = !canPush || !(noOff.k > 0);
    els.pushFit2.disabled = !canPush || !(withOff.k > 0);
  }

  ensureChart();
  const datasets = [];
  // One scatter dataset per selected session (so colors differ).
  const grouped = new Map();
  for (const p of pairs) {
    if (!grouped.has(p.sessionId)) grouped.set(p.sessionId, []);
    grouped.get(p.sessionId).push({ x: p.hz, y: p.v });
  }
  for (const [sid, pts] of grouped.entries()) {
    const sess = state.sessions.find(s => s.id === sid);
    datasets.push({
      type: 'scatter',
      label: sess ? sess.name : `session ${sid}`,
      data: pts,
      backgroundColor: colorForSession(sid),
      pointRadius: 3,
    });
  }
  // Fit lines.
  if (pairs.length) {
    let maxHz = 0;
    for (const p of pairs) maxHz = Math.max(maxHz, p.hz);
    maxHz = Math.max(maxHz, 1);
    datasets.push({
      type: 'line',
      label: `v=k·f  (k=${noOff.k.toFixed(3)}, R²=${r1.toFixed(2)})`,
      data: [{ x: 0, y: 0 }, { x: maxHz, y: noOff.k * maxHz }],
      borderColor: '#7cd4fd',
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
    });
    datasets.push({
      type: 'line',
      label: `v=k·f+b  (k=${withOff.k.toFixed(3)}, b=${withOff.b.toFixed(2)}, R²=${r2.toFixed(2)})`,
      data: [{ x: 0, y: withOff.b }, { x: maxHz, y: withOff.k * maxHz + withOff.b }],
      borderColor: '#f7b955',
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
    });
  }
  chart.data.datasets = datasets;
  chart.update();
}

// ---------- Export ----------
function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(session) {
  const header = 'ts,ms,hz,rpm,pulses,total,gpsSpeed_mps,gpsAcc_m\n';
  const rows = session.samples.map(s => [
    s.ts, s.ms, s.hz, s.rpm, s.pulses, s.total,
    s.gpsSpeed ?? '', s.gpsAcc ?? ''
  ].join(',')).join('\n');
  const safe = session.name.replace(/[^\w.-]+/g, '_');
  downloadBlob(`${safe}.csv`, 'text/csv', header + rows);
}

function exportAllJson() {
  downloadBlob('anemo-sessions.json', 'application/json',
    JSON.stringify(state.sessions, null, 2));
}

function exportSelectedCsv() {
  if (!state.sessions.length) return;
  const selected = state.sessions.filter(s => state.selectedSessionIds.has(s.id));
  const targets = selected.length ? selected : state.sessions;
  const header = 'session,ts,ms,hz,rpm,gpsSpeed_mps,gpsAcc_m\n';
  const rows = [];
  for (const s of targets) {
    for (const sm of s.samples) {
      rows.push([s.name, sm.ts, sm.ms, sm.hz, sm.rpm,
                 sm.gpsSpeed ?? '', sm.gpsAcc ?? ''].join(','));
    }
  }
  downloadBlob('anemo-selected.csv', 'text/csv', header + rows.join('\n'));
}

// ---------- Monitor ----------
const UNIT_LABELS = { kn: 'kn', mps: 'm/s', kmh: 'km/h' };
const UNIT_SCALE  = { kn: 1.943844, mps: 1, kmh: 3.6 };

function currentUnit() {
  const u = state.deviceConfig && state.deviceConfig.unit;
  return UNIT_LABELS[u] ? u : 'kn';
}

function mpsTo(unit, v) {
  return v * (UNIT_SCALE[unit] ?? UNIT_SCALE.kn);
}

let chartWind = null;
let chartHz = null;
let chartCalc = null;

function initMonitorCharts() {
  if (chartWind) return;
  const common = {
    type: 'line',
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'seconds ago' },
          grid: { color: '#2a2f3a' },
          ticks: { color: '#8b94a3' },
          reverse: true,
          min: -60, max: 0,
        },
        y: {
          beginAtZero: true,
          grid: { color: '#2a2f3a' },
          ticks: { color: '#8b94a3' },
        },
      },
      plugins: { legend: { display: false } },
      elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.2 } },
    },
  };
  const wctx = $('chart-wind').getContext('2d');
  chartWind = new Chart(wctx, {
    ...common,
    data: { datasets: [{ label: 'wind', data: [], borderColor: '#7cd4fd' }] },
    options: {
      ...common.options,
      scales: {
        ...common.options.scales,
        y: { ...common.options.scales.y, title: { display: true, text: UNIT_LABELS[currentUnit()] } },
      },
    },
  });
  const hctx = $('chart-hz').getContext('2d');
  chartHz = new Chart(hctx, {
    ...common,
    data: { datasets: [{ label: 'hz', data: [], borderColor: '#f7b955' }] },
    options: {
      ...common.options,
      scales: {
        ...common.options.scales,
        y: { ...common.options.scales.y, title: { display: true, text: 'Hz' } },
      },
    },
  });
  const cctx = $('chart-calc').getContext('2d');
  chartCalc = new Chart(cctx, {
    ...common,
    data: { datasets: [{ label: 'calc', data: [], borderColor: '#6cd17f' }] },
    options: {
      ...common.options,
      scales: {
        ...common.options.scales,
        y: { ...common.options.scales.y, title: { display: true, text: UNIT_LABELS[currentUnit()] } },
      },
    },
  });
}

function pushMonitorSample(hz, vMps) {
  if (hz == null || !isFinite(hz)) return;
  const t = performance.now();
  const samples = state.monitor.samples;
  samples.push({ t, hz, vMps: isFinite(vMps) ? vMps : 0 });
  // trim to current window
  const cutoff = t - state.monitor.windowSec * 1000;
  let i = 0;
  while (i < samples.length && samples[i].t < cutoff) i++;
  if (i > 0) samples.splice(0, i);
  if (state.activeTab === 'monitor') updateMonitor();
}

function updateMonitor() {
  initMonitorCharts();
  const samples = state.monitor.samples;
  const u = currentUnit();
  const unitLabel = UNIT_LABELS[u];
  const k = state.monitor.previewK;
  els.monWindUnit.textContent = `(${unitLabel})`;
  els.monCalcUnit.textContent = `(${unitLabel})`;
  els.monWindTitle.textContent = `Wind (${unitLabel})`;
  els.monCalcTitle.textContent = k > 0
    ? `Calc wind (${unitLabel})  ·  k=${k}`
    : `Calc wind (${unitLabel})  ·  set «Preview k» to enable`;
  if (chartWind) chartWind.options.scales.y.title.text = unitLabel;
  if (chartCalc) chartCalc.options.scales.y.title.text = unitLabel;

  if (!samples.length) {
    setText(els.monWindMin, '—'); setText(els.monWindAvg, '—'); setText(els.monWindMax, '—');
    setText(els.monHzMin,   '—'); setText(els.monHzAvg,   '—'); setText(els.monHzMax,   '—');
    setText(els.monCalcMin, '—'); setText(els.monCalcAvg, '—'); setText(els.monCalcMax, '—');
    if (chartWind) { chartWind.data.datasets[0].data = []; chartWind.update('none'); }
    if (chartHz)   { chartHz.data.datasets[0].data = [];   chartHz.update('none'); }
    if (chartCalc) { chartCalc.data.datasets[0].data = []; chartCalc.update('none'); }
    return;
  }

  // Stats
  let hzMin = Infinity, hzMax = -Infinity, hzSum = 0;
  let vMin = Infinity, vMax = -Infinity, vSum = 0;
  let cMin = Infinity, cMax = -Infinity, cSum = 0;
  const haveK = isFinite(k) && k > 0;
  for (const s of samples) {
    if (s.hz < hzMin) hzMin = s.hz;
    if (s.hz > hzMax) hzMax = s.hz;
    hzSum += s.hz;
    const v = mpsTo(u, s.vMps);
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    vSum += v;
    if (haveK) {
      const c = mpsTo(u, k * s.hz);
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
      cSum += c;
    }
  }
  const n = samples.length;
  setText(els.monHzMin, hzMin.toFixed(1));
  setText(els.monHzAvg, (hzSum / n).toFixed(1));
  setText(els.monHzMax, hzMax.toFixed(1));
  setText(els.monWindMin, vMin.toFixed(1));
  setText(els.monWindAvg, (vSum / n).toFixed(1));
  setText(els.monWindMax, vMax.toFixed(1));
  if (haveK) {
    setText(els.monCalcMin, cMin.toFixed(1));
    setText(els.monCalcAvg, (cSum / n).toFixed(1));
    setText(els.monCalcMax, cMax.toFixed(1));
  } else {
    setText(els.monCalcMin, '—');
    setText(els.monCalcAvg, '—');
    setText(els.monCalcMax, '—');
  }

  // Charts: x = relative seconds (negative = older)
  const now = performance.now();
  const windData = samples.map(s => ({ x: (s.t - now) / 1000, y: mpsTo(u, s.vMps) }));
  const hzData   = samples.map(s => ({ x: (s.t - now) / 1000, y: s.hz }));
  const calcData = haveK
    ? samples.map(s => ({ x: (s.t - now) / 1000, y: mpsTo(u, k * s.hz) }))
    : [];
  for (const [chart, data] of [[chartWind, windData], [chartHz, hzData], [chartCalc, calcData]]) {
    if (!chart) continue;
    chart.data.datasets[0].data = data;
    chart.options.scales.x.min = -state.monitor.windowSec;
    chart.options.scales.x.max = 0;
    chart.update('none');
  }
}

function setText(el, t) { if (el) el.textContent = t; }

// ---------- Manual data points ----------

const MANUAL_LS_KEY = 'anemoManualPairs';

function loadManualPairs() {
  try {
    const raw = localStorage.getItem(MANUAL_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) state.manualPairs = parsed.filter(p =>
      p && isFinite(p.hz) && isFinite(p.vMps) && p.hz >= 0 && p.vMps >= 0);
  } catch (_) {}
}

function saveManualPairs() {
  try { localStorage.setItem(MANUAL_LS_KEY, JSON.stringify(state.manualPairs)); } catch (_) {}
}

function setManualEntryUnit(unit) {
  if (!UNIT_LABELS[unit]) unit = 'kn';
  state.manualEntryUnit = unit;
  for (const btn of els.manUnitBtns) {
    btn.classList.toggle('primary', btn.dataset.unit === unit);
  }
  // adjust the wind input placeholder so user knows which unit they're typing in
  els.manPairV.placeholder = `wind (${UNIT_LABELS[unit]})`;
}

function addManualPair() {
  showError('');
  const hz = parseFloat(els.manPairHz.value);
  const v  = parseFloat(els.manPairV.value);
  if (!isFinite(hz) || hz < 0) { showError('manual: Hz must be a non-negative number'); return; }
  if (!isFinite(v)  || v  < 0) { showError('manual: wind must be a non-negative number'); return; }
  const unit = state.manualEntryUnit;
  const scale = UNIT_SCALE[unit] ?? UNIT_SCALE.kn;
  const vMps = v / scale;
  state.manualPairs.push({ hz, vMps, unitEntered: unit });
  saveManualPairs();
  els.manPairHz.value = '';
  els.manPairV.value = '';
  els.manPairHz.focus();
  renderManualPanel();
}

function delManualPair(idx) {
  state.manualPairs.splice(idx, 1);
  saveManualPairs();
  renderManualPanel();
}

function clearManualPairs() {
  if (!state.manualPairs.length) return;
  if (!confirm('Clear all manual pairs?')) return;
  state.manualPairs = [];
  saveManualPairs();
  renderManualPanel();
}

function renderManualPanel() {
  // List
  const pairs = state.manualPairs;
  if (!pairs.length) {
    els.manPairsList.innerHTML = '<div class="empty-state">No pairs yet. Add (Hz, wind) above to fit a k offline.</div>';
  } else {
    const u = currentUnit();
    const label = UNIT_LABELS[u];
    const rows = pairs.map((p, i) => {
      const v = mpsTo(u, p.vMps);
      return `<div class="session-row" style="padding:6px 4px">
        <div class="meta">
          <div class="info">f=<b>${p.hz.toFixed(2)} Hz</b> · v=<b>${v.toFixed(2)} ${label}</b>
          <span class="muted" style="margin-left:6px">(entered as ${UNIT_LABELS[p.unitEntered]})</span></div>
        </div>
        <div class="actions">
          <button class="man-pair-del danger" data-idx="${i}">Del</button>
        </div>
      </div>`;
    }).join('');
    const clear = `<div class="row" style="margin-top:8px"><button id="man-pairs-clear" class="danger">Clear all</button></div>`;
    els.manPairsList.innerHTML = rows + clear;
    els.manPairsList.querySelectorAll('.man-pair-del').forEach(btn => {
      btn.addEventListener('click', e => delManualPair(Number(e.currentTarget.dataset.idx)));
    });
    const clrBtn = $('man-pairs-clear');
    if (clrBtn) clrBtn.addEventListener('click', clearManualPairs);
  }

  // Fit
  const oslPairs = pairs.map(p => ({ hz: p.hz, v: p.vMps }));
  if (oslPairs.length < 1) {
    els.manFitTable.hidden = true;
    els.manPushFit1.disabled = true;
    els.manPushFit2.disabled = true;
    state.lastManualFit = { noOff: null, withOff: null };
    return;
  }
  const noOff = fitNoOffset(oslPairs.map(p => ({ hz: p.hz, v: p.v })));
  const withOff = fitWithOffset(oslPairs.map(p => ({ hz: p.hz, v: p.v })));
  const r1 = rSquared(oslPairs.map(p => ({ hz: p.hz, v: p.v })), noOff.k, 0);
  const r2 = rSquared(oslPairs.map(p => ({ hz: p.hz, v: p.v })), withOff.k, withOff.b);
  els.manFitTable.hidden = false;
  els.manFit1k.textContent = noOff.k.toFixed(4);
  els.manFit1r.textContent = oslPairs.length >= 2 ? r1.toFixed(3) : '—';
  els.manFit2k.textContent = withOff.k.toFixed(4);
  els.manFit2b.textContent = withOff.b.toFixed(3);
  els.manFit2r.textContent = oslPairs.length >= 2 ? r2.toFixed(3) : '—';
  state.lastManualFit = { noOff, withOff };
  const canPush = state.bleConnected && state.bleConfigChar;
  els.manPushFit1.disabled = !canPush || !(noOff.k > 0);
  // require ≥2 distinct points for the offset model to be meaningful
  els.manPushFit2.disabled = !canPush || !(withOff.k > 0) || oslPairs.length < 2;
}

function setActiveTab(name) {
  if (!els.views[name]) name = 'monitor';
  state.activeTab = name;
  for (const btn of els.tabBtns) {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const [key, view] of Object.entries(els.views)) {
    view.classList.toggle('active', key === name);
  }
  try { localStorage.setItem('anemoTab', name); } catch (_) {}
  if (name === 'monitor') {
    initMonitorCharts();
    updateMonitor();
  }
}

function setPreviewK(value) {
  const k = parseFloat(value);
  state.monitor.previewK = isFinite(k) && k >= 0 ? k : 0;
  try { localStorage.setItem('anemoPreviewK', String(state.monitor.previewK)); } catch (_) {}
  if (state.activeTab === 'monitor') updateMonitor();
}

function setMonitorWindow(sec) {
  state.monitor.windowSec = sec;
  // re-trim
  const cutoff = performance.now() - sec * 1000;
  const samples = state.monitor.samples;
  let i = 0;
  while (i < samples.length && samples[i].t < cutoff) i++;
  if (i > 0) samples.splice(0, i);
  for (const btn of els.windowBtns) {
    btn.classList.toggle('active', Number(btn.dataset.win) === sec);
  }
  if (state.activeTab === 'monitor') updateMonitor();
}

// ---------- Push confirmation ----------

function fmtCoeff(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toFixed(digits);
}

function pctDelta(oldV, newV) {
  if (oldV == null || !isFinite(oldV) || Math.abs(oldV) < 1e-9) return '';
  const d = ((newV - oldV) / oldV) * 100;
  const sign = d >= 0 ? '+' : '−';
  return `  (${sign}${Math.abs(d).toFixed(d >= 100 ? 0 : 1)}%)`;
}

// Show the modal and resolve true on confirm, false otherwise.
function confirmPush(payload) {
  return new Promise((resolve) => {
    const dlg = els.confirmDialog;
    if (!dlg || typeof dlg.showModal !== 'function') {
      // Fallback: native confirm.
      const ok = window.confirm(`Push k=${fmtCoeff(payload.k, 4)}, b=${fmtCoeff(payload.b, 3)} to device?`);
      resolve(ok);
      return;
    }
    const cur = state.deviceConfig || {};
    const newK = payload.k;
    const newB = payload.b;
    const lines = [];
    if (newK != null) {
      lines.push(`  k:  ${fmtCoeff(cur.k, 4)}  →  ${fmtCoeff(newK, 4)}${pctDelta(cur.k, newK)}`);
    }
    if (newB != null) {
      lines.push(`  b:  ${fmtCoeff(cur.b, 3)}  →  ${fmtCoeff(newB, 3)}`);
    }
    els.confirmBody.textContent = lines.join('\n');

    const onCancel = () => { cleanup(); resolve(false); };
    const onOk = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    function cleanup() {
      els.confirmCancel.removeEventListener('click', onCancel);
      els.confirmOk.removeEventListener('click', onOk);
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
    }
    els.confirmCancel.addEventListener('click', onCancel);
    els.confirmOk.addEventListener('click', onOk);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

async function confirmAndPush(payload) {
  if (!state.bleConfigChar) {
    showError('BLE not connected');
    return;
  }
  const ok = await confirmPush(payload);
  if (!ok) return;
  await pushConfig(payload);
  buzz(15);
  showToast('Pushed to device', 'success');
}

// ---------- Wire up ----------
els.connect.addEventListener('click', bleConnect);
els.disconnect.addEventListener('click', bleDisconnect);
els.gps.addEventListener('click', gpsStart);
els.sessionStart.addEventListener('click', sessionStart);
els.sessionStop.addEventListener('click', sessionStop);
els.exportJson.addEventListener('click', exportAllJson);
els.exportCsv.addEventListener('click', exportSelectedCsv);

els.pushFit1.addEventListener('click', () => {
  if (state.lastFit && state.lastFit.noOff) {
    confirmAndPush({ k: round4(state.lastFit.noOff.k), b: 0 });
  }
});
els.pushFit2.addEventListener('click', () => {
  if (state.lastFit && state.lastFit.withOff) {
    confirmAndPush({
      k: round4(state.lastFit.withOff.k),
      b: round4(state.lastFit.withOff.b),
    });
  }
});
for (const btn of els.unitBtns) {
  btn.addEventListener('click', () => pushConfig({ unit: btn.dataset.unit }));
}
els.pushManual.addEventListener('click', pushManual);

for (const btn of els.tabBtns) {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
}
for (const btn of els.windowBtns) {
  btn.addEventListener('click', () => setMonitorWindow(Number(btn.dataset.win)));
}
els.monPreviewK.addEventListener('input', (e) => setPreviewK(e.target.value));

for (const btn of els.manUnitBtns) {
  btn.addEventListener('click', () => setManualEntryUnit(btn.dataset.unit));
}
els.manPairAdd.addEventListener('click', addManualPair);
els.manPairHz.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.manPairV.focus(); });
els.manPairV.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualPair(); });
els.manPushFit1.addEventListener('click', () => {
  if (state.lastManualFit && state.lastManualFit.noOff) {
    confirmAndPush({ k: round4(state.lastManualFit.noOff.k), b: 0 });
  }
});
els.manPushFit2.addEventListener('click', () => {
  if (state.lastManualFit && state.lastManualFit.withOff) {
    confirmAndPush({
      k: round4(state.lastManualFit.withOff.k),
      b: round4(state.lastManualFit.withOff.b),
    });
  }
});

function round4(x) { return Math.round(x * 10000) / 10000; }

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW reg failed', err));
  });
}

// ---------- Footer (version + force refresh) ----------
{
  const ver = $('app-version');
  if (ver) ver.textContent = APP_VERSION;
  const btn = $('app-refresh');
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
      } finally {
        location.reload();
      }
    });
  }
}

// ---------- Boot ----------
{
  let saved = 'monitor';
  try { saved = localStorage.getItem('anemoTab') || 'monitor'; } catch (_) {}
  setActiveTab(saved);
  setMonitorWindow(state.monitor.windowSec);
  setManualEntryUnit(state.manualEntryUnit);
  loadManualPairs();
  renderManualPanel();

  // restore preview k
  let savedK = '';
  try { savedK = localStorage.getItem('anemoPreviewK') || ''; } catch (_) {}
  if (savedK) {
    els.monPreviewK.value = savedK;
    setPreviewK(savedK);
  }

  // BLE button label reflects the last paired device, if any.
  const lastName = loadLastBleName();
  if (lastName) els.connect.textContent = `Reconnect to ${lastName}`;
}
refreshSessions().then(rerenderFitAndChart);
