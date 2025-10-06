// Config
const API_URL = 'https://api.collectapi.com/gasPrice/allUsaPrice';
// Optional static key (for quick local testing). You can also set via UI field (stored in localStorage).
const API_KEY = 'KEY';

// GeoJSON US states
const US_STATES_GEOJSON =
  'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';

// Fuel field mapping (CollectAPI variants)
const FUEL_FIELDS = {
  regular: ['regular', 'gasoline'],
  midgrade: ['midgrade', 'midGrade', 'mid'],
  premium: ['premium'],
  diesel: ['diesel'],
};

const GALLON_TO_LITER = 3.785411784;

let map, statesLayer;
let priceByState = {}; // { normalizedState: { regular, midgrade, premium, diesel, raw: item } }
let layerByState = {}; // normalizedState -> Leaflet layer
let geojsonStates = []; // array of state names (for datalist)
let currentDataTimestamp = null; // Date or null

const ui = {};

const appState = {
  fuel: 'regular',
  unit: 'gal', // 'gal' | 'L'
  scale: 'continuous', // 'continuous' | 'quantiles'
  highlightMode: 'none', // 'none' | 'cheapest' | 'expensive'
  highlightCount: 5,
  autoRefresh: false,
  refreshMinutes: 30,
  sortBy: 'state', // table sort
  sortDir: 'asc',
  filter: '',
};

// ---------- Utils ----------
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\.\,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(val) {
  if (val == null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const num = String(val).replace(/[$,]/g, '').trim();
  const f = parseFloat(num);
  return Number.isFinite(f) ? f : null;
}

function extractFuelPrice(obj, fuelKey) {
  const keys = FUEL_FIELDS[fuelKey] || [];
  for (const k of keys) {
    if (k in obj) {
      const p = parsePrice(obj[k]);
      if (p != null) return p;
    }
    const hit = Object.keys(obj).find(kk => kk.toLowerCase() === k.toLowerCase());
    if (hit) {
      const p = parsePrice(obj[hit]);
      if (p != null) return p;
    }
  }
  return null;
}

function convertUnit(value, unit) {
  if (value == null) return null;
  if (unit === 'L') return value / GALLON_TO_LITER;
  return value; // gal
}

function fmtPrice(value, unit) {
  if (value == null || !Number.isFinite(value)) return '—';
  const v = value;
  return `$${v.toFixed(2)} ${unit}`;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

// ---------- Colors & Legend ----------
function priceColor(value, min, max) {
  if (value == null || !Number.isFinite(value)) return '#6b7280'; // gray
  const t = Math.max(0, Math.min(1, (value - min) / Math.max(1e-9, max - min)));
  const hue = 120 * (1 - t); // green->red
  return `hsl(${hue}, 80%, 50%)`;
}

function makeQuantileColors(values, buckets = 5) {
  const sorted = values.slice().sort((a, b) => a - b);
  const qs = [];
  for (let i = 1; i < buckets; i++) {
    qs.push(percentile(sorted, i / buckets));
  }
  return {
    thresholds: qs, // size buckets-1
    colorFor: (v) => {
      if (v == null || !Number.isFinite(v)) return '#6b7280';
      const idx = qs.findIndex(th => v <= th);
      const bin = idx === -1 ? qs.length : idx;
      // map bin 0..4 -> hue from green to red
      const t = bin / (buckets - 1);
      const hue = 120 * (1 - t);
      return `hsl(${hue}, 80%, 50%)`;
    }
  };
}

function updateLegendContinuous(min, max) {
  const legendScale = document.getElementById('legendScale');
  legendScale.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'legend-bar';
  legendScale.appendChild(bar);

  const ticks = document.createElement('div');
  ticks.className = 'legend-ticks';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = min + (i * (max - min)) / steps;
    const tick = document.createElement('span');
    tick.textContent = `$${v.toFixed(2)}`;
    ticks.appendChild(tick);
  }
  legendScale.appendChild(ticks);
}

function updateLegendQuantiles(values, unit) {
  const legendScale = document.getElementById('legendScale');
  legendScale.innerHTML = '';

  const buckets = 5;
  const sorted = values.slice().sort((a,b)=>a-b);
  const thresholds = [];
  for (let i = 1; i < buckets; i++) thresholds.push(percentile(sorted, i/buckets));

  const boxes = document.createElement('div');
  boxes.className = 'legend-quantiles';
  for (let i = 0; i < buckets; i++) {
    const t = i / (buckets - 1);
    const hue = 120 * (1 - t);
    const box = document.createElement('div');
    box.className = 'legend-box';
    box.style.background = `hsl(${hue}, 80%, 50%)`;
    boxes.appendChild(box);
  }
  legendScale.appendChild(boxes);

  const labels = document.createElement('div');
  labels.className = 'legend-ticks';
  const lows = sorted[0];
  const highs = sorted[sorted.length - 1];
  const labelMin = document.createElement('span');
  labelMin.textContent = `$${lows?.toFixed(2) ?? '—'}`;
  const labelQ2 = document.createElement('span');
  labelQ2.textContent = `$${(thresholds[1] ?? lows)?.toFixed(2)}`;
  const labelQ4 = document.createElement('span');
  labelQ4.textContent = `$${(thresholds[3] ?? highs)?.toFixed(2)}`;
  const labelMax = document.createElement('span');
  labelMax.textContent = `$${highs?.toFixed(2) ?? '—'}`;

  labels.appendChild(labelMin);
  labels.appendChild(labelQ2);
  labels.appendChild(labelQ4);
  labels.appendChild(labelMax);
  legendScale.appendChild(labels);

  // Unit tag
  document.getElementById('legendUnit').textContent = `USD/${unit}`;
}

// ---------- Info control ----------
function makeInfoControl() {
  const info = L.control({ position: 'topright' });
  info.onAdd = function () {
    this._div = L.DomUtil.create('div', 'info-control');
    this.update();
    return this._div;
  };
  info.update = function (props) {
    if (!props) {
      this._div.innerHTML = '<div class="info-title">Hover over a state</div><div class="info-muted">See price details</div>';
      return;
    }
    const state = props.name;
    const normalized = normName(state);
    const prices = priceByState[normalized];
    const reg = prices?.regular ?? null;
    const mid = prices?.midgrade ?? null;
    const prem = prices?.premium ?? null;
    const dis = prices?.diesel ?? null;

    this._div.innerHTML = `
      <div class="info-title">${state}</div>
      <div class="info-muted">Prices (USD/${appState.unit})</div>
      <div>Regular: <strong>${fmtPrice(convertUnit(reg, appState.unit), appState.unit)}</strong></div>
      <div>Midgrade: <strong>${fmtPrice(convertUnit(mid, appState.unit), appState.unit)}</strong></div>
      <div>Premium: <strong>${fmtPrice(convertUnit(prem, appState.unit), appState.unit)}</strong></div>
      <div>Diesel: <strong>${fmtPrice(convertUnit(dis, appState.unit), appState.unit)}</strong></div>
    `;
  };
  return info;
}
const infoControl = makeInfoControl();

// ---------- Toast ----------
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}

// ---------- Map ----------
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 12,
    worldCopyJump: true,
  }).setView([39.5, -98.35], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    crossOrigin: true,
  }).addTo(map);

  infoControl.addTo(map);

  // Resize fix
  window.addEventListener('resize', () => {
    clearTimeout(initMap._t);
    initMap._t = setTimeout(() => map.invalidateSize(), 120);
  });
}

function getHighlightSets(valuesMap) {
  // returns { cheapest: Set, expensive: Set } based on current fuel
  const entries = Object.entries(valuesMap)
    .filter(([_, v]) => Number.isFinite(v))
    .sort((a, b) => a[1] - b[1]);
  const n = Math.max(1, Math.min(appState.highlightCount, entries.length));
  const cheapest = new Set(entries.slice(0, n).map(e => e[0]));
  const expensive = new Set(entries.slice(-n).map(e => e[0]));
  return { cheapest, expensive };
}

function restyleStates() {
  if (!statesLayer) return;

  // Collect values for selected fuel in selected unit
  const values = [];
  const valueMap = {};
  for (const [st, obj] of Object.entries(priceByState)) {
    const v = obj?.[appState.fuel] ?? null;
    const conv = convertUnit(v, appState.unit);
    if (conv != null && Number.isFinite(conv)) {
      values.push(conv);
      valueMap[st] = conv;
    }
  }

  let min = values.length ? Math.min(...values) : 2.5;
  let max = values.length ? Math.max(...values) : 6.0;
  let quant = null;
  if (appState.scale === 'quantiles' && values.length) {
    quant = makeQuantileColors(values, 5);
  }

  const { cheapest, expensive } = getHighlightSets(valueMap);

  statesLayer.setStyle(feature => {
    const stateName = feature?.properties?.name || '';
    const key = normName(stateName);
    const p = priceByState[key];
    const val = convertUnit(p?.[appState.fuel] ?? null, appState.unit);

    const baseStyle = {
      fillColor: quant ? quant.colorFor(val) : priceColor(val, min, max),
      weight: 1,
      opacity: 1,
      color: 'rgba(255,255,255,0.08)',
      fillOpacity: 0.78,
    };

    if (appState.highlightMode === 'cheapest' && cheapest.has(key)) {
      baseStyle.weight = 2.5;
      baseStyle.color = '#22c55e';
    } else if (appState.highlightMode === 'expensive' && expensive.has(key)) {
      baseStyle.weight = 2.5;
      baseStyle.color = '#ef4444';
    }
    return baseStyle;
  });

  // Legend
  document.getElementById('legendUnit').textContent = `USD/${appState.unit}`;
  if (appState.scale === 'quantiles') {
    updateLegendQuantiles(values, appState.unit);
  } else {
    updateLegendContinuous(min, max);
  }

  renderSummary(values);
  renderTable();
}

// ---------- GeoJSON layer ----------
async function loadMapLayer() {
  const res = await fetch(US_STATES_GEOJSON);
  if (!res.ok) throw new Error(`Failed to fetch US states GeoJSON: ${res.status}`);
  const geojson = await res.json();

  statesLayer = L.geoJSON(geojson, {
    style: { color: 'rgba(255,255,255,0.08)', weight: 1, fillOpacity: 0.78 },
    onEachFeature: (feature, layer) => {
      const name = feature?.properties?.name || '';
      const key = normName(name);
      layerByState[key] = layer;

      layer.on({
        mouseover: (e) => {
          const l = e.target;
          l.setStyle({ weight: 2, color: '#a78bfa' });
          infoControl.update(feature.properties);
        },
        mouseout: (e) => {
          statesLayer.resetStyle(e.target);
          infoControl.update();
          restyleStates(); // re-apply highlights
        },
        click: () => {
          const data = priceByState[key];
          const reg = data?.regular, mid = data?.midgrade, prem = data?.premium, dis = data?.diesel;
          const center = layer.getBounds().getCenter();
          const html = `
            <div style="min-width:200px">
              <strong>${name}</strong><br/>
              <span style="color:#9fb0c5;font-size:12px">USD/${appState.unit}</span>
              <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:6px 0"/>
              Regular: <strong>${fmtPrice(convertUnit(reg, appState.unit), appState.unit)}</strong><br/>
              Midgrade: <strong>${fmtPrice(convertUnit(mid, appState.unit), appState.unit)}</strong><br/>
              Premium: <strong>${fmtPrice(convertUnit(prem, appState.unit), appState.unit)}</strong><br/>
              Diesel: <strong>${fmtPrice(convertUnit(dis, appState.unit), appState.unit)}</strong>
            </div>
          `;
          L.popup({ closeButton: true, autoPan: true })
            .setLatLng(center)
            .setContent(html)
            .openOn(map);
        }
      });
    }
  }).addTo(map);

  // Populate state datalist
  geojsonStates = Object.values(statesLayer._layers).map(l => l.feature?.properties?.name).filter(Boolean).sort();
  const dl = document.getElementById('stateList');
  dl.innerHTML = geojsonStates.map(s => `<option value="${s}">`).join('');

  setTimeout(() => map.invalidateSize(), 50);
}

// ---------- API fetch ----------
function getStoredApiKey() {
  return localStorage.getItem('gasmap_api_key') || '';
}
function saveStoredApiKey(key) {
  if (!key) return;
  localStorage.setItem('gasmap_api_key', key);
}
function clearStoredApiKey() {
  localStorage.removeItem('gasmap_api_key');
}

function getEffectiveApiKey() {
  return getStoredApiKey() || API_KEY || '';
}

async function fetchPrices() {
  const key = getEffectiveApiKey();
  if (!key) {
    throw new Error('Missing CollectAPI key. Paste your key and click Save.');
  }
  const res = await fetch(API_URL, {
    headers: {
      'content-type': 'application/json',
      'authorization': `apikey ${key}`,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API error (${res.status}): ${t || res.statusText}`);
  }
  const data = await res.json();

  const list = data?.result || data?.results || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('API did not return a list of states with prices.');
  }

  priceByState = {};
  for (const item of list) {
    const name = item.name || item.state || item.State || item.StateName;
    if (!name) continue;
    const keyName = normName(name);
    priceByState[keyName] = {
      regular: extractFuelPrice(item, 'regular'),
      midgrade: extractFuelPrice(item, 'midgrade'),
      premium: extractFuelPrice(item, 'premium'),
      diesel: extractFuelPrice(item, 'diesel'),
      raw: item,
    };
  }

  // Timestamp
  const possibleTs = data?.lastupdate || data?.updated || data?.date || data?.time || null;
  currentDataTimestamp = possibleTs ? new Date(possibleTs) : new Date();

  updateLastUpdated();
}

// ---------- Stats, Summary, Table ----------
function computeStatsForFuel(fuelKey) {
  const arr = [];
  for (const [st, obj] of Object.entries(priceByState)) {
    const val = obj?.[fuelKey];
    if (Number.isFinite(val)) arr.push({ st, val });
  }
  if (!arr.length) return null;

  const convVals = arr.map(o => convertUnit(o.val, appState.unit));
  const minVal = Math.min(...convVals);
  const maxVal = Math.max(...convVals);
  const avgVal = convVals.reduce((a,b)=>a+b,0) / convVals.length;

  const minStates = arr.filter(o => convertUnit(o.val, appState.unit) === minVal).map(o => o.st);
  const maxStates = arr.filter(o => convertUnit(o.val, appState.unit) === maxVal).map(o => o.st);

  // Ranks
  const sorted = arr.slice().sort((a,b)=>a.val - b.val);
  const rankMap = new Map(sorted.map((o, i) => [o.st, i+1]));

  return { minVal, maxVal, avgVal, minStates, maxStates, count: arr.length, rankMap };
}

function renderSummary(valuesInUnit) {
  const stats = computeStatsForFuel(appState.fuel);
  if (!stats) {
    document.getElementById('statMin').textContent = '—';
    document.getElementById('statAvg').textContent = '—';
    document.getElementById('statMax').textContent = '—';
    document.getElementById('statMinStates').textContent = '—';
    document.getElementById('statMaxStates').textContent = '—';
    document.getElementById('statCount').textContent = '—';
    return;
  }
  const unit = appState.unit;
  document.getElementById('statMin').textContent = `$${stats.minVal.toFixed(2)} ${unit}`;
  document.getElementById('statAvg').textContent = `$${stats.avgVal.toFixed(2)} ${unit}`;
  document.getElementById('statMax').textContent = `$${stats.maxVal.toFixed(2)} ${unit}`;
  document.getElementById('statMinStates').textContent = stats.minStates.map(deserializeState).join(', ');
  document.getElementById('statMaxStates').textContent = stats.maxStates.map(deserializeState).join(', ');
  document.getElementById('statCount').textContent = `${stats.count} states`;
}

function deserializeState(norm) {
  // Attempt to revive the display name from layer feature
  const layer = layerByState[norm];
  return layer?.feature?.properties?.name || norm;
}

function renderTable() {
  const tbody = document.querySelector('#stateTable tbody');
  const unit = appState.unit;
  const fuel = appState.fuel;
  const stats = computeStatsForFuel(fuel);
  if (!stats) {
    tbody.innerHTML = '';
    return;
  }
  const avg = stats.avgVal;

  // Build rows
  const rows = [];
  for (const [st, obj] of Object.entries(priceByState)) {
    const reg = convertUnit(obj?.regular, unit);
    const mid = convertUnit(obj?.midgrade, unit);
    const prem = convertUnit(obj?.premium, unit);
    const dis = convertUnit(obj?.diesel, unit);
    const current = convertUnit(obj?.[fuel], unit);
    if (appState.filter && !deserializeState(st).toLowerCase().includes(appState.filter.toLowerCase())) {
      continue;
    }
    const delta = (current != null && Number.isFinite(current)) ? (current - avg) : null;
    const rank = stats.rankMap.get(st) || null;
    rows.push({
      st, name: deserializeState(st),
      regular: reg, midgrade: mid, premium: prem, diesel: dis,
      delta, rank
    });
  }

  // Sort
  const sb = appState.sortBy, sd = appState.sortDir;
  rows.sort((a, b) => {
    const va = a[sb], vb = b[sb];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return sd === 'asc' ? va - vb : vb - va;
  });

  // Render
  tbody.innerHTML = rows.map(r => {
    const badge = (() => {
      if (appState.highlightMode === 'cheapest') {
        return stats.rankMap.get(r.st) <= appState.highlightCount
          ? '<span class="badge badge-green">Top cheap</span>' : '';
      } else if (appState.highlightMode === 'expensive') {
        const rank = stats.rankMap.get(r.st);
        const n = appState.highlightCount;
        return rank >= (stats.count - n + 1) ? '<span class="badge badge-red">Top pricey</span>' : '';
      }
      return '';
    })();
    return `<tr>
      <td>${r.name} ${badge}</td>
      <td>${fmtPrice(r.regular, unit)}</td>
      <td>${fmtPrice(r.midgrade, unit)}</td>
      <td>${fmtPrice(r.premium, unit)}</td>
      <td>${fmtPrice(r.diesel, unit)}</td>
      <td>${r.delta==null?'—':(r.delta>=0?'+':'') + '$' + r.delta.toFixed(2)}</td>
      <td>${r.rank ?? '—'}</td>
    </tr>`;
  }).join('');
}

// ---------- Last updated ----------
function updateLastUpdated() {
  const el = document.getElementById('lastUpdated');
  if (!el) return;
  if (!currentDataTimestamp) {
    el.textContent = '';
    return;
  }
  const d = currentDataTimestamp;
  const iso = d instanceof Date && !isNaN(d) ? d.toLocaleString() : String(d);
  el.textContent = `Last updated: ${iso}`;
}

// ---------- Export ----------
function exportJSON() {
  const unit = appState.unit;
  const out = Object.entries(priceByState).map(([st, obj]) => ({
    state: deserializeState(st),
    regular: convertUnit(obj.regular, unit),
    midgrade: convertUnit(obj.midgrade, unit),
    premium: convertUnit(obj.premium, unit),
    diesel: convertUnit(obj.diesel, unit),
  }));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `us-gas-prices-${unit}.json`);
}

function exportCSV() {
  const unit = appState.unit;
  const header = ['State','Regular','Midgrade','Premium','Diesel'].join(',');
  const lines = [header];
  for (const [st, obj] of Object.entries(priceByState)) {
    const row = [
      `"${deserializeState(st)}"`,
      toCsvNum(convertUnit(obj.regular, unit)),
      toCsvNum(convertUnit(obj.midgrade, unit)),
      toCsvNum(convertUnit(obj.premium, unit)),
      toCsvNum(convertUnit(obj.diesel, unit)),
    ].join(',');
    lines.push(row);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `us-gas-prices-${unit}.csv`);
}
function toCsvNum(v) { return v==null ? '' : v.toFixed(3); }
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// ---------- Search ----------
function findStateLayerByName(input) {
  if (!input) return null;
  // Try exact case-insensitive
  const key = normName(input);
  if (layerByState[key]) return layerByState[key];

  // Try best match by startsWith
  const hit = Object.keys(layerByState).find(k => k.startsWith(key));
  return hit ? layerByState[hit] : null;
}

function zoomToState(name) {
  const layer = findStateLayerByName(name);
  if (!layer) {
    showToast('State not found');
    return;
  }
  map.fitBounds(layer.getBounds(), { padding: [20,20] });
  layer.fire('click');
}

// ---------- URL hash (permalink) ----------
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('fuel')) appState.fuel = h.get('fuel');
  if (h.get('unit')) appState.unit = h.get('unit');
  if (h.get('scale')) appState.scale = h.get('scale');
  if (h.get('highlightMode')) appState.highlightMode = h.get('highlightMode');
  if (h.get('highlightCount')) appState.highlightCount = Math.max(1, Math.min(25, parseInt(h.get('highlightCount'),10) || appState.highlightCount));
  if (h.get('sortBy')) appState.sortBy = h.get('sortBy');
  if (h.get('sortDir')) appState.sortDir = h.get('sortDir');
  if (h.get('filter')) appState.filter = h.get('filter');
}
function writeHash() {
  const h = new URLSearchParams();
  h.set('fuel', appState.fuel);
  h.set('unit', appState.unit);
  h.set('scale', appState.scale);
  h.set('highlightMode', appState.highlightMode);
  h.set('highlightCount', String(appState.highlightCount));
  h.set('sortBy', appState.sortBy);
  h.set('sortDir', appState.sortDir);
  if (appState.filter) h.set('filter', appState.filter);
  const newHash = '#' + h.toString();
  if (location.hash !== newHash) history.replaceState(null, '', newHash);
}

// ---------- UI bindings ----------
let refreshTimer = null;

function bindUI() {
  ui.fuelType = document.getElementById('fuelType');
  ui.unitSelect = document.getElementById('unitSelect');
  ui.scaleSelect = document.getElementById('scaleSelect');
  ui.highlightMode = document.getElementById('highlightMode');
  ui.highlightCount = document.getElementById('highlightCount');
  ui.searchState = document.getElementById('searchState');
  ui.btnSearch = document.getElementById('btnSearch');
  ui.btnResetView = document.getElementById('btnResetView');
  ui.btnRefresh = document.getElementById('btnRefresh');
  ui.autoRefreshChk = document.getElementById('autoRefreshChk');
  ui.refreshMinutes = document.getElementById('refreshMinutes');
  ui.btnExportJSON = document.getElementById('btnExportJSON');
  ui.btnExportCSV = document.getElementById('btnExportCSV');
  ui.tableFilter = document.getElementById('tableFilter');
  ui.apiKeyInput = document.getElementById('apiKeyInput');
  ui.btnSaveKey = document.getElementById('btnSaveKey');
  ui.btnClearKey = document.getElementById('btnClearKey');

  // Initialize from appState
  ui.fuelType.value = appState.fuel;
  ui.unitSelect.value = appState.unit;
  ui.scaleSelect.value = appState.scale;
  ui.highlightMode.value = appState.highlightMode;
  ui.highlightCount.value = String(appState.highlightCount);
  ui.autoRefreshChk.checked = appState.autoRefresh;
  ui.refreshMinutes.value = String(appState.refreshMinutes);
  ui.tableFilter.value = appState.filter;
  ui.apiKeyInput.value = getStoredApiKey();

  ui.fuelType.addEventListener('change', () => {
    appState.fuel = ui.fuelType.value; writeHash(); restyleStates();
  });
  ui.unitSelect.addEventListener('change', () => {
    appState.unit = ui.unitSelect.value; writeHash(); restyleStates();
  });
  ui.scaleSelect.addEventListener('change', () => {
    appState.scale = ui.scaleSelect.value; writeHash(); restyleStates();
  });
  ui.highlightMode.addEventListener('change', () => {
    appState.highlightMode = ui.highlightMode.value; writeHash(); restyleStates();
  });
  ui.highlightCount.addEventListener('change', () => {
    appState.highlightCount = Math.max(1, Math.min(25, parseInt(ui.highlightCount.value, 10) || 5));
    ui.highlightCount.value = String(appState.highlightCount);
    writeHash(); restyleStates();
  });
  ui.btnSearch.addEventListener('click', () => zoomToState(ui.searchState.value));
  ui.searchState.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') zoomToState(ui.searchState.value);
  });
  ui.btnResetView.addEventListener('click', () => map.setView([39.5, -98.35], 4));

  ui.btnRefresh.addEventListener('click', async () => {
    try {
      await fetchPrices();
      restyleStates();
    } catch (e) { console.error(e); showToast(e.message || 'Fetch failed'); }
  });

  ui.autoRefreshChk.addEventListener('change', () => {
    appState.autoRefresh = ui.autoRefreshChk.checked;
    writeHash();
    setupAutoRefresh();
  });
  ui.refreshMinutes.addEventListener('change', () => {
    const v = parseInt(ui.refreshMinutes.value, 10);
    appState.refreshMinutes = Math.max(10, Math.min(180, isNaN(v) ? 30 : v));
    ui.refreshMinutes.value = String(appState.refreshMinutes);
    writeHash();
    setupAutoRefresh();
  });

  ui.btnExportJSON.addEventListener('click', exportJSON);
  ui.btnExportCSV.addEventListener('click', exportCSV);

  ui.tableFilter.addEventListener('input', () => {
    appState.filter = ui.tableFilter.value;
    writeHash();
    renderTable();
  });

  // Table sorting
  document.querySelectorAll('#stateTable thead th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (!key) return;
      if (appState.sortBy === key) {
        appState.sortDir = appState.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        appState.sortBy = key;
        appState.sortDir = key === 'state' ? 'asc' : 'desc';
      }
      writeHash();
      renderTable();
    });
  });

  // API key persistence
  ui.btnSaveKey.addEventListener('click', () => {
    const v = ui.apiKeyInput.value.trim();
    if (!v) { showToast('Paste a valid apikey first.'); return; }
    saveStoredApiKey(v);
    showToast('API key saved locally.');
  });
  ui.btnClearKey.addEventListener('click', () => {
    clearStoredApiKey();
    ui.apiKeyInput.value = '';
    showToast('API key cleared from this browser.');
  });
}

function setupAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (appState.autoRefresh) {
    const ms = Math.max(10, appState.refreshMinutes) * 60 * 1000;
    refreshTimer = setInterval(async () => {
      try {
        await fetchPrices();
        restyleStates();
      } catch (e) { console.error(e); }
    }, ms);
  }
}

// ---------- Start ----------
(async function main() {
  try {
    readHash();
    initMap();
    bindUI();
    await loadMapLayer();
    await fetchPrices();
    restyleStates();
    setupAutoRefresh();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'An unexpected error occurred.');
  }
})();
