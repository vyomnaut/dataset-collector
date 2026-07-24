/* ============================================================
   CONFIG — fill these in before deploying. See README.md.
   ============================================================ */
const CONFIG = {
  CLIENT_ID: '480566143155-ki759g4c6eqn8letge76ret9ak71jd00.apps.googleusercontent.com',
  ROOT_FOLDER_NAME: 'ImageDataset',        // top-level Drive folder, auto-created (used only if SHARED_MODE is false)
  CATEGORIES: ['small_object', 'occluded_image'],
  MIN_WIDTH: 480,
  MIN_HEIGHT: 480,
  BLUR_VARIANCE_THRESHOLD: 55,             // lower = stricter about blur; tune against your camera
  REVIEWER_PASSCODE: 'changeme',           // change this before sharing the app

  // SHARED_MODE: when true, every signed-in user (regardless of whose Google
  // account they use) uploads into the SAME fixed set of folders below,
  // instead of each person getting their own personal ImageDataset folder.
  // See README.md "Shared team Drive setup" for how to get these folder IDs.
  SHARED_MODE: true,
  FIXED_FOLDER_IDS: {
    pending: { small_object: '1t2_BMjVoSGEYKSAS77I218p1A41bsqmT', occluded_image: '18YSVL24Dljy4K1gG-g0l8ca3oz4MJmcG' },
    approved: { small_object: '1bRZwc-Ef9NPjfVAKf8Bx_DgeZEgae0Gm', occluded_image: '1mvCq4fw5A4yXC6KOd9qr-Yoz42LQHPt3' },
    rejected: '1D2_MERX6pJzemivzXnCBYyKKMc_m3QJv'
  }
};

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/* ============================================================
   STATE
   ============================================================ */
let accessToken = null;
let tokenClient = null;
let folderCache = {};        // name -> folderId
let currentFile = null;
let currentChecks = { res: null, blur: null, dup: null };
let currentHash = null;
let reviewCategory = 'small_object';
let fileQueue = [];

/* ============================================================
   IndexedDB — local hash history (duplicate check) + offline queue
   ============================================================ */
let db;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dataset-collector', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('hashes')) d.createObjectStore('hashes', { keyPath: 'hash' });
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function idbAdd(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).add(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   AUTH (Google Identity Services)
   ============================================================ */
function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: async (resp) => {
      if (resp.error) { showToast('Sign-in failed: ' + resp.error); return; }
      accessToken = resp.access_token;
      $('signInBtn').classList.add('hidden');
      $('userChip').classList.remove('hidden');
      $('userEmail').textContent = 'Connected';
      await ensureRootFolders();
      processQueue();
    }
  });
}

$('signInBtn').addEventListener('click', () => tokenClient.requestAccessToken());
$('signOutBtn').addEventListener('click', () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  $('signInBtn').classList.remove('hidden');
  $('userChip').classList.add('hidden');
});

/* ============================================================
   DRIVE HELPERS
   ============================================================ */
async function driveFetch(url, options = {}) {
  options.headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + accessToken });
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('Drive API error: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

async function findOrCreateFolder(name, parentId) {
  const cacheKey = parentId + '/' + name;
  if (folderCache[cacheKey]) return folderCache[cacheKey];

  let q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  q += parentId ? ` and '${parentId}' in parents` : ` and 'root' in parents`;
  const list = await driveFetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (list.files && list.files.length) {
    folderCache[cacheKey] = list.files[0].id;
    return list.files[0].id;
  }
  const metadata = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const created = await driveFetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  });
  folderCache[cacheKey] = created.id;
  return created.id;
}

let folderIds = { root: null, pending: {}, approved: {}, rejected: null };

async function ensureRootFolders() {
  if (CONFIG.SHARED_MODE) {
    folderIds.pending = CONFIG.FIXED_FOLDER_IDS.pending;
    folderIds.approved = CONFIG.FIXED_FOLDER_IDS.approved;
    folderIds.rejected = CONFIG.FIXED_FOLDER_IDS.rejected;
    return;
  }
  folderIds.root = await findOrCreateFolder(CONFIG.ROOT_FOLDER_NAME, null);
  const pendingRoot = await findOrCreateFolder('pending_review', folderIds.root);
  const approvedRoot = await findOrCreateFolder('approved', folderIds.root);
  folderIds.rejected = await findOrCreateFolder('rejected', folderIds.root);
  for (const cat of CONFIG.CATEGORIES) {
    folderIds.pending[cat] = await findOrCreateFolder(cat, pendingRoot);
    folderIds.approved[cat] = await findOrCreateFolder(cat, approvedRoot);
  }
}

async function uploadToDrive(blob, filename, parentId) {
  const metadata = { name: filename, parents: [parentId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const res = await fetch(DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
    body: form
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status);
  return res.json();
}

async function moveFile(fileId, fromParentId, toParentId) {
  const url = `${DRIVE_FILES_URL}/${fileId}?addParents=${toParentId}&removeParents=${fromParentId}`;
  return driveFetch(url, { method: 'PATCH' });
}

/* ============================================================
   IMAGE CHECKS
   ============================================================ */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function toCanvas(img, maxDim = 256) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

// Laplacian-variance style sharpness estimate on a downsized grayscale image
function blurScore(canvas) {
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap = -4 * gray[idx] + gray[idx - 1] + gray[idx + 1] + gray[idx - width] + gray[idx + width];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean; // variance
}

// 8x8 average hash for near-duplicate detection
function averageHash(canvas) {
  const small = document.createElement('canvas');
  small.width = 8; small.height = 8;
  small.getContext('2d').drawImage(canvas, 0, 0, 8, 8);
  const { data } = small.getContext('2d').getImageData(0, 0, 8, 8);
  const gray = [];
  for (let i = 0; i < 64; i++) {
    gray.push(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  }
  const avg = gray.reduce((a, b) => a + b, 0) / 64;
  let hash = '';
  for (let i = 0; i < 64; i++) hash += gray[i] >= avg ? '1' : '0';
  return hash;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function isDuplicate(hash) {
  const all = await idbAll('hashes');
  for (const entry of all) {
    if (hammingDistance(entry.hash, hash) <= 4) return true; // near-duplicate threshold
  }
  return false;
}

/* ============================================================
   UI WIRING — Collect view
   ============================================================ */
function $(id) { return document.getElementById(id); }

$('previewWrap').addEventListener('click', () => $('fileInput').click());
$('retakeBtn').addEventListener('click', () => $('fileInput').click());

$('fileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  fileQueue = files;
  await processNextInQueue();
});

async function processNextInQueue() {
  if (!fileQueue.length) { resetCollectView(); return; }
  const file = fileQueue.shift();
  currentFile = file;
  await runChecksAndShow(file);
}

async function runChecksAndShow(file) {
  $('previewImg').src = URL.createObjectURL(file);
  $('previewImg').classList.remove('hidden');
  $('previewPlaceholder').classList.add('hidden');
  $('checksPanel').classList.remove('hidden');
  $('categoryRow').classList.add('hidden');
  $('retakeBtn').classList.remove('hidden');
  setCheckRow('checkRes', 'pending');
  setCheckRow('checkBlur', 'pending');
  setCheckRow('checkDup', 'pending');
  $('statusLine').textContent = 'Checking image…';

  const img = await loadImage(file);
  const resOk = img.naturalWidth >= CONFIG.MIN_WIDTH && img.naturalHeight >= CONFIG.MIN_HEIGHT;
  setCheckRow('checkRes', resOk ? 'pass' : 'warn',
    `${img.naturalWidth}×${img.naturalHeight}`);

  const canvas = toCanvas(img);
  const sharpness = blurScore(canvas);
  const blurOk = sharpness >= CONFIG.BLUR_VARIANCE_THRESHOLD;
  setCheckRow('checkBlur', blurOk ? 'pass' : 'warn', sharpness.toFixed(0));

  currentHash = averageHash(canvas);
  const dup = await isDuplicate(currentHash);
  setCheckRow('checkDup', dup ? 'warn' : 'pass', dup ? 'looks similar to a previous upload' : 'no match found');

  currentChecks = { res: resOk, blur: blurOk, dup: !dup };
  $('categoryRow').classList.remove('hidden');
  $('statusLine').textContent = 'Choose a category to upload.' +
    (fileQueue.length ? ` (${fileQueue.length} more in this batch)` : '');
}

function setCheckRow(id, state, detail) {
  const row = $(id);
  const dot = row.querySelector('.dot');
  dot.className = 'dot ' + state;
  const base = row.querySelector('.check-label').dataset.base || row.querySelector('.check-label').textContent;
  row.querySelector('.check-label').dataset.base = base;
  row.querySelector('.check-label').textContent = detail ? `${base} — ${detail}` : base;
}

document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => handleCategoryPick(btn.dataset.category));
});

function handleCategoryPick(category) {
  const problems = [];
  if (!currentChecks.res) problems.push('Resolution is below the minimum — the object may be hard to see.');
  if (!currentChecks.blur) problems.push('Image looks blurry.');
  if (!currentChecks.dup) problems.push('This looks like a near-duplicate of something already uploaded.');

  if (problems.length) {
    showWarnModal(problems, () => submitImage(category));
  } else {
    submitImage(category);
  }
}

function showWarnModal(problems, onUploadAnyway) {
  const list = $('warnList');
  list.innerHTML = '';
  problems.forEach(p => { const li = document.createElement('li'); li.textContent = p; list.appendChild(li); });
  $('warnModal').classList.remove('hidden');
  $('warnRetake').onclick = () => { $('warnModal').classList.add('hidden'); $('fileInput').click(); };
  $('warnUploadAnyway').onclick = () => { $('warnModal').classList.add('hidden'); onUploadAnyway(); };
}

async function submitImage(category) {
  const file = currentFile;
  const hash = currentHash;
  const filename = `${category}_${Date.now()}.jpg`;

  if (!accessToken || !navigator.onLine) {
    await idbAdd('queue', { file, filename, category, ts: Date.now() });
    await idbAdd('hashes', { hash, ts: Date.now() }).catch(() => {});
    updateQueueBadge();
    showToast(accessToken ? 'Offline — saved to upload queue' : 'Sign in to upload — saved to queue');
  } else {
    try {
      await uploadToDrive(file, filename, folderIds.pending[category]);
      await idbAdd('hashes', { hash, ts: Date.now() }).catch(() => {});
      showToast(`Uploaded to pending_review/${category}`);
    } catch (err) {
      await idbAdd('queue', { file, filename, category, ts: Date.now() });
      updateQueueBadge();
      showToast('Upload failed — saved to queue for retry');
    }
  }

  await processNextInQueue();
}

function resetCollectView() {
  currentFile = null;
  $('previewImg').classList.add('hidden');
  $('previewPlaceholder').classList.remove('hidden');
  $('checksPanel').classList.add('hidden');
  $('categoryRow').classList.add('hidden');
  $('retakeBtn').classList.add('hidden');
  $('fileInput').value = '';
  $('statusLine').textContent = '';
}

/* ============================================================
   OFFLINE QUEUE
   ============================================================ */
async function updateQueueBadge() {
  const all = await idbAll('queue');
  const badge = $('queueBadge');
  if (all.length) { badge.textContent = `${all.length} queued`; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

async function processQueue() {
  if (!accessToken || !navigator.onLine) return;
  const all = await idbAll('queue');
  for (const item of all) {
    try {
      await uploadToDrive(item.file, item.filename, folderIds.pending[item.category]);
      await idbDelete('queue', item.id);
    } catch (e) { /* stop on first failure, retry later */ break; }
  }
  updateQueueBadge();
}
window.addEventListener('online', processQueue);

/* ============================================================
   MODE SWITCH
   ============================================================ */
$('modeCollect').addEventListener('click', () => switchMode('collect'));
$('modeReview').addEventListener('click', () => switchMode('review'));

function switchMode(mode) {
  $('modeCollect').classList.toggle('active', mode === 'collect');
  $('modeReview').classList.toggle('active', mode === 'review');
  $('collectView').classList.toggle('hidden', mode !== 'collect');
  $('reviewView').classList.toggle('hidden', mode !== 'review');
}

/* ============================================================
   REVIEW VIEW
   ============================================================ */
$('passcodeSubmit').addEventListener('click', () => {
  if ($('passcodeInput').value === CONFIG.REVIEWER_PASSCODE) {
    $('passcodeGate').classList.add('hidden');
    $('reviewBoard').classList.remove('hidden');
    loadReviewGrid();
  } else {
    showToast('Wrong passcode');
  }
});

document.querySelectorAll('.review-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.review-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    reviewCategory = tab.dataset.category;
    loadReviewGrid();
  });
});

async function loadReviewGrid() {
  if (!accessToken) { showToast('Sign in first'); return; }
  const grid = $('reviewGrid');
  grid.innerHTML = '';
  const q = `'${folderIds.pending[reviewCategory]}' in parents and trashed=false`;
  const list = await driveFetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,thumbnailLink,webContentLink)`);
  $('reviewEmpty').classList.toggle('hidden', list.files && list.files.length > 0);
  (list.files || []).forEach(f => grid.appendChild(buildReviewItem(f)));
}

function buildReviewItem(file) {
  const div = document.createElement('div');
  div.className = 'review-item';
  const img = document.createElement('img');
  img.src = file.thumbnailLink || '';
  img.alt = file.name;
  const actions = document.createElement('div');
  actions.className = 'review-actions';
  const approve = document.createElement('button');
  approve.className = 'approve-btn'; approve.textContent = 'Approve';
  approve.onclick = async () => {
    await moveFile(file.id, folderIds.pending[reviewCategory], folderIds.approved[reviewCategory]);
    div.remove();
  };
  const reject = document.createElement('button');
  reject.className = 'reject-btn'; reject.textContent = 'Reject';
  reject.onclick = async () => {
    await moveFile(file.id, folderIds.pending[reviewCategory], folderIds.rejected);
    div.remove();
  };
  actions.append(approve, reject);
  div.append(img, actions);
  return div;
}

/* ============================================================
   MISC
   ============================================================ */
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ============================================================
   INIT
   ============================================================ */
window.addEventListener('load', async () => {
  await openDb();
  updateQueueBadge();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const waitForGis = setInterval(() => {
    if (window.google && google.accounts) {
      clearInterval(waitForGis);
      initGis();
    }
  }, 100);
});
