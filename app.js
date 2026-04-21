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
const PINS_STORAGE_KEY = 'nj-parcel-pins';
const COUNTY_TAX_CACHE_KEY = 'nj-parcel-tax-records-v1';
const COUNTY_TAX_TTL_MS = 24 * 60 * 60 * 1000;
const COUNTY_TAX_ENRICHMENT_CONCURRENCY = 4;
const COUNTY_TAX_REQUEST_TIMEOUT_MS = 8000;
const COUNTY_TAX_PRIMARY_SOURCE_LABEL = 'County records';
const COUNTY_TAX_FALLBACK_SOURCE_LABEL = 'NJOGIS';

const COUNTY_INFO = [
  { code: '01', name: 'ATLANTIC' },
  { code: '02', name: 'BERGEN' },
  { code: '03', name: 'BURLINGTON' },
  { code: '04', name: 'CAMDEN' },
  { code: '05', name: 'CAPE MAY' },
  { code: '06', name: 'CUMBERLAND' },
  { code: '07', name: 'ESSEX' },
  { code: '08', name: 'GLOUCESTER' },
  { code: '09', name: 'HUDSON' },
  { code: '10', name: 'HUNTERDON' },
  { code: '11', name: 'MERCER' },
  { code: '12', name: 'MIDDLESEX' },
  { code: '13', name: 'MONMOUTH' },
  { code: '14', name: 'MORRIS' },
  { code: '15', name: 'OCEAN' },
  { code: '16', name: 'PASSAIC' },
  { code: '17', name: 'SALEM' },
  { code: '18', name: 'SOMERSET' },
  { code: '19', name: 'SUSSEX' },
  { code: '20', name: 'UNION' },
  { code: '21', name: 'WARREN' }
];

const COUNTY_NAME_TO_CODE = COUNTY_INFO.reduce((acc, item) => {
  acc[item.name] = item.code;
  acc[item.name.replace(/\s+/g, '')] = item.code;
  acc[item.name.replace(/[^A-Z]/g, '')] = item.code;
  return acc;
}, {});

const COUNTY_TAX_REGISTRY = COUNTY_INFO.reduce((acc, item) => {
  acc[item.code] = {
    code: item.code,
    name: item.name,
    enabled: true,
    provider: 'NJParcels county attributes cache',
    endpoint: `https://cache.njparcels.com/attributes/v1.0/nj/{pin}?owner=1&assessment=1`,
    fetch: fetchCountyRecordFromNjParcels
  };
  return acc;
}, {});
const COUNTY_TAX_DEFAULT_PROVIDER = {
  code: '00',
  name: 'NJ/Wide',
  enabled: true,
  provider: 'NJParcels county attributes cache',
  endpoint: 'https://cache.njparcels.com/attributes/v1.0/nj/{pin}?owner=1&assessment=1',
  fetch: fetchCountyRecordFromNjParcels
};

const taxRecordCache = loadTaxRecordCache();

const NJ_LIKE_PATTERNS = [
  '% NJ',    '%,NJ',
  '% NJ %',  '%,NJ %',
  '% NJ.',   '%,NJ.',
  '% NJ,',   '%,NJ,',
  '% N.J.',  '%,N.J.',
  '% N.J',   '%,N.J',
  '% N. J.', '%,N. J.',
  '% N J',   '%,N J',
  '% NEW JERSEY',  '%,NEW JERSEY',
  '% NEW JERSEY.', '%,NEW JERSEY.'
];

const COLUMNS = [
  { key: 'STATUS',      label: 'Status',           compute: r => isOutOfState(r.CITY_STATE) ? 'Out of State' : 'In State' },
  { key: 'DATA_SOURCE', label: 'Primary Source', compute: r => r._recordSource || COUNTY_TAX_FALLBACK_SOURCE_LABEL },
  { key: 'OWNER_COUNT', label: '# in Area',        compute: r => r._ownerCount ?? 1, numeric: true },
  { key: 'DEED_DATE',   label: 'Date Sold',
      display: r => formatYymmdd(r.DEED_DATE),
      sortKey: r => yymmddSortKey(r.DEED_DATE) },
  { key: 'SALE_PRICE',  label: 'Sold For',
      display: r => r.SALE_PRICE ? `$${Number(r.SALE_PRICE).toLocaleString()}` : '',
      sortKey: r => Number(r.SALE_PRICE) || 0,
      numeric: true },
  { key: 'NET_VALUE',      label: 'Net Value',
      display: r => formatCurrency(r.NET_VALUE),
      sortKey: r => Number(r.NET_VALUE) || 0,
      numeric: true },
  { key: 'LAND_VALUE',     label: 'Land Value',
      display: r => formatCurrency(r.LAND_VALUE),
      sortKey: r => Number(r.LAND_VALUE) || 0,
      numeric: true },
  { key: 'IMPROVEMENT_VALUE', label: 'Improvement Value',
      display: r => formatCurrency(r.IMPROVEMENT_VALUE),
      sortKey: r => Number(r.IMPROVEMENT_VALUE) || 0,
      numeric: true },
  { key: 'DEED_BOOK',     label: 'Deed Book', csv: r => r.DEED_BOOK || '' },
  { key: 'DEED_PAGE',     label: 'Deed Page', csv: r => r.DEED_PAGE || '' },
  { key: 'ADDITIONAL_LOTS', label: 'Additional Lots', csv: r => r.ADDITIONAL_LOTS || '' },
  { key: 'OWNER_MAILING', label: 'Owner Mailing',
      render: (r, td) => {
        const street = document.createElement('div');
        street.textContent = r.ST_ADDRESS || '';
        const loc = document.createElement('div');
        loc.className = 'cell-sub';
        loc.textContent = [r.CITY_STATE, r.ZIP_CODE].filter(Boolean).join(' ');
        td.appendChild(street);
        td.appendChild(loc);
      },
      csv: r => [r.ST_ADDRESS, r.CITY_STATE, r.ZIP_CODE].filter(Boolean).join(', '),
      sortKey: r => {
        const state = extractState(r.CITY_STATE) || 'ZZ';
        const city  = (r.CITY_STATE || '').toUpperCase();
        const addr  = (r.ST_ADDRESS || '').toUpperCase();
        return `${state}|${city}|${addr}`;
      } },
  { key: 'PROP_LOC',    label: 'Property Address' },
  { key: 'MUN_NAME',    label: 'Municipality' },
  { key: 'COUNTY',      label: 'County' },
  { key: 'PCLBLOCK',    label: 'Block' },
  { key: 'PCLLOT',      label: 'Lot' },
  { key: 'SALES_CODE',  label: 'Sale Code' },
  { key: 'NJP_LINK',    label: 'NJparcels',
      display: r => r.PAMS_PIN ? 'Open' : '',
      href:    r => njParcelsUrl(r),
      skipSort: true },
  { key: 'GMAPS_LINK',  label: 'Maps',
      display: r => r.PROP_LOC ? 'Open' : '',
      href:    r => r.PROP_LOC
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(buildAddressQuery(r))}`
        : '',
      skipSort: true },
  { key: 'ZILLOW_LINK', label: 'Zillow',
      display: r => r.PROP_LOC ? 'Open' : '',
      href:    r => r.PROP_LOC
        ? `https://www.zillow.com/homes/${encodeURIComponent(buildAddressQuery(r))}_rb/`
        : '',
      skipSort: true },
  { key: 'NJDEP_LINK',  label: 'NJDEP',
      display: r => r.PROP_LOC ? 'Open' : '',
      href:    r => r.PROP_LOC
        ? `https://njdep.maps.arcgis.com/apps/webappviewer/index.html?id=02251e521d97454aabadfd8cf168e44d&find=${encodeURIComponent(buildAddressQuery(r))}`
        : '',
      skipSort: true },
  { key: 'OWNER_NAME',  label: 'Owner Name' }
];
const SERVICE_FIELDS = ['PAMS_PIN', 'ST_ADDRESS', 'CITY_STATE', 'ZIP_CODE',
  'PROP_LOC', 'MUN_NAME', 'COUNTY', 'PCLBLOCK', 'PCLLOT', 'SALES_CODE',
  'DEED_DATE', 'SALE_PRICE', 'OWNER_NAME'
];

const FULL_STATE_NAMES = {
  'NEW JERSEY': 'NJ', 'NEW YORK': 'NY', 'PENNSYLVANIA': 'PA',
  'CONNECTICUT': 'CT', 'MASSACHUSETTS': 'MA', 'FLORIDA': 'FL',
  'CALIFORNIA': 'CA', 'MARYLAND': 'MD', 'DELAWARE': 'DE',
  'VIRGINIA': 'VA', 'NORTH CAROLINA': 'NC', 'SOUTH CAROLINA': 'SC'
};

function extractState(cityState) {
  if (!cityState) return '';
  let s = cityState.toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')       // strip punctuation
    .replace(/\s+\d{5,}\s*$/, '')       // strip trailing ZIP
    .replace(/\s+/g, ' ')
    .trim();
  for (const [name, abbr] of Object.entries(FULL_STATE_NAMES)) {
    if (s === name || s.endsWith(' ' + name)) return abbr;
  }
  const endTwo = s.match(/(?:^|\s)([A-Z]{2})$/);
  if (endTwo) return endTwo[1];
  const spaced = s.match(/(?:^|\s)([A-Z])\s([A-Z])$/);
  if (spaced) return spaced[1] + spaced[2];
  const anyTokens = s.match(/\b[A-Z]{2}\b/g);
  if (anyTokens) return anyTokens[anyTokens.length - 1];
  const last = s.split(' ').pop() || '';
  for (const abbr of Object.values(FULL_STATE_NAMES)) {
    if (last.startsWith(abbr)) return abbr;
  }
  return '';
}

function isOutOfState(cityState) {
  const st = extractState(cityState);
  if (!st) return true;
  return st !== 'NJ';
}

function cellValue(row, col) {
  if (col.display) return col.display(row);
  if (col.compute) return col.compute(row);
  return row[col.key] ?? '';
}

function formatYymmdd(s) {
  if (!s || typeof s !== 'string' || s.length !== 6) return '';
  if (!/^\d{6}$/.test(s)) return '';
  const yy = s.slice(0, 2), mm = s.slice(2, 4), dd = s.slice(4, 6);
  const year = Number(yy) >= 30 ? `19${yy}` : `20${yy}`;
  return `${year}-${mm}-${dd}`;
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return `$${num.toLocaleString()}`;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function yymmddSortKey(s) {
  if (!s || typeof s !== 'string' || s.length !== 6 || !/^\d{6}$/.test(s)) return '';
  const century = Number(s.slice(0, 2)) >= 30 ? '19' : '20';
  return century + s;
}

function parsePamsPin(pin) {
  if (!pin) return null;
  const parts = pin.split('_');
  if (parts.length < 3) return null;
  const [muni, block, lot, qual] = parts;
  if (!muni || !block || !lot) return null;
  return { muni, block, lot, qual: qual || '' };
}

function njParcelsUrl(row) {
  const p = parsePamsPin(row.PAMS_PIN);
  if (!p) return '';
  const segs = [p.muni, p.block, p.lot];
  if (p.qual) segs.push(p.qual);
  return `https://njparcels.com/property/${segs.map(encodeURIComponent).join('/')}`;
}

function buildAddressQuery(row) {
  const zipPart = row.ZIP_CODE ? `NJ ${row.ZIP_CODE}` : 'NJ';
  return [row.PROP_LOC, row.MUN_NAME, zipPart].filter(Boolean).join(', ');
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

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const btnSearch = document.getElementById('btn-search');

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  btnSearch.disabled = true;
  setStatus('Searching…');
  try {
    const hit = await geocodeAddress(q);
    if (!hit) {
      setStatus(`No match for “${q}”.`, 'error');
      return;
    }
    if (hit.bbox) {
      map.fitBounds(hit.bbox, { maxZoom: 18 });
    } else {
      map.setView([hit.lat, hit.lng], 17);
    }
    setStatus(`Centered on ${hit.label}`, 'done');
  } catch (err) {
    console.error(err);
    setStatus(`Search failed: ${err.message}`, 'error');
  } finally {
    btnSearch.disabled = false;
  }
});

async function geocodeAddress(q) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'us');
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  const h = arr[0];
  if (!h) return null;
  const lat = Number(h.lat), lng = Number(h.lon);
  let bbox = null;
  if (Array.isArray(h.boundingbox) && h.boundingbox.length === 4) {
    const [s, n, w, e] = h.boundingbox.map(Number);
    bbox = [[s, w], [n, e]];
  }
  return { lat, lng, bbox, label: h.display_name || q };
}

const statusEl = document.getElementById('status');
const tbody = document.querySelector('#results-table tbody');
const theadRow = document.querySelector('#results-table thead tr');
const btnCsv = document.getElementById('btn-csv');
const btnClear = document.getElementById('btn-clear');
const filterOos = document.getElementById('filter-oos');
const filterDiff = document.getElementById('filter-diff');
const filterSold = document.getElementById('filter-sold');
const pinsListEl = document.getElementById('pins-list');
const pinsCountEl = document.getElementById('pins-count');

const pins = new Map();
const pendingPinFetches = new Set();
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
  const existing = pins.get(id);
  if (existing) {
    map.setView([existing.lat, existing.lng], Math.max(map.getZoom(), 17));
    if (existing.marker) existing.marker.openPopup();
    return;
  }
  const row = currentRows.find(r => r.PAMS_PIN === id);
  if (row) pinRow(row);
});

theadRow.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const idx = Array.from(theadRow.children).indexOf(th);
  if (COLUMNS[idx]?.skipSort) return;
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
  if (col.skipSort) return;
  const mul = dir === 'asc' ? 1 : -1;
  const valueOf = col.sortKey ? col.sortKey : (r) => cellValue(r, col);
  currentRows.sort((a, b) => {
    const va = valueOf(a), vb = valueOf(b);
    if (col.numeric) return ((Number(va) || 0) - (Number(vb) || 0)) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  });
}

function ownerKey(row) {
  const norm = (s) => (s ?? '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
  const a = normalizeAddressForCompare(row.ST_ADDRESS);
  const c = norm(row.CITY_STATE);
  const z = norm(row.ZIP_CODE);
  if (!a && !c && !z) return '';
  return `${a}|${c}|${z}`;
}

function computeOwnerCounts(rows) {
  const counts = new Map();
  for (const r of rows) {
    const k = ownerKey(r);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const r of rows) {
    const k = ownerKey(r);
    r._ownerCount = k ? counts.get(k) : 1;
  }
}

function resolveCountyCode(countyName) {
  if (!countyName) return '';
  const raw = String(countyName).toUpperCase().trim();
  if (COUNTY_NAME_TO_CODE[raw]) return COUNTY_NAME_TO_CODE[raw];
  const removedSpaces = raw.replace(/\s+/g, '');
  if (COUNTY_NAME_TO_CODE[removedSpaces]) return COUNTY_NAME_TO_CODE[removedSpaces];
  const cleaned = raw.replace(/[^A-Z]/g, '');
  if (COUNTY_NAME_TO_CODE[cleaned]) return COUNTY_NAME_TO_CODE[cleaned];
  const droppedSuffix = cleaned.replace(/COUNTY$/, '');
  return COUNTY_NAME_TO_CODE[droppedSuffix] || '';
}

function countyRecordCacheKey(pin) {
  const safePin = (pin || '').toUpperCase().trim();
  if (!safePin) return '';
  return safePin;
}

function normalizeAddressForCompare(value) {
  return (value || '')
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function isAddressMismatch(ownerAddress, propertyAddress) {
  return normalizeAddressForCompare(ownerAddress) !== normalizeAddressForCompare(propertyAddress);
}

function applyPostQueryFilters(rows) {
  const out = [];
  for (const row of rows) {
    if (filterOos.checked && !isOutOfState(row.CITY_STATE)) continue;
    if (filterDiff.checked && !isAddressMismatch(row.ST_ADDRESS, row.PROP_LOC)) continue;
    out.push(row);
  }
  return out;
}

function hasUsefulText(value) {
  return (value ?? '').toString().trim().length > 0;
}

function hasUsefulValue(value) {
  return safeNumber(value) > 0;
}

function mergeCountyRecord(row, countyRecord, provider) {
  if (!countyRecord) {
    if (!row._recordSource) row._recordSource = COUNTY_TAX_FALLBACK_SOURCE_LABEL;
    return false;
  }

  let changed = false;
  const updates = [];

  if (hasUsefulText(countyRecord.propertyAddress) && row.PROP_LOC !== countyRecord.propertyAddress) {
    row.PROP_LOC = countyRecord.propertyAddress;
    changed = true;
    updates.push('PROP_LOC');
  }
  if (hasUsefulText(countyRecord.ownerAddress) && row.ST_ADDRESS !== countyRecord.ownerAddress) {
    row.ST_ADDRESS = countyRecord.ownerAddress;
    changed = true;
    updates.push('ST_ADDRESS');
  }
  if (hasUsefulText(countyRecord.ownerCityState) && row.CITY_STATE !== countyRecord.ownerCityState) {
    row.CITY_STATE = countyRecord.ownerCityState;
    changed = true;
    updates.push('CITY_STATE');
  }
  if (hasUsefulText(countyRecord.ownerZip) && row.ZIP_CODE !== countyRecord.ownerZip) {
    row.ZIP_CODE = countyRecord.ownerZip;
    changed = true;
    updates.push('ZIP_CODE');
  }
  if (hasUsefulText(countyRecord.ownerName) && row.OWNER_NAME !== countyRecord.ownerName) {
    row.OWNER_NAME = countyRecord.ownerName;
    changed = true;
    updates.push('OWNER_NAME');
  }
  if (hasUsefulValue(countyRecord.landValue) && !hasUsefulValue(row.LAND_VALUE)) {
    row.LAND_VALUE = countyRecord.landValue;
    changed = true;
    updates.push('LAND_VALUE');
  }
  if (hasUsefulValue(countyRecord.improvementValue) && !hasUsefulValue(row.IMPROVEMENT_VALUE)) {
    row.IMPROVEMENT_VALUE = countyRecord.improvementValue;
    changed = true;
    updates.push('IMPROVEMENT_VALUE');
  }
  if (hasUsefulValue(countyRecord.netValue) && !hasUsefulValue(row.NET_VALUE)) {
    row.NET_VALUE = countyRecord.netValue;
    changed = true;
    updates.push('NET_VALUE');
  }
  if (hasUsefulText(countyRecord.deedBook) && !hasUsefulText(row.DEED_BOOK)) {
    row.DEED_BOOK = countyRecord.deedBook;
    changed = true;
    updates.push('DEED_BOOK');
  }
  if (hasUsefulText(countyRecord.deedPage) && !hasUsefulText(row.DEED_PAGE)) {
    row.DEED_PAGE = countyRecord.deedPage;
    changed = true;
    updates.push('DEED_PAGE');
  }
  if (hasUsefulText(countyRecord.additionalLots) && !hasUsefulText(row.ADDITIONAL_LOTS)) {
    row.ADDITIONAL_LOTS = countyRecord.additionalLots;
    changed = true;
    updates.push('ADDITIONAL_LOTS');
  }

  row._recordSource = `${COUNTY_TAX_PRIMARY_SOURCE_LABEL}: ${provider.provider}`;
  row._recordSourceFields = updates;
  return changed;
}

function initRecordSourceDefaults(rows) {
  for (const row of rows) {
    row._recordSource = COUNTY_TAX_FALLBACK_SOURCE_LABEL;
    row._recordSourceFields = [];
    row._taxRecordCounty = resolveCountyCode(row.COUNTY);
  }
}

function loadTaxRecordCache() {
  try {
    const raw = localStorage.getItem(COUNTY_TAX_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const cleaned = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      if (Number(entry.expiresAt) < now) continue;
      cleaned[key] = entry;
    }
    return cleaned;
  } catch (err) {
    console.warn('Failed to load county tax cache:', err);
    return {};
  }
}

function persistTaxRecordCache() {
  try {
    localStorage.setItem(COUNTY_TAX_CACHE_KEY, JSON.stringify(taxRecordCache));
  } catch (err) {
    console.warn('Failed to persist county tax cache:', err);
  }
}

function getCachedTaxRecord(cacheKey) {
  const entry = cacheKey ? taxRecordCache[cacheKey] : null;
  if (!entry) return null;
  if (Number(entry.expiresAt) < Date.now()) {
    delete taxRecordCache[cacheKey];
    persistTaxRecordCache();
    return null;
  }
  return {
    value: entry.value ?? null,
    hasData: entry.hasData === true
  };
}

function setCachedTaxRecord(cacheKey, value) {
  if (!cacheKey) return;
  const hasData = !!(
    value &&
    typeof value === 'object' &&
    [
      'propertyAddress',
      'ownerName',
      'ownerAddress',
      'ownerCityState',
      'ownerZip',
      'landValue',
      'improvementValue',
      'netValue',
      'deedBook',
      'deedPage',
      'additionalLots'
    ].some((key) => {
      if (['landValue', 'improvementValue', 'netValue'].includes(key)) {
        return hasUsefulValue(value[key]);
      }
      return hasUsefulText(value[key]);
    })
  );
  taxRecordCache[cacheKey] = {
    value: hasData ? value : null,
    hasData,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + COUNTY_TAX_TTL_MS
  };
}

function safeTrim(value) {
  return (value ?? '').toString().trim();
}

function resolveCountyTaxProvider(row) {
  const countyCode = row._taxRecordCounty || resolveCountyCode(row.COUNTY);
  if (countyCode && COUNTY_TAX_REGISTRY[countyCode]) return COUNTY_TAX_REGISTRY[countyCode];
  return COUNTY_TAX_DEFAULT_PROVIDER;
}

async function fetchCountyRecordFromNjParcels(row, options = {}) {
  const pin = safeTrim(row.PAMS_PIN);
  if (!pin) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COUNTY_TAX_REQUEST_TIMEOUT_MS);

  if (options.signal) {
    const external = options.signal;
    if (external.aborted) {
      clearTimeout(timeout);
      throw external.reason || new DOMException('Aborted', 'AbortError');
    }
    external.addEventListener('abort', () => controller.abort());
  }

  try {
    const res = await fetch(`https://cache.njparcels.com/attributes/v1.0/nj/${encodeURIComponent(pin)}?owner=1&assessment=1`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`County record HTTP ${res.status}`);
    const payload = await res.json();
    if (!payload || typeof payload !== 'object') return null;
    return {
      pin,
      propertyAddress: safeTrim(payload.property_location),
      ownerName: safeTrim(payload.owner_name),
      ownerAddress: safeTrim(payload.owner_address),
      ownerCityState: safeTrim(payload.owner_city),
      ownerZip: safeTrim(payload.owner_zip),
      landValue: safeNumber(payload.land_value),
      improvementValue: safeNumber(payload.improvement_value),
      netValue: safeNumber(payload.net_value),
      deedBook: safeTrim(payload.deed_book),
      deedPage: safeTrim(payload.deed_page),
      additionalLots: safeTrim(payload.additional_lots)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichRowsWithCountyRecords(rows, options = {}) {
  const { signal } = options;
  const lookupByKey = new Map();
  const lookupOrder = [];

  for (const row of rows) {
    const pin = safeTrim(row.PAMS_PIN);
    if (!pin) {
      row._recordSource = `${COUNTY_TAX_FALLBACK_SOURCE_LABEL} (PIN missing)`;
      continue;
    }
    const provider = resolveCountyTaxProvider(row);
    if (!provider || !provider.enabled) continue;

    const cacheKey = countyRecordCacheKey(pin);
    if (!cacheKey) continue;

    const cachedValue = getCachedTaxRecord(cacheKey);
    if (cachedValue) {
      if (cachedValue.hasData) {
        mergeCountyRecord(row, cachedValue.value, provider);
      }
      continue;
    }

    if (!lookupByKey.has(cacheKey)) {
      lookupByKey.set(cacheKey, { provider, rows: [], cacheKey });
      lookupOrder.push(cacheKey);
    }
    lookupByKey.get(cacheKey).rows.push(row);
  }

  let next = 0;
  let lookedUp = 0;
  let fromCounty = 0;
  let errors = 0;

  const worker = async () => {
    while (next < lookupOrder.length) {
      const idx = next++;
      const bucket = lookupByKey.get(lookupOrder[idx]);
      if (!bucket || signal?.aborted) return;

      const row = bucket.rows[0];
      let record = null;
      try {
        lookedUp += 1;
        record = await bucket.provider.fetch(row, { signal });
      } catch (err) {
        errors += 1;
        if (err?.name !== 'AbortError') {
          console.error('County record lookup failed:', err);
        }
      }

      setCachedTaxRecord(bucket.cacheKey, record);
      if (record) fromCounty += bucket.rows.length;
      for (const target of bucket.rows) {
        mergeCountyRecord(target, record, bucket.provider);
      }
    }
  };

  const workerCount = Math.min(COUNTY_TAX_ENRICHMENT_CONCURRENCY, lookupOrder.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (lookupOrder.length > 0) persistTaxRecordCache();

  return { lookedUp, fromCounty, errors, totalCandidates: lookupOrder.length };
}

function buildWhere() {
  const clauses = [];
  if (filterOos.checked) {
    const nj = NJ_LIKE_PATTERNS.map(p => `CITY_STATE NOT LIKE '${p}'`).join(' AND ');
    clauses.push(`(${nj})`);
  }
  if (filterDiff.checked) clauses.push("ST_ADDRESS <> PROP_LOC");
  if (filterSold.checked) {
    // DEED_DATE is YYMMDD with a 2-digit year; string compare would put '99' > '20'.
    // Pivot at 30: YY<30 → 20YY, YY≥30 → 19YY. Keep: null, 2000-2019 (<'200101'), 1930-1999 (≥'300101').
    clauses.push("(DEED_DATE IS NULL OR DEED_DATE < '200101' OR DEED_DATE >= '300101')");
  }
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
  let truncated = false;
  try {
    while (true) {
      setStatus(offset === 0 ? 'Querying parcel layer…' : `Loading… ${currentRows.length.toLocaleString()} rows so far`);
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
      for (const f of features) {
        const a = f.attributes;
        currentRows.push(a);
      }

      if (currentRows.length >= MAX_ROWS) {
        setStatus(`Stopped at ${MAX_ROWS.toLocaleString()} rows — draw a smaller box for a complete list.`, 'error');
        truncated = true;
        break;
      }
      if (!json.exceededTransferLimit || features.length < PAGE_SIZE) {
        break;
      }
      offset += PAGE_SIZE;
    }

    initRecordSourceDefaults(currentRows);
    // Pre-filter before hitting the county endpoint so we only pay for HTTP on survivors.
    currentRows = applyPostQueryFilters(currentRows);
    const stats = await enrichRowsWithCountyRecords(currentRows, { signal });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    currentRows = applyPostQueryFilters(currentRows);
    if (stats.totalCandidates > 0) {
      setStatus(`County check: ${stats.fromCounty}/${stats.totalCandidates} rows enriched (${stats.errors} errors).`);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    computeOwnerCounts(currentRows);

    if (!currentRows.length) {
      if (truncated) setStatus('No matching parcels in first result window (cap reached).', 'error');
      else setStatus('No matching parcels after applying filters.', 'done');
      renderRows(currentRows, { sortedIdx: 0, sortedDir: 'desc' });
      btnCsv.disabled = true;
      return;
    }

    sortRows(0, 'desc');
    renderRows(currentRows, { sortedIdx: 0, sortedDir: 'desc' });
    if (truncated) {
      setStatus(`Done with cap: ${currentRows.length.toLocaleString()} rows.`, 'error');
    } else {
      setStatus(`Done. ${currentRows.length.toLocaleString()} matching parcel${currentRows.length === 1 ? '' : 's'}.`, 'done');
    }
    btnCsv.disabled = false;
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
      if (col.render) {
        col.render(r, td);
      } else if (col.href) {
        const url = col.href(r);
        if (url && v) {
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = v;
          a.addEventListener('click', (e) => e.stopPropagation());
          td.appendChild(a);
        }
      } else {
        td.textContent = v;
      }
      if (col.key === 'STATUS') {
        td.classList.add(v === 'Out of State' ? 'status-oos' : 'status-in');
      }
      if (col.key === 'DATA_SOURCE' && typeof v === 'string') {
        td.classList.add(v.includes('County records') ? 'source-county' : 'source-fallback');
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
  if (!id || pins.has(id) || pendingPinFetches.has(id)) return;
  pendingPinFetches.add(id);
  const prev = statusEl.textContent;
  const prevCls = statusEl.className;
  setStatus('Locating parcel on map…');
  try {
    const { lat, lng } = await fetchCentroid(id);
    if (pins.has(id)) return;
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
  } finally {
    pendingPinFetches.delete(id);
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
  const sold = formatYymmdd(a.DEED_DATE);
  const price = a.SALE_PRICE ? `$${Number(a.SALE_PRICE).toLocaleString()}` : '';
  const netValue = formatCurrency(a.NET_VALUE);
  const landValue = formatCurrency(a.LAND_VALUE);
  const improvementValue = formatCurrency(a.IMPROVEMENT_VALUE);
  const soldLine = [sold, price].filter(Boolean).join(' · ');
  const url = njParcelsUrl(a);
  const link = url
    ? `<p class="popup-link"><a href="${url}" target="_blank" rel="noopener noreferrer">Verify on NJparcels.com →</a></p>`
    : '';
  return `
    <div class="parcel-popup">
      <h3>${escapeHtml(a.PROP_LOC || '(no address)')}</h3>
      <dl>
        ${row('Muni', a.MUN_NAME)}
        ${row('County', a.COUNTY)}
        ${row('Block', a.PCLBLOCK)}
        ${row('Lot', a.PCLLOT)}
        ${row('Owner', a.OWNER_NAME)}
        ${row('Net value', netValue)}
        ${row('Land value', landValue)}
        ${row('Improvement value', improvementValue)}
        ${row('Deed', [a.DEED_BOOK, a.DEED_PAGE].filter(Boolean).join(' / '))}
        ${row('Source', a._recordSource || COUNTY_TAX_FALLBACK_SOURCE_LABEL)}
        ${row('Mailing', a.ST_ADDRESS)}
        ${row('', [a.CITY_STATE, a.ZIP_CODE].filter(Boolean).join(' '))}
        ${row('Last sold', soldLine)}
      </dl>
      ${link}
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
    const sold = formatYymmdd(pin.attrs.DEED_DATE);
    const subParts = [
      pin.attrs.MUN_NAME || '',
      `Blk ${pin.attrs.PCLBLOCK || ''} Lot ${pin.attrs.PCLLOT || ''}`
    ];
    if (sold) subParts.push(`sold ${sold}`);
    li.innerHTML = `
      <div class="pin-info">
        <div class="pin-addr">${escapeHtml(pin.attrs.PROP_LOC || '(no address)')}</div>
        <div class="pin-sub">${subParts.map(escapeHtml).join(' • ')}</div>
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
  for (const r of rows) {
    lines.push(COLUMNS.map(c =>
      escape(c.csv ? c.csv(r) : c.href ? c.href(r) : cellValue(r, c))
    ).join(','));
  }
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
