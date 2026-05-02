'use strict';

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
  error: $('error'),

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
  windowBtns: Array.from(document.querySelectorAll('.window-btn')),
};

function showError(msg) {
  els.error.textContent = msg || '';
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
  },
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
async function bleConnect() {
  showError('');
  if (!navigator.bluetooth) {
    showError('Web Bluetooth не поддерживается в этом браузере.');
    return;
  }
  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    });
    state.bleDevice = dev;
    dev.addEventListener('gattserverdisconnected', onBleDisconnected);
    setBleState('connecting');
    const srv = await dev.gatt.connect();
    const svc = await srv.getPrimaryService(BLE_SERVICE_UUID);
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

    state.bleConnected = true;
    setBleState('connected: ' + (dev.name || dev.id));
    els.connect.disabled = true;
    els.disconnect.disabled = false;
    setDeviceControlsEnabled(true);
  } catch (e) {
    showError('BLE: ' + e.message);
    setBleState('disconnected');
  }
}

function bleDisconnect() {
  if (state.bleDevice && state.bleDevice.gatt.connected) {
    state.bleDevice.gatt.disconnect();
  }
  onBleDisconnected();
}

function onBleDisconnected() {
  state.bleConnected = false;
  state.bleChar = null;
  state.bleConfigChar = null;
  state.deviceConfig = { k: null, b: null, unit: null };
  setBleState('disconnected');
  els.connect.disabled = false;
  els.disconnect.disabled = true;
  setDeviceControlsEnabled(false);
  renderDeviceReadout();
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
  showError('');
  await pushConfig(payload);
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
}

async function sessionStop() {
  if (!state.currentSession) return;
  state.currentSession.endedAt = Date.now();
  const id = await dbAddSession(state.currentSession);
  state.currentSession = null;
  els.sessionStart.disabled = false;
  els.sessionStop.disabled = true;
  els.sessionInfo.textContent = `saved (id ${id})`;
  els.sessionName.value = '';
  await refreshSessions();
  state.selectedSessionIds.add(id);
  rerenderFitAndChart();
}

// ---------- Sessions list ----------
async function refreshSessions() {
  state.sessions = await dbAllSessions();
  if (!state.sessions.length) {
    els.sessionsList.innerHTML = '<div class="status">no recordings yet</div>';
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
    els.fitEmpty.textContent = 'Select sessions below (or record one) to compute fit.';
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
  els.monWindUnit.textContent = `(${unitLabel})`;
  els.monWindTitle.textContent = `Wind (${unitLabel})`;
  // chart Y axis title
  if (chartWind) {
    chartWind.options.scales.y.title.text = unitLabel;
  }

  if (!samples.length) {
    setText(els.monWindMin, '—'); setText(els.monWindAvg, '—'); setText(els.monWindMax, '—');
    setText(els.monHzMin,   '—'); setText(els.monHzAvg,   '—'); setText(els.monHzMax,   '—');
    if (chartWind) { chartWind.data.datasets[0].data = []; chartWind.update('none'); }
    if (chartHz)   { chartHz.data.datasets[0].data = [];   chartHz.update('none'); }
    return;
  }

  // Stats
  let hzMin = Infinity, hzMax = -Infinity, hzSum = 0;
  let vMin = Infinity, vMax = -Infinity, vSum = 0;
  for (const s of samples) {
    if (s.hz < hzMin) hzMin = s.hz;
    if (s.hz > hzMax) hzMax = s.hz;
    hzSum += s.hz;
    const v = mpsTo(u, s.vMps);
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    vSum += v;
  }
  const n = samples.length;
  setText(els.monHzMin, hzMin.toFixed(1));
  setText(els.monHzAvg, (hzSum / n).toFixed(1));
  setText(els.monHzMax, hzMax.toFixed(1));
  setText(els.monWindMin, vMin.toFixed(1));
  setText(els.monWindAvg, (vSum / n).toFixed(1));
  setText(els.monWindMax, vMax.toFixed(1));

  // Charts: x = relative seconds (negative = older)
  const now = performance.now();
  const windData = samples.map(s => ({ x: (s.t - now) / 1000, y: mpsTo(u, s.vMps) }));
  const hzData   = samples.map(s => ({ x: (s.t - now) / 1000, y: s.hz }));
  if (chartWind) {
    chartWind.data.datasets[0].data = windData;
    chartWind.options.scales.x.min = -state.monitor.windowSec;
    chartWind.options.scales.x.max = 0;
    chartWind.update('none');
  }
  if (chartHz) {
    chartHz.data.datasets[0].data = hzData;
    chartHz.options.scales.x.min = -state.monitor.windowSec;
    chartHz.options.scales.x.max = 0;
    chartHz.update('none');
  }
}

function setText(el, t) { if (el) el.textContent = t; }

function setActiveTab(name) {
  if (!els.views[name]) name = 'monitor';
  state.activeTab = name;
  for (const btn of els.tabBtns) {
    btn.classList.toggle('active', btn.dataset.tab === name);
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
    pushConfig({ k: round4(state.lastFit.noOff.k), b: 0 });
  }
});
els.pushFit2.addEventListener('click', () => {
  if (state.lastFit && state.lastFit.withOff) {
    pushConfig({
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

function round4(x) { return Math.round(x * 10000) / 10000; }

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW reg failed', err));
  });
}

// ---------- Boot ----------
{
  let saved = 'monitor';
  try { saved = localStorage.getItem('anemoTab') || 'monitor'; } catch (_) {}
  setActiveTab(saved);
  setMonitorWindow(state.monitor.windowSec);
}
refreshSessions().then(rerenderFitAndChart);
