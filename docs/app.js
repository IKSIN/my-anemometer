'use strict';

// BLE GATT identifiers — must match the firmware in src/main.cpp.
const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_TELEMETRY_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

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
};

function showError(msg) {
  els.error.textContent = msg || '';
}

// ---------- State ----------
const state = {
  bleDevice: null,
  bleChar: null,
  bleConnected: false,

  gpsWatchId: null,
  gpsLatest: { speed: null, accuracy: null, ts: 0 }, // m/s

  hzLatest: null,
  rpmLatest: null,
  msLatest: 0,

  currentSession: null,             // { name, startedAt, samples: [] }
  selectedSessionIds: new Set(),    // for fit/chart
  sessions: [],                     // in-memory mirror of IDB
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
    state.bleConnected = true;
    setBleState('connected: ' + (dev.name || dev.id));
    els.connect.disabled = true;
    els.disconnect.disabled = false;
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
  setBleState('disconnected');
  els.connect.disabled = false;
  els.disconnect.disabled = true;
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
  } else {
    els.fitEmpty.style.display = 'none';
    els.fitTable.hidden = false;
    els.fit1k.textContent = noOff.k.toFixed(4);
    els.fit1r.textContent = r1.toFixed(3);
    els.fit2k.textContent = withOff.k.toFixed(4);
    els.fit2b.textContent = withOff.b.toFixed(3);
    els.fit2r.textContent = r2.toFixed(3);
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

// ---------- Wire up ----------
els.connect.addEventListener('click', bleConnect);
els.disconnect.addEventListener('click', bleDisconnect);
els.gps.addEventListener('click', gpsStart);
els.sessionStart.addEventListener('click', sessionStart);
els.sessionStop.addEventListener('click', sessionStop);
els.exportJson.addEventListener('click', exportAllJson);
els.exportCsv.addEventListener('click', exportSelectedCsv);

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW reg failed', err));
  });
}

// ---------- Boot ----------
refreshSessions().then(rerenderFitAndChart);
