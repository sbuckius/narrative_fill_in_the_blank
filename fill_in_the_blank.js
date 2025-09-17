/**
 * Collaborative Fill-in-the-Blanks (p5.js + Firebase Realtime DB)
 * - 30 lines with 3 blanks each (live-synced)
 * - Wikipedia-powered "noun-like" words under each line
 * - Save Text: always downloads (safe filename), and attempts Firebase save
 * - Reset: clears inputs locally + in Firebase
 */

let container;
const LINES = 30;
const BLANKS_PER_LINE = 3;
const NOUNS_PER_LINE = 10;

const inputs = [];          // inputs[lineIdx][blankIdx] -> p5.Element
const nounLineEls = [];     // per-line DIV where nouns render

// Static text segments (customize)
const segments = Array.from({ length: LINES }, (_, i) => ([
  `Line ${i + 1}: Before`,
  `then`,
  `and then`,
  `finally`
]));

// Stopword-ish list to filter out function words etc.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","when","while","for","to","of","in","on","at","by",
  "with","from","as","that","this","these","those","it","its","is","are","was","were","be","been","being",
  "has","have","had","do","does","did","can","could","may","might","must","shall","should","will","would",
  "i","you","he","she","they","we","me","him","her","them","us","my","your","his","their","our","mine","yours","hers","theirs","ours",
  "also","such","other","more","most","some","any","each","many","few","several","which","who","whom","whose","what","where","why","how",
  "than","into","over","under","about","after","before","between","during","without","within","per","via","vs","etc",
  "january","february","march","april","may","june","july","august","september","october","november","december",
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "km","mi","ft","m","cm","mm","km2","m2","pm","am"
]);

// Fetch pool targets
const TOTAL_NOUNS_NEEDED = LINES * NOUNS_PER_LINE;
const TARGET_POOL_SIZE = Math.min(600, Math.ceil(TOTAL_NOUNS_NEEDED * 1.6)); // a buffer for uniqueness
const MAX_REQUESTS = 60;    // do not hammer Wikipedia
const BATCH_SIZE   = 5;     // parallel requests per batch

// Utilities
function debounce(fn, ms) { let t; return function(...a){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a), ms); }; }
const clientId = (() => Math.random().toString(36).slice(2))();
function setStatus(msg, timeoutMs = 2000) {
  const s = document.getElementById('status'); if (!s) return;
  s.textContent = msg; if (timeoutMs) setTimeout(()=>{ if (s.textContent === msg) s.textContent=''; }, timeoutMs);
}
function stamp() {
  const d = new Date(); const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function setup() {
  noCanvas();
  container = createDiv().id('lines').parent(select('#app'));

  for (let i = 0; i < LINES; i++) {
    const lineWrap = createDiv().addClass('line').parent(container);
    inputs[i] = [];

    addText(lineWrap, segments[i][0]);
    addBlank(i, 0, lineWrap);
    addText(lineWrap, segments[i][1]);
    addBlank(i, 1, lineWrap);
    addText(lineWrap, segments[i][2]);
    addBlank(i, 2, lineWrap);
    addText(lineWrap, segments[i][3]);

    attachLineListener(i);

    // Noun row (populated after Wikipedia pool builds)
    const nounRow = createDiv().addClass('noun-row').parent(container);
    nounRow.html('loading nouns from Wikipedia…');
    nounLineEls[i] = nounRow;
  }

  // Buttons
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');
  if (saveBtn) saveBtn.addEventListener('click', onSave);
  if (resetBtn) resetBtn.addEventListener('click', onReset);

  // Build noun pool and render
  buildWikipediaNounPool(TARGET_POOL_SIZE)
    .then(pool => {
      if (pool.size < NOUNS_PER_LINE) throw new Error('Insufficient nouns gathered');
      renderAllNounRows(Array.from(pool));
    })
    .catch(err => {
      console.error('Wikipedia noun loading failed:', err);
      nounLineEls.forEach(el => el?.html('⚠️ couldn’t load nouns from Wikipedia'));
      setStatus('Couldn’t load nouns from Wikipedia.');
    });
}

/* ===== UI Builders ===== */
function addText(parent, s) { createSpan(s).addClass('t').parent(parent); }

function addBlank(lineIdx, blankIdx, parent) {
  const input = createInput('');
  input.attribute('placeholder', '___');
  input.parent(parent);
  input.elt.addEventListener('input', debounce(e => writeBlank(lineIdx, blankIdx, e.target.value), 250));
  if (!inputs[lineIdx]) inputs[lineIdx] = [];
  inputs[lineIdx][blankIdx] = input;
}

/* ===== Firebase Helpers ===== */
function pathFor(lineIdx, blankIdx) { return `blanks/${lineIdx}/${blankIdx}`; }

function writeBlank(lineIdx, blankIdx, value) {
  if (!window.db) return;
  window.db.ref(pathFor(lineIdx, blankIdx)).set({
    value, editedBy: clientId, updatedAt: Date.now()
  }).catch(console.error);
}

function attachLineListener(lineIdx) {
  if (!window.db) return;
  const lineRef = window.db.ref(`blanks/${lineIdx}`);
  lineRef.on('child_added', snap => applyRemote(lineIdx, snap));
  lineRef.on('child_changed', snap => applyRemote(lineIdx, snap));
}

function applyRemote(lineIdx, snap) {
  const blankIdx = parseInt(snap.key, 10);
  const data = snap.val();
  if (Number.isNaN(blankIdx) || !data || !inputs[lineIdx]?.[blankIdx]) return;
  const input = inputs[lineIdx][blankIdx].elt;
  if (document.activeElement !== input) input.value = data.value || '';
}

/* ===== Wikipedia fetching + noun extraction ===== */
async function fetchWikipediaRandomSummary() {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/random/summary';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Wikipedia error ${res.status}`);
  return res.json(); // { title, extract, ... }
}

function extractCandidateNounsFromText(text) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z\-\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && w.length <= 24)
    .filter(w => !STOPWORDS.has(w))
    .filter(w => !/^-|-$/.test(w))
    .filter(w => !w.includes('--'));

  // Allow many content words; lightly drop gerunds except "something/anything/nothing" patterns
  const candidates = words.filter(w => !w.endsWith('ing') || w.endsWith('thing'));
  const freq = new Map();
  for (const w of candidates) freq.set(w, (freq.get(w) || 0) + 1);
  return Array.from(new Set(candidates)).sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));
}

async function buildWikipediaNounPool(targetSize) {
  const pool = new Set();
  let requestsMade = 0;

  while (pool.size < targetSize && requestsMade < MAX_REQUESTS) {
    const batch = Math.min(BATCH_SIZE, MAX_REQUESTS - requestsMade);
    const tasks = Array.from({ length: batch }, () => fetchWikipediaRandomSummary().catch(() => null));
    const results = await Promise.all(tasks);
    requestsMade += batch;

    for (const r of results) {
      if (!r || !r.extract) continue;
      const words = extractCandidateNounsFromText(r.extract);
      for (const w of words) {
        pool.add(w);
        if (pool.size >= targetSize) break;
      }
      if (pool.size >= targetSize) break;
    }
  }
  return pool;
}

function pickUniqueRandom(arr, count, exclude = new Set()) {
  const chosen = [];
  const seen = new Set(exclude);
  let tries = 0;
  while (chosen.length < count && tries < count * 30) {
    const w = arr[Math.floor(Math.random() * arr.length)];
    if (!seen.has(w)) { chosen.push(w); seen.add(w); }
    tries++;
  }
  return chosen;
}

function renderAllNounRows(poolArray) {
  const rollingExclude = new Set();
  for (let i = 0; i < LINES; i++) {
    const list = pickUniqueRandom(poolArray, NOUNS_PER_LINE, rollingExclude);
    list.forEach(w => rollingExclude.add(w));
    if (rollingExclude.size > 300) {
      for (const w of Array.from(rollingExclude).slice(0, 120)) rollingExclude.delete(w);
    }
    nounLineEls[i]?.html(list.join(' • '));
  }
}

/* ===== Compose & Export ===== */
function valueAt(i, b) { return inputs?.[i]?.[b]?.elt?.value || ''; }

function composeLine(i) {
  const parts = [
    segments[i][0], valueAt(i, 0),
    segments[i][1], valueAt(i, 1),
    segments[i][2], valueAt(i, 2),
    segments[i][3]
  ];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function exportLinesArray() { return Array.from({ length: LINES }, (_, i) => composeLine(i)); }
function exportText() { return exportLinesArray().join('\n'); }

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ===== Buttons ===== */
async function onSave() {
  const text  = exportText();
  const lines = exportLinesArray();
  const ts    = Date.now();

  // Kick off Firebase save, but don't block the download
  const savePromise = (window.db
    ? window.db.ref('saves').push({ text, lines, segments, clientId, timestamp: ts })
    : Promise.resolve());

  // Always download (safe filename: no colons)
  try {
    downloadText(`fill-in-blanks-${stamp()}.txt`, text);
    setStatus('Downloaded text file.');
  } catch (e) {
    console.error('Download failed:', e);
    setStatus('Download failed. Check console.');
  }

  // Update status after Firebase attempt
  try {
    await savePromise;
    setStatus('Saved to Firebase and downloaded.');
  } catch (e) {
    console.error('Firebase save failed (download already done):', e);
    setStatus('Downloaded. Firebase save failed (check rules).');
  }
}

async function onReset() {
  if (!confirm('Reset all blanks? This clears local inputs and Firebase values.')) return;
  try {
    // local clear
    for (let i = 0; i < LINES; i++) {
      for (let b = 0; b < BLANKS_PER_LINE; b++) {
        inputs?.[i]?.[b]?.elt && (inputs[i][b].elt.value = '');
      }
    }
    // DB clear
    if (window.db) {
      const updates = {};
      for (let i = 0; i < LINES; i++) {
        for (let b = 0; b < BLANKS_PER_LINE; b++) {
          updates[pathFor(i, b)] = { value: '', editedBy: clientId, updatedAt: Date.now() };
        }
      }
      await window.db.ref().update(updates);
    }
    setStatus('All blanks reset.');
  } catch (e) {
    console.error(e);
    setStatus('Reset failed. Check console.');
  }
}

// Optional: expose for debugging
window.getAllBlanks = () => inputs.map(row => row.map(i => i.elt.value));
