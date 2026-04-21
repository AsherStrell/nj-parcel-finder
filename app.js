const ALLOWED_EMAILS = ['joeribner@gmail.com', 'asherstrell04@gmail.com'];
const AUTH_STORAGE_KEY = 'nj-parcel-user';

(function setupAuth() {
  const gate = document.getElementById('auth-gate');
  const form = document.getElementById('auth-form');
  const input = document.getElementById('auth-email');
  const errorEl = document.getElementById('auth-error');
  const userEl = document.getElementById('current-user');
  const logoutBtn = document.getElementById('btn-logout');

  const saved = (localStorage.getItem(AUTH_STORAGE_KEY) || '').toLowerCase().trim();
  if (ALLOWED_EMAILS.includes(saved)) {
    gate.classList.add('hidden');
    userEl.textContent = saved;
  } else {
    setTimeout(() => input.focus(), 50);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = input.value.toLowerCase().trim();
    if (!ALLOWED_EMAILS.includes(email)) {
      errorEl.textContent = 'This email is not authorized.';
      errorEl.classList.remove('hidden');
      return;
    }
    errorEl.classList.add('hidden');
    localStorage.setItem(AUTH_STORAGE_KEY, email);
    userEl.textContent = email;
    gate.classList.add('hidden');
  });

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    input.value = '';
    userEl.textContent = '';
    errorEl.classList.add('hidden');
    gate.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
  });
})();

const SERVICE_URL = 'https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0/query';
const PAGE_SIZE = 1000;
const MAX_ROWS = 10000;

const COLUMNS = [
  { key: 'STATUS',      label: 'Status',            compute: r => isOutOfState(r.CITY_STATE) ? 'Out of State' : 'In State' },
  { key: 'OWNER_NAME',  label: 'Owner Name' },
  { key: 'ST_ADDRESS',  label: 'Owner Address' },
  { key: 'CITY_STATE',  label: 'Owner City/State' },
  { key: 'ZIP_CODE',    label: 'Owner Zip' },
  { key: 'PROP_LOC',    label: 'Property Address' },
  { key: 'MUN_NAME',    label: 'Municipality' },
  { key: 'COUNTY',      label: 'County' },
  { key: 'PCLBLOCK',    label: 'Block' },
  { key: 'PCLLOT',      label: 'Lot' }
];
const SERVICE_FIELDS = ['PAMS_PIN', ...COLUMNS.filter(c => !c.compute).map(c => c.key)];
const PINS_STORAGE_KEY = 'nj-parcel-pins';

function isOutOfState(cityState) {
  if (!cityState) return true;
  return !/\sNJ\s*$/.test(cityState);
}

function cellValue(row, col) {
  return col.compute ? col.compute(row) : (row[col.key] ?? '');
}

const map = L.map('map').setView([40.0583, -74.4057], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  draw: {
    rectangle: { shapeOptions: { color: '#007aff', weight: 2 } },
    polygon: false, polyline: false, circle: false, marker: false, circlemarker: false
  },
  edit: { featureGroup: drawnItems, edit: false, remove: false }
});
map.addControl(drawControl);

const statusEl = document.getElementById('status');
const tbody = document.querySelector('#results-table tbody');
const theadRow = document.querySelector('#results-table thead tr');
const btnCsv = document.getElementById('btn-csv');
const btnClear = document.getElementById('btn-clear');
const filterOos = document.getElementById('filter-oos');
const filterDiff = document.getElementById('filter-diff');
const pinsListEl = document.getElementById('pins-list');
const pinsCountEl = document.getElementById('pins-count');

const pins = new Map();
loadPins();
renderPinsList();
buildHeader();

let currentRows = [];
let activeController = null;

map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  runQuery(e.layer.getBounds());
});

btnClear.addEventListener('click', () => {
  if (activeController) activeController.abort();
  drawnItems.clearLayers();
  currentRows = [];
  renderRows([]);
  setStatus('');
  btnCsv.disabled = true;
  btnClear.disabled = true;
});

btnCsv.addEventListener('click', () => downloadCsv(currentRows));

tbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.pin) return;
  const id = tr.dataset.pin;
  if (pins.has(id)) {
    unpin(id);
  } else {
    const row = currentRows.find(r => r.PAMS_PIN === id);
    if (row) pinRow(row);
  }
});

theadRow.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const idx = Array.from(theadRow.children).indexOf(th);
  const dir = th.classList.contains('sort-asc') ? 'desc' : 'asc';
  sortRows(idx, dir);
  renderRows(currentRows, { sortedIdx: idx, sortedDir: dir });
});

function buildHeader() {
  theadRow.replaceChildren();
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    theadRow.appendChild(th);
  }
}

function sortRows(idx, dir) {
  const col = COLUMNS[idx];
  currentRows.sort((a, b) => {
    const va = cellValue(a, col).toString();
    const vb = cellValue(b, col).toString();
    return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });
}

function buildWhere() {
  const clauses = [];
  if (filterOos.checked)  clauses.push("CITY_STATE NOT LIKE '% NJ'");
  if (filterDiff.checked) clauses.push("ST_ADDRESS <> PROP_LOC");
  return clauses.length ? clauses.join(' AND ') : '1=1';
}

async function runQuery(bounds) {
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;

  currentRows = [];
  renderRows([]);
  btnCsv.disabled = true;
  btnClear.disabled = false;

  const geometry = JSON.stringify({
    xmin: bounds.getWest(),
    ymin: bounds.getSouth(),
    xmax: bounds.getEast(),
    ymax: bounds.getNorth(),
    spatialReference: { wkid: 4326 }
  });
  const where = buildWhere();

  let offset = 0;
  try {
    while (true) {
      setStatus(offset === 0 ? 'Querying…' : `Loading… ${currentRows.length.toLocaleString()} rows so far`);
      const body = new URLSearchParams({
        f: 'json',
        geometry,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        where,
        outFields: SERVICE_FIELDS.join(','),
        returnGeometry: 'false',
        orderByFields: 'OBJECTID',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE_SIZE)
      });

      const res = await fetch(SERVICE_URL, { method: 'POST', body, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'Service error');

      const features = json.features || [];
      for (const f of features) currentRows.push(f.attributes);

      if (currentRows.length >= MAX_ROWS) {
        setStatus(`Stopped at ${MAX_ROWS.toLocaleString()} rows — draw a smaller box for a complete list.`, 'error');
        break;
      }
      if (!json.exceededTransferLimit || features.length < PAGE_SIZE) {
        setStatus(`Done. ${currentRows.length.toLocaleString()} matching parcel${currentRows.length === 1 ? '' : 's'}.`, 'done');
        break;
      }
      offset += PAGE_SIZE;
    }
    sortRows(0, 'desc');
    renderRows(currentRows, { sortedIdx: 0, sortedDir: 'desc' });
    btnCsv.disabled = currentRows.length === 0;
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    activeController = null;
  }
}

function renderRows(rows, opts = {}) {
  tbody.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.PAMS_PIN) {
      tr.dataset.pin = r.PAMS_PIN;
      if (pins.has(r.PAMS_PIN)) tr.classList.add('pinned');
    }
    for (const col of COLUMNS) {
      const td = document.createElement('td');
      const v = cellValue(r, col);
      td.textContent = v;
      if (col.key === 'STATUS') {
        td.classList.add(v === 'Out of State' ? 'status-oos' : 'status-in');
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  theadRow.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc','sort-desc'));
  if (typeof opts.sortedIdx === 'number') {
    theadRow.children[opts.sortedIdx].classList.add(opts.sortedDir === 'asc' ? 'sort-asc' : 'sort-desc');
  }
}

function markRowPinned(id, pinned) {
  const tr = tbody.querySelector(`tr[data-pin="${CSS.escape(id)}"]`);
  if (tr) tr.classList.toggle('pinned', pinned);
}

async function pinRow(row) {
  const id = row.PAMS_PIN;
  if (!id || pins.has(id)) return;
  const prev = statusEl.textContent;
  const prevCls = statusEl.className;
  setStatus('Locating parcel on map…');
  try {
    const { lat, lng } = await fetchCentroid(id);
    const pin = { id, lat, lng, attrs: { ...row } };
    pin.marker = makeMarker(pin);
    pins.set(id, pin);
    savePins();
    renderPinsList();
    markRowPinned(id, true);
    statusEl.textContent = prev;
    statusEl.className = prevCls;
  } catch (err) {
    console.error(err);
    setStatus(`Could not pin parcel: ${err.message}`, 'error');
  }
}

function unpin(id) {
  const pin = pins.get(id);
  if (!pin) return;
  if (pin.marker) pin.marker.remove();
  pins.delete(id);
  savePins();
  renderPinsList();
  markRowPinned(id, false);
}

function makeMarker(pin) {
  const marker = L.marker([pin.lat, pin.lng]).addTo(map);
  marker.bindPopup(() => buildPopupHTML(pin), { maxWidth: 280 });
  marker.on('popupopen', (e) => {
    const node = e.popup.getElement();
    const btn = node && node.querySelector('.popup-remove');
    if (btn) btn.onclick = () => { map.closePopup(); unpin(pin.id); };
  });
  return marker;
}

function buildPopupHTML(pin) {
  const a = pin.attrs;
  const row = (label, value) => value ? `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>` : '';
  return `
    <div class="parcel-popup">
      <h3>${escapeHtml(a.PROP_LOC || '(no address)')}</h3>
      <dl>
        ${row('Muni', a.MUN_NAME)}
        ${row('County', a.COUNTY)}
        ${row('Block', a.PCLBLOCK)}
        ${row('Lot', a.PCLLOT)}
        ${row('Owner', a.OWNER_NAME)}
        ${row('Mailing', a.ST_ADDRESS)}
        ${row('', [a.CITY_STATE, a.ZIP_CODE].filter(Boolean).join(' '))}
      </dl>
      <button class="popup-remove" type="button">Remove pin</button>
    </div>
  `;
}

function renderPinsList() {
  pinsListEl.replaceChildren();
  pinsCountEl.textContent = String(pins.size);
  if (pins.size === 0) {
    const empty = document.createElement('li');
    empty.className = 'pins-empty';
    empty.textContent = 'Click a row in the results to pin a property.';
    pinsListEl.appendChild(empty);
    return;
  }
  const items = Array.from(pins.values()).sort((a, b) =>
    (a.attrs.PROP_LOC || '').localeCompare(b.attrs.PROP_LOC || '')
  );
  for (const pin of items) {
    const li = document.createElement('li');
    li.className = 'pin-item';
    li.innerHTML = `
      <div class="pin-info">
        <div class="pin-addr">${escapeHtml(pin.attrs.PROP_LOC || '(no address)')}</div>
        <div class="pin-sub">${escapeHtml(pin.attrs.MUN_NAME || '')} • Blk ${escapeHtml(pin.attrs.PCLBLOCK || '')} Lot ${escapeHtml(pin.attrs.PCLLOT || '')}</div>
      </div>
      <button class="pin-remove" type="button" title="Remove pin">×</button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('pin-remove')) {
        unpin(pin.id);
      } else {
        map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 17));
        pin.marker.openPopup();
      }
    });
    pinsListEl.appendChild(li);
  }
}

async function fetchCentroid(pamsPin) {
  const body = new URLSearchParams({
    f: 'json',
    where: `PAMS_PIN='${pamsPin.replace(/'/g, "''")}'`,
    outFields: 'PAMS_PIN',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1'
  });
  const res = await fetch(SERVICE_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Service error');
  const f = (json.features || [])[0];
  if (!f || !f.geometry || !f.geometry.rings) throw new Error('Geometry not found');
  let sx = 0, sy = 0, n = 0;
  for (const ring of f.geometry.rings) {
    for (const [x, y] of ring) { sx += x; sy += y; n++; }
  }
  if (!n) throw new Error('Empty geometry');
  return { lng: sx / n, lat: sy / n };
}

function loadPins() {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    for (const p of arr) {
      const pin = { id: p.id, lat: p.lat, lng: p.lng, attrs: p.attrs };
      pin.marker = makeMarker(pin);
      pins.set(pin.id, pin);
    }
  } catch (err) {
    console.warn('Failed to restore pins:', err);
  }
}

function savePins() {
  const arr = Array.from(pins.values()).map(p => ({ id: p.id, lat: p.lat, lng: p.lng, attrs: p.attrs }));
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(arr));
}

function escapeHtml(s) {
  return (s ?? '').toString().replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function downloadCsv(rows) {
  const escape = (v) => {
    const s = (v ?? '').toString();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(c => c.label).map(escape).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(c => escape(cellValue(r, c))).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nj-parcels-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
