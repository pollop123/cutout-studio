const state = {
  assets: [],
  activeId: null,
  erasing: false,
  drawing: false,
  history: [],
  future: [],
  modelReady: false,
};

const $ = (selector) => document.querySelector(selector);
const canvas = $('#editor-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const preview = $('#export-preview');
const previewCtx = preview.getContext('2d');

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function activeAsset() {
  return state.assets.find((asset) => asset.id === state.activeId) || null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function setCanvasImage(url, remember = true) {
  const image = await loadImage(url);
  const max = 1400;
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (remember) pushHistory();
  $('#canvas-empty').hidden = true;
  updatePreview();
}

function canvasData() {
  return canvas.toDataURL('image/png');
}

function updateHistoryControls() {
  $('#undo').disabled = state.history.length < 2;
  $('#redo').disabled = state.future.length === 0;
}

function pushHistory(clearFuture = true) {
  state.history.push(canvasData());
  if (state.history.length > 20) state.history.shift();
  if (clearFuture) state.future = [];
  updateHistoryControls();
}

async function selectAsset(id) {
  const asset = state.assets.find((item) => item.id === id);
  if (!asset) return;
  state.activeId = id;
  state.history = [];
  state.future = [];
  await setCanvasImage(asset.processed || asset.original);
  $('#active-name').textContent = asset.name;
  document.querySelectorAll('.asset-card').forEach((node) => node.classList.toggle('active', node.dataset.id === id));
  setControls(true);
}

function setControls(enabled) {
  ['#auto-remove', '#cleanup-mask', '#eraser-toggle', '#restore', '#center-subject', '#download'].forEach((selector) => {
    $(selector).disabled = !enabled || (selector === '#auto-remove' && !state.modelReady);
  });
}

function renderAssets() {
  const list = $('#asset-list');
  if (!state.assets.length) {
    list.innerHTML = '<div class="empty-state">尚未匯入素材</div>';
    setControls(false);
    return;
  }
  list.innerHTML = state.assets.map((asset) => `
    <button class="asset-card ${asset.id === state.activeId ? 'active' : ''}" data-id="${asset.id}" type="button">
      <img src="${asset.processed || asset.original}" alt="">
      <span>${asset.name}</span>
    </button>`).join('');
  list.querySelectorAll('.asset-card').forEach((node) => node.addEventListener('click', () => selectAsset(node.dataset.id)));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function importFiles(files) {
  const accepted = [...files].filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
  for (const file of accepted) {
    state.assets.push({ id: crypto.randomUUID(), name: file.name, original: await readFile(file), processed: null });
  }
  renderAssets();
  if (!state.activeId && state.assets[0]) await selectAsset(state.assets[0].id);
  toast(`已匯入 ${accepted.length} 張圖片`);
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    state.modelReady = Boolean(data.backgroundRemoval);
    const status = $('#model-status');
    status.className = `model-status ${state.modelReady ? 'ready' : 'error'}`;
    status.innerHTML = `<span></span>${state.modelReady ? `去背模型就緒 · ${data.model}` : '未安裝 rembg，可先手動修圖'}`;
    setControls(Boolean(activeAsset()));
  } catch {
    $('#model-status').className = 'model-status error';
    $('#model-status').innerHTML = '<span></span>無法連線本機服務';
  }
}

async function autoRemove() {
  const asset = activeAsset();
  if (!asset) return;
  const button = $('#auto-remove');
  button.disabled = true;
  button.textContent = '正在去背…';
  try {
    const response = await fetch('/api/remove-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: asset.original }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '去背失敗');
    asset.processed = data.image;
    state.history = [];
    state.future = [];
    await setCanvasImage(asset.processed);
    if ($('#cleanup-preset').value !== 'off') await applyMaskCleanup(true, false);
    renderAssets();
    toast($('#cleanup-preset').value === 'off' ? '自動去背完成' : '自動去背與遮罩清理完成');
  } catch (error) {
    toast(error.message);
  } finally {
    button.textContent = '自動去背';
    button.disabled = !state.modelReady;
  }
}

function cleanupSettings() {
  return {
    preset: $('#cleanup-preset').value,
    strength: Number($('#cleanup-strength').value),
  };
}

async function applyMaskCleanup(remember = true, notify = true) {
  if (!activeAsset()) return;
  const settings = cleanupSettings();
  if (settings.preset === 'off') {
    if (notify) toast('遮罩清理已關閉');
    return;
  }
  try {
    const response = await fetch('/api/clean-mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: canvasData(), ...settings }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '遮罩清理失敗');
    await setCanvasImage(data.image, remember);
    syncProcessed();
    if (notify) toast('已用共用引擎清理遮罩');
  } catch (error) {
    toast(error.message);
    throw error;
  }
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
  };
}

function erase(event) {
  if (!state.erasing || !state.drawing) return;
  const point = pointerPosition(event);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(point.x, point.y, Number($('#brush-size').value) / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  updatePreview();
}

function alphaBounds(sourceCanvas) {
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = sourceCanvas;
  const data = sourceCtx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function subjectComponents(sourceCanvas) {
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = sourceCanvas;
  const data = sourceCtx.getImageData(0, 0, width, height).data;
  const total = width * height;
  const visited = new Uint8Array(total);
  const components = [];
  const minArea = Math.max(20, Math.round(total * 0.00035));
  const stack = [];

  for (let start = 0; start < total; start += 1) {
    if (visited[start] || data[start * 4 + 3] <= 10) continue;
    let minX = width, minY = height, maxX = -1, maxY = -1, area = 0;
    let sumX = 0, sumY = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= total || visited[next]) continue;
        if ((next === index - 1 && x === 0) || (next === index + 1 && x === width - 1)) continue;
        if (data[next * 4 + 3] <= 10) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (area >= minArea) {
      components.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area,
        cx: sumX / area,
        cy: sumY / area,
      });
    }
  }
  return components.sort((a, b) => b.area - a.area);
}

function selectedSubjectBounds(sourceCanvas) {
  const components = subjectComponents(sourceCanvas);
  if (!components.length) return { bounds: alphaBounds(sourceCanvas), count: 0, kept: 0 };
  const mode = $('#subject-mode').value;
  let selected = components;
  if (mode === 'largest') {
    selected = components.slice(0, 1);
  } else if (mode === 'top2') {
    selected = components.slice(0, 2);
  } else if (mode === 'center') {
    const centerX = sourceCanvas.width / 2;
    const centerY = sourceCanvas.height / 2;
    selected = [components.reduce((best, component) => {
      const bestScore = Math.hypot(best.cx - centerX, best.cy - centerY);
      const score = Math.hypot(component.cx - centerX, component.cy - centerY);
      return score < bestScore ? component : best;
    })];
  }
  const minX = Math.min(...selected.map((item) => item.x));
  const minY = Math.min(...selected.map((item) => item.y));
  const maxX = Math.max(...selected.map((item) => item.x + item.width - 1));
  const maxY = Math.max(...selected.map((item) => item.y + item.height - 1));
  return {
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    count: components.length,
    kept: selected.length,
  };
}

function updatePreview() {
  if (!activeAsset()) return;
  const width = Math.max(16, Math.min(4096, Number($('#output-width').value) || 240));
  const height = Math.max(16, Math.min(4096, Number($('#output-height').value) || 240));
  const padding = Number($('#padding').value) / 100;
  preview.width = width;
  preview.height = height;
  previewCtx.clearRect(0, 0, width, height);
  const analysis = selectedSubjectBounds(canvas);
  const bounds = analysis.bounds || { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const availableW = width * (1 - padding * 2);
  const availableH = height * (1 - padding * 2);
  const scale = Math.min(availableW / bounds.width, availableH / bounds.height);
  const drawW = bounds.width * scale;
  const drawH = bounds.height * scale;
  previewCtx.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
  $('#padding-value').textContent = `${Math.round(padding * 100)}%`;
  $('#export-meta').textContent = `${width} × ${height} PNG`;
  $('#subject-stats').textContent = analysis.count
    ? `偵測到 ${analysis.count} 個主體區塊，目前保留 ${analysis.kept} 個`
    : '未偵測到透明前景，將使用整張圖';
}

function syncProcessed() {
  const asset = activeAsset();
  if (!asset) return;
  asset.processed = canvasData();
  renderAssets();
}

$('#file-input').addEventListener('change', (event) => importFiles(event.target.files));
const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
dropzone.addEventListener('drop', (event) => importFiles(event.dataTransfer.files));
$('#clear-all').addEventListener('click', () => { state.assets = []; state.activeId = null; state.history = []; state.future = []; ctx.clearRect(0, 0, canvas.width, canvas.height); $('#canvas-empty').hidden = false; renderAssets(); updatePreview(); updateHistoryControls(); });
$('#auto-remove').addEventListener('click', autoRemove);
$('#cleanup-mask').addEventListener('click', () => applyMaskCleanup());
$('#eraser-toggle').addEventListener('click', () => { state.erasing = !state.erasing; $('#eraser-toggle').textContent = `橡皮擦：${state.erasing ? '開' : '關'}`; $('#eraser-toggle').classList.toggle('primary', state.erasing); });
canvas.addEventListener('pointerdown', (event) => { if (!state.erasing) return; state.drawing = true; canvas.setPointerCapture(event.pointerId); erase(event); });
canvas.addEventListener('pointermove', erase);
canvas.addEventListener('pointerup', () => { if (!state.drawing) return; state.drawing = false; pushHistory(); syncProcessed(); });
async function undoEdit() {
  if (state.history.length < 2) return;
  state.future.push(state.history.pop());
  await setCanvasImage(state.history[state.history.length - 1], false);
  syncProcessed(); updateHistoryControls();
}
async function redoEdit() {
  if (!state.future.length) return;
  const next = state.future.pop();
  state.history.push(next);
  await setCanvasImage(next, false);
  syncProcessed(); updateHistoryControls();
}
$('#undo').addEventListener('click', undoEdit);
$('#redo').addEventListener('click', redoEdit);
$('#restore').addEventListener('click', async () => { const asset = activeAsset(); if (!asset) return; asset.processed = null; state.history = []; state.future = []; await setCanvasImage(asset.original); renderAssets(); updateHistoryControls(); toast('已回到原圖'); });
$('#presets').addEventListener('click', (event) => { const button = event.target.closest('button[data-w]'); if (!button) return; $('#output-width').value = button.dataset.w; $('#output-height').value = button.dataset.h; updatePreview(); });
['#output-width', '#output-height', '#padding', '#subject-mode'].forEach((selector) => $(selector).addEventListener('input', updatePreview));
['#cleanup-preset', '#cleanup-strength'].forEach((selector) => $(selector).addEventListener('input', () => {
  $('#cleanup-value').textContent = `${$('#cleanup-strength').value}%`;
}));
$('#center-subject').addEventListener('click', () => { updatePreview(); toast('已依透明邊界置中主體'); });
$('#download').addEventListener('click', () => { const asset = activeAsset(); if (!asset) return; updatePreview(); const link = document.createElement('a'); const stem = asset.name.replace(/\.[^.]+$/, ''); link.download = `${stem}-cutout-${preview.width}x${preview.height}.png`; link.href = preview.toDataURL('image/png'); link.click(); });
window.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  if (event.shiftKey) redoEdit(); else undoEdit();
});

checkHealth();
renderAssets();
