const packState = {
  mode: new URLSearchParams(location.search).get('mode') === 'emoji' ? 'emoji' : 'sticker',
  sources: [],
  items: [],
  count: 8,
  selected: 0,
  processed: {},
  processedModes: {},
  cutoutQuality: {},
  analysis: {},
  modelReady: false,
  cutoutMode: 'draft',
  batchController: null,
  ready: false,
};

const STICKER_CAPTIONS = ['嗨！', '收到', '謝謝', '好喔', '讚啦', '辛苦了', '加油', '掰掰'];
const DEFAULT_CROP_ZOOM = 0.94;

const packImageCache = new Map();
const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function packToast(message) {
  const toast = $('#pack-toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(packToast.timer);
  packToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function loadPackImage(url) {
  if (packImageCache.has(url)) return packImageCache.get(url);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
  packImageCache.set(url, promise);
  return promise;
}

function blankItem() {
  return {
    imageName: null,
    caption: '',
    captionColor: '#111111',
    outlineColor: '#ffffff',
    captionSize: packState.mode === 'emoji' ? 30 : 42,
    captionLayout: 'auto',
    subjectType: 'auto',
    faces: [],
    selectedFaceIndices: null,
    isolatedUrl: null,
    isolationMode: null,
    isolationReport: null,
    focusFace: true,
    subjectOutline: true,
    subjectOutlineWidth: packState.mode === 'emoji' ? 4 : 8,
    face: null,
    quality: null,
    offsetX: 0,
    offsetY: 0,
    zoom: DEFAULT_CROP_ZOOM,
  };
}

function sourceById(id) {
  return packState.sources.find(source => source.id === id) || null;
}

function sourceUrl(id) {
  return sourceById(id)?.url || `/${encodeURIComponent(id)}`;
}

function sourceName(id) {
  return sourceById(id)?.name || id;
}

function confidentHumanFace(face) {
  return Boolean(face && (face.score === undefined || Number(face.score) >= 0.85));
}

function resolvedSubjectType(item) {
  if (item.subjectType === 'person' || item.subjectType === 'pet') return item.subjectType;
  return confidentHumanFace(item.face) ? 'person' : 'pet';
}

function itemFaceCandidates(item) {
  const stored = Array.isArray(item?.faces) && item.faces.length ? item.faces : packState.analysis[item?.imageName]?.faces;
  return (stored || []).filter(confidentHumanFace);
}

function selectedItemFaces(item) {
  const faces = itemFaceCandidates(item);
  if (!faces.length) return confidentHumanFace(item?.face) ? [item.face] : [];
  if (!Array.isArray(item.selectedFaceIndices)) return faces;
  const selected = item.selectedFaceIndices.filter(index => Number.isInteger(index) && faces[index]);
  return (selected.length ? selected : faces.map((_, index) => index)).map(index => faces[index]);
}

function selectedItemFaceIndices(item) {
  const faces = itemFaceCandidates(item);
  if (!Array.isArray(item.selectedFaceIndices)) return faces.map((_, index) => index);
  const selected = item.selectedFaceIndices.filter(index => Number.isInteger(index) && faces[index]);
  return selected.length ? selected : faces.map((_, index) => index);
}

function autosaveKey() {
  return `line-pack-autosave-v2-${packState.mode}`;
}

function autosavePayload() {
  return {
    format: 'line-pack-autosave', version: 2, mode: packState.mode,
    count: packState.count, selected: packState.selected, items: packState.items,
    cutoutMode: packState.cutoutMode, cutoutQuality: packState.cutoutQuality, savedAt: new Date().toISOString(),
  };
}

function saveAutosave() {
  if (!packState.ready) return;
  localStorage.setItem(autosaveKey(), JSON.stringify(autosavePayload()));
  $('#autosave-status').textContent = `已自動儲存 · ${new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
}

function scheduleAutosave() {
  if (!packState.ready) return;
  $('#autosave-status').textContent = '儲存中…';
  clearTimeout(scheduleAutosave.timer);
  scheduleAutosave.timer = setTimeout(saveAutosave, 350);
}

async function hydrateCachedCutouts() {
  const names = [...new Set(packState.items.map(item => item.imageName).filter(Boolean))];
  await Promise.all(names.map(async name => {
    try {
      const response = await fetch(`/api/cutout-cache?asset=${encodeURIComponent(name)}&mode=${packState.cutoutMode}`);
      const data = await response.json();
      if (data.cached && data.url) {
        packState.processed[name] = data.url;
        packState.processedModes[name] = packState.cutoutMode;
        if (data.quality) packState.cutoutQuality[name] = data.quality;
      }
      if (packState.cutoutMode === 'draft' && data.quality?.risk === 'high') {
        const qualityResponse = await fetch(`/api/cutout-cache?asset=${encodeURIComponent(name)}&mode=quality`);
        const qualityData = await qualityResponse.json();
        if (qualityData.cached && qualityData.url) {
          packState.processed[name] = qualityData.url;
          packState.processedModes[name] = 'quality';
          packState.cutoutQuality[name] = { ...(qualityData.quality || data.quality), autoUpgraded: true };
        }
      }
    } catch { /* Cache hydration is best effort. */ }
  }));
}

async function restoreAutosave() {
  const raw = localStorage.getItem(autosaveKey());
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 2 || saved.mode !== packState.mode) return false;
    const validIds = new Set(packState.sources.map(source => source.id));
    packState.count = Number(saved.count) || 8;
    packState.items = (saved.items || []).slice(0, packState.count).map(item => ({
      ...blankItem(), ...item, imageName: validIds.has(item.imageName) ? item.imageName : null,
    }));
    while (packState.items.length < packState.count) packState.items.push(blankItem());
    packState.selected = Math.max(0, Math.min(packState.count - 1, Number(saved.selected) || 0));
    packState.cutoutMode = saved.cutoutMode === 'quality' ? 'quality' : 'draft';
    packState.cutoutQuality = saved.cutoutQuality && typeof saved.cutoutQuality === 'object' ? saved.cutoutQuality : {};
    $('#cutout-mode').value = packState.cutoutMode;
    await hydrateCachedCutouts();
    $('#autosave-status').textContent = `已復原 ${new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit' }).format(new Date(saved.savedAt))}`;
    return true;
  } catch {
    localStorage.removeItem(autosaveKey());
    return false;
  }
}

function resizeItems(count) {
  const existing = packState.items.slice(0, count);
  while (existing.length < count) existing.push(blankItem());
  packState.items = existing;
  packState.count = count;
  packState.selected = Math.min(packState.selected, count - 1);
  renderPackWorkspace();
}

function configurePackMode() {
  const sticker = packState.mode === 'sticker';
  document.body.classList.toggle('emoji-mode', !sticker);
  $('#mode-sticker').classList.toggle('active', sticker);
  $('#mode-emoji').classList.toggle('active', !sticker);
  $('#pack-title').textContent = sticker ? '靜態貼圖組' : '表情貼組';
  $('#pack-guideline').textContent = sticker
    ? '一般圖 370×320、主圖 240×240、標籤 96×74，圖案四周保留約 10px'
    : '內容圖 180×180、標籤 96×74，建議滿版並使用粗線條';
  const counts = sticker ? [8, 16, 24, 32, 40] : Array.from({ length: 33 }, (_, index) => index + 8);
  $('#pack-count').innerHTML = counts.map(count => `<option value="${count}">${count}</option>`).join('');
  $('#pack-count').value = String(packState.count);
  $('#caption-size').min = sticker ? '18' : '14';
  $('#caption-size').max = sticker ? '72' : '42';
  $('#auto-caption-field').hidden = !sticker;
  $('#caption-layout-field').hidden = !sticker;
}

async function initializePacks() {
  configurePackMode();
  resizeItems(8);
  const [imagesResponse, healthResponse, analysisResponse] = await Promise.all([
    fetch('/api/images'), fetch('/api/health'), fetch('/api/analyze-images'),
  ]);
  const imageData = await imagesResponse.json();
  const health = await healthResponse.json();
  const analysisData = await analysisResponse.json();
  packState.sources = imageData.assets || (imageData.images || []).map(name => ({ id: name, name, url: `/${encodeURIComponent(name)}` }));
  packState.analysis = Object.fromEntries(prepareAnalysis(analysisData.images || []).map(record => [record.id || record.name, record]));
  packState.modelReady = Boolean(health.backgroundRemoval);
  $('#engine-status').textContent = packState.modelReady
    ? `AI 去背 ${health.model} · 人臉分析就緒`
    : '未安裝去背模型';
  $('#batch-cutout').disabled = !packState.modelReady;
  $('#auto-build').disabled = !packState.modelReady;
  renderPackSources();
  await restoreAutosave();
  packState.ready = true;
  renderPackWorkspace();
}

function renderPackSources() {
  $('#source-count').textContent = packState.sources.length;
  $('#pack-source-list').innerHTML = packState.sources.map(source => `
    <button class="pack-source" data-source="${escapeHtml(source.id)}">
      <img src="${escapeHtml(source.url)}" alt=""><strong title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</strong><span>＋</span>
    </button>`).join('');
  document.querySelectorAll('.pack-source').forEach(button => button.addEventListener('click', () => addSourceToPack(button.dataset.source)));
}

async function importPackFiles(files) {
  const accepted = [...files].filter(file => /^image\/(png|jpeg|webp)$/.test(file.type));
  if (!accepted.length) { packToast('沒有可匯入的 JPG、PNG 或 WebP'); return; }
  let added = 0;
  for (let index = 0; index < accepted.length; index += 1) {
    const file = accepted[index];
    $('#import-status').textContent = `匯入 ${index + 1}/${accepted.length}：${file.name}`;
    try {
      const response = await fetch('/api/import-image', {
        method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '匯入失敗');
      if (!sourceById(data.asset.id)) { packState.sources.push(data.asset); added += 1; }
      const prepared = prepareAnalysis([data.analysis])[0];
      packState.analysis[data.asset.id] = prepared;
    } catch (error) {
      packToast(`${file.name}：${error.message}`);
    }
  }
  packState.sources.sort((left, right) => left.name.localeCompare(right.name, 'zh-TW'));
  renderPackSources();
  $('#import-status').textContent = `已匯入 ${added} 張，重複素材會自動沿用`;
  packToast(`素材庫已加入 ${added} 張圖片`);
}

function addSourceToPack(imageName) {
  let index = packState.items.findIndex(item => !item.imageName);
  if (index < 0) index = packState.selected;
  const analysis = packState.analysis[imageName];
  packState.items[index] = {
    ...packState.items[index],
    imageName,
    face: analysis?.detectedFace || analysis?.primaryFace || null,
    faces: analysis?.faces || [],
    selectedFaceIndices: null,
    quality: analysis ? { faceCount: analysis.faces?.length || 0, faceArea: analysis.faceArea || 0, strict: false } : null,
  };
  packState.selected = index;
  renderPackWorkspace();
}

function itemSource(item) {
  const isolated = resolvedSubjectType(item) === 'person' && item.isolatedUrl && item.isolationMode === packState.processedModes[item.imageName] ? item.isolatedUrl : null;
  return isolated || packState.processed[item.imageName] || (item.imageName ? sourceUrl(item.imageName) : null);
}

async function isolateSelectedPeople(item, signal = null) {
  const faces = itemFaceCandidates(item);
  const selected = selectedItemFaceIndices(item);
  const mode = packState.processedModes[item.imageName];
  if (faces.length < 2 || selected.length === faces.length) {
    item.isolatedUrl = null;
    item.isolationMode = null;
    item.isolationReport = null;
    return true;
  }
  if (!packState.processed[item.imageName] || !mode) {
    item.isolatedUrl = null;
    item.isolationMode = null;
    item.isolationReport = { pending: true, removed: faces.length - selected.length };
    return true;
  }
  const response = await fetch('/api/isolate-people', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ assetId: item.imageName, mode, faces, selected }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '人物分割失敗');
  item.isolatedUrl = data.url;
  item.isolationMode = mode;
  item.isolationReport = data.report || { removed: faces.length - selected.length };
  return true;
}

function alphaBounds(canvas, scanMinY = 0, scanMaxY = canvas.height) {
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
  let hasTransparency = false;
  const scanTop = Math.max(0, Math.floor(scanMinY));
  const scanBottom = Math.min(canvas.height, Math.ceil(scanMaxY));
  for (let y = scanTop; y < scanBottom; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      if (alpha < 245) hasTransparency = true;
      if (alpha > 10) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, hasTransparency };
}

function clampCrop(centerX, centerY, width, height, sourceWidth, sourceHeight) {
  const shrink = Math.min(1, sourceWidth / width, sourceHeight / height);
  const cropWidth = width * shrink;
  const cropHeight = height * shrink;
  return {
    x: Math.max(0, Math.min(sourceWidth - cropWidth, centerX - cropWidth / 2)),
    y: Math.max(0, Math.min(sourceHeight - cropHeight, centerY - cropHeight / 2)),
    width: cropWidth,
    height: cropHeight,
  };
}

function faceCrop(item, sourceWidth, sourceHeight, targetRatio) {
  if (!item.focusFace || resolvedSubjectType(item) !== 'person') return null;
  const faces = selectedItemFaces(item);
  if (!faces.length) return null;
  const face = faces[0];
  const emoji = packState.mode === 'emoji';
  // Face detectors frame the eyes, nose and mouth rather than the full hairstyle.
  // Keep roughly half a face-height above the detected box so hair, hats and
  // costume hoods survive the automatic crop.
  if (faces.length === 1) {
    const cropHeight = face.height * (emoji ? 2 : 2.2);
    const cropWidth = Math.max(face.width * (emoji ? 1.8 : 1.9), cropHeight * targetRatio);
    const centerX = face.x + face.width / 2;
    const centerY = face.y + face.height * (emoji ? 0.5 : 0.58);
    return clampCrop(centerX, centerY, cropWidth, cropWidth / targetRatio, sourceWidth, sourceHeight);
  }
  const left = Math.min(...faces.map(candidate => candidate.x));
  const top = Math.min(...faces.map(candidate => candidate.y));
  const right = Math.max(...faces.map(candidate => candidate.x + candidate.width));
  const bottom = Math.max(...faces.map(candidate => candidate.y + candidate.height));
  const maxFaceWidth = Math.max(...faces.map(candidate => candidate.width));
  const maxFaceHeight = Math.max(...faces.map(candidate => candidate.height));
  const cropHeight = Math.max(bottom - top + maxFaceHeight * (emoji ? 1.05 : 1.2), maxFaceHeight * (emoji ? 2 : 2.2));
  const cropWidth = Math.max(right - left + maxFaceWidth * 0.7, cropHeight * targetRatio);
  const centerX = (left + right) / 2;
  const centerY = top + (bottom - top) / 2 + maxFaceHeight * (emoji ? 0.02 : 0.08);
  return clampCrop(centerX, centerY, cropWidth, cropWidth / targetRatio, sourceWidth, sourceHeight);
}

function connectedHeadBounds(canvas, face, maxY) {
  const sampleScale = Math.min(1, 320 / canvas.width);
  const sample = document.createElement('canvas');
  sample.width = Math.max(1, Math.round(canvas.width * sampleScale));
  sample.height = Math.max(1, Math.round(canvas.height * sampleScale));
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const width = sample.width;
  const height = Math.min(sample.height, Math.ceil(maxY * sampleScale));
  const visible = index => pixels[index * 4 + 3] > 24;
  const seedX = Math.max(0, Math.min(width - 1, Math.round((face.x + face.width / 2) * sampleScale)));
  const seedY = Math.max(0, Math.min(height - 1, Math.round((face.y + face.height / 2) * sampleScale)));
  let seed = seedY * width + seedX;
  if (!visible(seed)) {
    const radius = Math.max(4, Math.ceil(face.width * sampleScale * 0.55));
    let nearest = null;
    let nearestDistance = Infinity;
    for (let y = Math.max(0, seedY - radius); y <= Math.min(height - 1, seedY + radius); y += 1) {
      for (let x = Math.max(0, seedX - radius); x <= Math.min(width - 1, seedX + radius); x += 1) {
        const index = y * width + x;
        if (!visible(index)) continue;
        const distance = (x - seedX) ** 2 + (y - seedY) ** 2;
        if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
      }
    }
    if (nearest === null) return null;
    seed = nearest;
  }

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let start = 0, end = 0;
  queue[end++] = seed;
  visited[seed] = 1;
  let minX = width, minY = height, maxX = -1, maxVisibleY = -1;
  while (start < end) {
    const index = queue[start++];
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxVisibleY = Math.max(maxVisibleY, y);
    for (let dy = -1; dy <= 1; dy += 1) {
      const nextY = y + dy;
      if (nextY < 0 || nextY >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        if (nextX < 0 || nextX >= width) continue;
        const next = nextY * width + nextX;
        if (!visited[next] && visible(next)) {
          visited[next] = 1;
          queue[end++] = next;
        }
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x: minX / sampleScale,
    y: minY / sampleScale,
    width: (maxX - minX + 1) / sampleScale,
    height: (maxVisibleY - minY + 1) / sampleScale,
  };
}

function protectHeadContour(bounds, headBounds, face, targetRatio, sourceWidth, sourceHeight) {
  if (!bounds || !headBounds || !face) return bounds;
  const margin = Math.max(4, face.height * 0.08);
  const required = {
    left: Math.max(0, Math.min(bounds.x, headBounds.x - margin)),
    top: Math.max(0, Math.min(bounds.y, headBounds.y - margin)),
    right: Math.min(sourceWidth, Math.max(bounds.x + bounds.width, headBounds.x + headBounds.width + margin)),
    bottom: Math.min(sourceHeight, bounds.y + bounds.height),
  };
  const requiredWidth = required.right - required.left;
  const requiredHeight = required.bottom - required.top;
  let width = Math.max(requiredWidth, requiredHeight * targetRatio);
  let height = width / targetRatio;
  if (width > sourceWidth || height > sourceHeight) {
    const shrink = Math.min(sourceWidth / width, sourceHeight / height);
    width *= shrink;
    height *= shrink;
  }

  const preferredX = face.x + face.width / 2 - width / 2;
  const minX = Math.max(0, required.right - width);
  const maxX = Math.min(required.left, sourceWidth - width);
  const x = minX <= maxX
    ? Math.max(minX, Math.min(maxX, preferredX))
    : Math.max(0, Math.min(sourceWidth - width, preferredX));

  const preferredY = bounds.y;
  const minCropY = Math.max(0, required.bottom - height);
  const maxCropY = Math.min(required.top, sourceHeight - height);
  const y = minCropY <= maxCropY
    ? Math.max(minCropY, Math.min(maxCropY, preferredY))
    : Math.max(0, Math.min(sourceHeight - height, required.top));
  return { x, y, width, height };
}

function hasTightHeadroom(item) {
  return selectedItemFaces(item).some(face => face.y < face.height * 0.48);
}

function drawSubject(context, subjectCanvas, item) {
  const radius = item.subjectOutline ? Math.max(0, Number(item.subjectOutlineWidth) || 0) : 0;
  if (radius > 0) {
    const silhouette = document.createElement('canvas');
    silhouette.width = subjectCanvas.width;
    silhouette.height = subjectCanvas.height;
    const outline = silhouette.getContext('2d');
    outline.drawImage(subjectCanvas, 0, 0);
    outline.globalCompositeOperation = 'source-in';
    outline.fillStyle = item.outlineColor || '#ffffff';
    outline.fillRect(0, 0, silhouette.width, silhouette.height);
    const steps = Math.max(18, Math.ceil(radius * 3));
    for (const distance of [radius * 0.55, radius]) {
      for (let step = 0; step < steps; step += 1) {
        const angle = step / steps * Math.PI * 2;
        context.drawImage(silhouette, Math.cos(angle) * distance, Math.sin(angle) * distance);
      }
    }
  }
  context.drawImage(subjectCanvas, 0, 0);
}

function subjectOverlapRatio(canvas, rect) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return 0;
  const pixels = context.getImageData(left, top, right - left, bottom - top).data;
  let occupied = 0, sampled = 0;
  for (let y = 0; y < bottom - top; y += 2) {
    for (let x = 0; x < right - left; x += 2) {
      sampled += 1;
      if (pixels[(y * (right - left) + x) * 4 + 3] > 16) occupied += 1;
    }
  }
  return sampled ? occupied / sampled : 0;
}

function captionPlacement(context, subjectCanvas, item, width, height, padding) {
  const ratio = width / 370;
  const minimum = Math.max(12, Math.round(18 * ratio));
  let fontSize = Math.max(minimum, Math.round(item.captionSize * ratio));
  const maxWidth = width - padding * 2;
  context.font = `900 ${fontSize}px "Noto Sans TC", sans-serif`;
  while (fontSize > minimum && context.measureText(item.caption).width > maxWidth) {
    fontSize -= 1;
    context.font = `900 ${fontSize}px "Noto Sans TC", sans-serif`;
  }
  const lineWidth = Math.max(3, fontSize * 0.18);
  const textWidth = Math.min(maxWidth, context.measureText(item.caption).width);
  const boxWidth = Math.min(maxWidth, textWidth + lineWidth * 2 + 10);
  const boxHeight = Math.min(height, fontSize * 1.35 + lineWidth * 2);
  const y = height - padding - boxHeight / 2;
  const candidates = [
    { key: 'bottom', x: width / 2, preference: 0 },
    { key: 'left', x: padding + boxWidth / 2, preference: 0.035 },
    { key: 'right', x: width - padding - boxWidth / 2, preference: 0.035 },
  ].map(candidate => ({
    ...candidate,
    y,
    rect: { x: candidate.x - boxWidth / 2, y: y - boxHeight / 2, width: boxWidth, height: boxHeight },
  }));
  const requested = ['bottom', 'left', 'right'].includes(item.captionLayout) ? item.captionLayout : 'auto';
  const selected = requested === 'auto'
    ? candidates.reduce((best, candidate) => {
      const score = subjectOverlapRatio(subjectCanvas, candidate.rect) + candidate.preference;
      return !best || score < best.score ? { ...candidate, score } : best;
    }, null)
    : candidates.find(candidate => candidate.key === requested);
  return { ...selected, fontSize, lineWidth, maxWidth };
}

async function renderPackItem(index, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const item = packState.items[index];
  const source = item && itemSource(item);
  if (!source) return canvas;
  const image = await loadPackImage(source);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  sourceCanvas.getContext('2d').drawImage(image, 0, 0);
  const padding = packState.mode === 'sticker' ? Math.max(10, Math.round(Math.min(width, height) * 0.035)) : 2;
  // Sticker captions overlay the subject so a label never forces a tall head,
  // hairstyle or costume into a shallow 24% smaller crop area.
  const captionSpace = item.caption && packState.mode === 'emoji' ? Math.round(height * 0.2) : 0;
  const availableWidth = width - padding * 2;
  const availableHeight = height - padding * 2 - captionSpace;
  const alpha = alphaBounds(sourceCanvas) || { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  const targetRatio = availableWidth / availableHeight;
  let bounds = faceCrop(item, image.naturalWidth, image.naturalHeight, targetRatio) || alpha;
  const selectedFaces = resolvedSubjectType(item) === 'person' ? selectedItemFaces(item) : [];
  if (selectedFaces.length && alpha.hasTransparency) {
    for (const face of selectedFaces) {
      const headBandBottom = Math.min(image.naturalHeight, face.y + face.height * 1.05);
      const head = connectedHeadBounds(sourceCanvas, face, headBandBottom);
      bounds = protectHeadContour(bounds, head, face, targetRatio, image.naturalWidth, image.naturalHeight);
    }
  }
  const scale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height) * Math.max(0.5, Math.min(3, Number(item.zoom) || DEFAULT_CROP_ZOOM));
  const drawWidth = bounds.width * scale;
  const drawHeight = bounds.height * scale;
  const subjectCanvas = document.createElement('canvas');
  subjectCanvas.width = width;
  subjectCanvas.height = height;
  subjectCanvas.getContext('2d').drawImage(sourceCanvas, bounds.x, bounds.y, bounds.width, bounds.height,
    (width - drawWidth) / 2 + (Number(item.offsetX) || 0) * width,
    padding + (availableHeight - drawHeight) / 2 + (Number(item.offsetY) || 0) * height,
    drawWidth, drawHeight);
  drawSubject(context, subjectCanvas, item);
  if (item.caption) {
    const placement = packState.mode === 'sticker'
      ? captionPlacement(context, subjectCanvas, item, width, height, padding)
      : { x: width / 2, y: height - padding - captionSpace / 2, fontSize: Math.max(12, Math.round(item.captionSize * width / 370)), lineWidth: 3, maxWidth: width - padding * 2 };
    context.font = `900 ${placement.fontSize}px "Noto Sans TC", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(3, placement.lineWidth || placement.fontSize * 0.18);
    context.strokeStyle = item.outlineColor;
    context.fillStyle = item.captionColor;
    context.strokeText(item.caption, placement.x, placement.y, placement.maxWidth);
    context.fillText(item.caption, placement.x, placement.y, placement.maxWidth);
  }
  return canvas;
}

async function renderSlotCanvas(index, target) {
  const width = packState.mode === 'sticker' ? 370 : 180;
  const height = packState.mode === 'sticker' ? 320 : 180;
  const rendered = await renderPackItem(index, width, height);
  target.width = width;
  target.height = height;
  target.getContext('2d').drawImage(rendered, 0, 0);
}

function renderPackWorkspace() {
  configurePackMode();
  const filled = packState.items.filter(item => item.imageName).length;
  $('#pack-progress-text').textContent = `${filled} / ${packState.count}`;
  $('#pack-progress-bar').style.width = `${filled / packState.count * 100}%`;
  $('#generate-pack').disabled = filled !== packState.count;
  $('#pack-slots').innerHTML = packState.items.map((item, index) => `
    <article class="pack-slot ${index === packState.selected ? 'selected' : ''} ${packState.cutoutQuality[item.imageName]?.risk === 'high' ? 'risk-high' : packState.cutoutQuality[item.imageName]?.risk === 'review' ? 'risk-review' : ''}" data-index="${index}">
      ${item.imageName ? `<canvas aria-label="${escapeHtml(sourceName(item.imageName))}"></canvas>` : '<div class="pack-empty">點左側素材填入</div>'}
      <footer><span>${String(index + 1).padStart(packState.mode === 'emoji' ? 3 : 2, '0')}${item.caption ? ` · ${escapeHtml(item.caption)}` : ''}${packState.cutoutQuality[item.imageName]?.risk === 'high' ? ' · ⚠' : ''}</span>
        <div class="pack-slot-controls"><button data-move="-1">←</button><button data-move="1">→</button><button data-remove>×</button></div>
      </footer>
    </article>`).join('');
  document.querySelectorAll('.pack-slot').forEach(slot => {
    const index = Number(slot.dataset.index);
    slot.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      packState.selected = index;
      renderPackWorkspace();
    });
    slot.querySelector('[data-remove]')?.addEventListener('click', () => { packState.items[index] = blankItem(); renderPackWorkspace(); });
    slot.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => movePackItem(index, Number(button.dataset.move))));
    const canvas = slot.querySelector('canvas');
    if (canvas) renderSlotCanvas(index, canvas);
  });
  syncInspector();
  scheduleAutosave();
}

async function renderFacePicker(item) {
  const generation = (renderFacePicker.generation || 0) + 1;
  renderFacePicker.generation = generation;
  const picker = $('#face-picker');
  const faces = resolvedSubjectType(item) === 'person' ? itemFaceCandidates(item) : [];
  picker.hidden = faces.length < 2;
  if (picker.hidden) { $('#face-options').innerHTML = ''; return; }
  const selected = new Set(Array.isArray(item.selectedFaceIndices)
    ? item.selectedFaceIndices.filter(index => faces[index])
    : faces.map((_, index) => index));
  if (!selected.size) faces.forEach((_, index) => selected.add(index));
  $('#face-options').innerHTML = faces.map((_, index) => `
    <button type="button" class="face-option ${selected.has(index) ? 'selected' : ''}" data-face-index="${index}" aria-pressed="${selected.has(index)}">
      <canvas width="44" height="44"></canvas><span>人物 ${index + 1}</span>
    </button>`).join('');
  try {
    const image = await loadPackImage(sourceUrl(item.imageName));
    if (generation !== renderFacePicker.generation || packState.items[packState.selected] !== item) return;
    $('#face-options').querySelectorAll('.face-option').forEach(button => {
      const face = faces[Number(button.dataset.faceIndex)];
      const canvas = button.querySelector('canvas');
      const context = canvas.getContext('2d');
      const margin = Math.max(face.width, face.height) * 0.35;
      const size = Math.max(face.width, face.height) + margin * 2;
      context.drawImage(image, face.x + face.width / 2 - size / 2, face.y + face.height / 2 - size / 2, size, size, 0, 0, 44, 44);
    });
  } catch { /* The numbered controls remain usable if a thumbnail fails. */ }
  if (generation !== renderFacePicker.generation || packState.items[packState.selected] !== item) return;
  $('#face-options').querySelectorAll('.face-option').forEach(button => { button.onclick = async () => {
    const index = Number(button.dataset.faceIndex);
    const next = new Set(Array.isArray(item.selectedFaceIndices) ? item.selectedFaceIndices : faces.map((_, faceIndex) => faceIndex));
    if (next.has(index)) {
      if (next.size === 1) { packToast('合照構圖至少要保留一位人物'); return; }
      next.delete(index);
    } else next.add(index);
    item.selectedFaceIndices = [...next].sort((left, right) => left - right);
    item.offsetX = 0;
    item.offsetY = 0;
    item.isolatedUrl = null;
    item.isolationReport = null;
    renderPackWorkspace();
    try {
      if (packState.processed[item.imageName]) {
        packToast('正在分離所選人物…');
        await isolateSelectedPeople(item);
      }
    } catch (error) {
      item.isolationReport = { error: error.message };
      packToast(error.message);
    }
    renderPackWorkspace();
  }; });
}

function movePackItem(index, offset) {
  const destination = index + offset;
  if (destination < 0 || destination >= packState.items.length) return;
  [packState.items[index], packState.items[destination]] = [packState.items[destination], packState.items[index]];
  packState.selected = destination;
  renderPackWorkspace();
}

async function syncInspector() {
  const item = packState.items[packState.selected];
  $('#item-caption').value = item.caption;
  $('#caption-layout').value = ['auto', 'bottom', 'left', 'right'].includes(item.captionLayout) ? item.captionLayout : 'auto';
  $('#subject-type').value = ['auto', 'person', 'pet'].includes(item.subjectType) ? item.subjectType : 'auto';
  $('#caption-color').value = item.captionColor;
  $('#outline-color').value = item.outlineColor;
  $('#caption-size').value = item.captionSize;
  $('#caption-size-value').textContent = item.captionSize;
  $('#focus-face').checked = item.focusFace !== false;
  $('#subject-outline').checked = item.subjectOutline !== false;
  $('#subject-outline-width').value = item.subjectOutlineWidth;
  $('#subject-outline-width-value').textContent = item.subjectOutlineWidth;
  $('#item-zoom').value = Math.round((Number(item.zoom) || DEFAULT_CROP_ZOOM) * 100);
  $('#item-zoom-value').textContent = `${Math.round((Number(item.zoom) || DEFAULT_CROP_ZOOM) * 100)}%`;
  $('#preview-note').textContent = item.imageName ? sourceName(item.imageName) : '請選擇一個格位';
  const hints = [];
  const subjectType = resolvedSubjectType(item);
  const faceCandidates = itemFaceCandidates(item);
  const selectedFaces = selectedItemFaces(item);
  renderFacePicker(item);
  if (item.imageName && subjectType === 'pet' && item.subjectType === 'auto') hints.push(item.face ? '人臉信心較低，已改用寵物／物件輪廓；若判斷錯誤可手動改為人物。' : '未偵測到可靠人臉，已使用完整主體輪廓。');
  if (item.imageName && subjectType === 'person' && hasTightHeadroom(item)) hints.push('原圖頭頂空間較少，請確認頭髮或帽子是否完整。');
  if (subjectType === 'person' && faceCandidates.length > 1) {
    const removed = faceCandidates.length - selectedFaces.length;
    if (!removed) hints.push(`偵測到 ${faceCandidates.length} 位人物，目前全部保留。`);
    else if (item.isolationReport?.error) hints.push(`人物分割失敗：${item.isolationReport.error}；目前只套用裁切安全框。`);
    else if (item.isolatedUrl) hints.push(`已保留 ${selectedFaces.length} 位並移除 ${removed} 位未選人物；人物重疊處仍建議放大檢查。`);
    else if (packState.processed[item.imageName]) hints.push(`已選擇保留 ${selectedFaces.length} 位，正在建立個別人物遮罩。`);
    else hints.push(`已選擇保留 ${selectedFaces.length} 位；完成 AI 去背後會移除其餘 ${removed} 位。`);
  }
  if (item.imageName && !packState.processed[item.imageName]) hints.push('尚未 AI 去背，目前預覽仍含原始背景。');
  if (item.imageName && packState.processedModes[item.imageName] === 'draft') hints.push('目前是快速草稿邊緣，輸出時會升級為高品質。');
  const cutoutRisk = item.imageName ? packState.cutoutQuality[item.imageName] : null;
  if (cutoutRisk?.risk === 'high' && cutoutRisk.autoUpgraded) hints.push(`快速草稿不穩，已自動改用高品質。${cutoutRisk.warnings?.[0] || '兩種遮罩差異過大，仍請放大檢查。'}`);
  else if (cutoutRisk?.risk === 'high') hints.push(`去背高風險：${cutoutRisk.warnings?.[0] || '兩種遮罩差異過大，請進入遮罩編輯。'}`);
  else if (cutoutRisk?.risk === 'review') hints.push(`去背需檢查：${cutoutRisk.warnings?.[0] || '請放大檢查邊緣。'}`);
  $('#quality-hints').textContent = hints.join(' ');
  const width = packState.mode === 'sticker' ? 370 : 180;
  const height = packState.mode === 'sticker' ? 320 : 180;
  const rendered = await renderPackItem(packState.selected, width, height);
  const preview = $('#pack-preview');
  preview.width = width; preview.height = height;
  preview.getContext('2d').drawImage(rendered, 0, 0);
  const previewUrl = rendered.toDataURL('image/png');
  $('#mini-preview-light').src = previewUrl;
  $('#mini-preview-dark').src = previewUrl;
}

function meaningfulFaces(record) {
  return (record.faces || []).filter(confidentHumanFace);
}

function hashDistance(left, right) {
  if (!left || !right) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let bits = 0;
  while (value) { bits += Number(value & 1n); value >>= 1n; }
  return bits;
}

function prepareAnalysis(records) {
  return records.map(record => {
    const faces = meaningfulFaces(record);
    const detectedFace = record.detectedFace || record.faces?.[0] || null;
    const primaryFace = faces[0] || null;
    const faceArea = primaryFace ? primaryFace.width * primaryFace.height / (record.width * record.height) : 0;
    const targetArea = packState.mode === 'emoji' ? 0.13 : 0.12;
    const areaScore = faceArea ? -Math.abs(Math.log(faceArea / targetArea)) : -8;
    const sharpness = Math.min(2, Math.log10(1 + Number(record.quality?.sharpness || 0)) / 2);
    const brightness = Number(record.quality?.brightness || 128);
    const exposurePenalty = brightness < 45 || brightness > 220 ? 1.2 : 0;
    const centerDistance = primaryFace ? Math.hypot(
      (primaryFace.x + primaryFace.width / 2) / record.width - 0.5,
      (primaryFace.y + primaryFace.height / 2) / record.height - 0.46,
    ) : 1;
    const nearbyFaces = primaryFace ? faces.filter(face => {
      const distance = Math.hypot(
        face.x + face.width / 2 - (primaryFace.x + primaryFace.width / 2),
        face.y + face.height / 2 - (primaryFace.y + primaryFace.height / 2),
      );
      return distance <= primaryFace.width * 2.15;
    }) : [];
    const portraitFallback = !primaryFace && record.height / record.width >= 1.15;
    const subjectFallback = !primaryFace;
    const subjectAspectPenalty = Math.abs(Math.log(Math.max(0.25, record.height / record.width))) * 0.22;
    const score = subjectFallback
      ? -0.65 + sharpness - exposurePenalty - subjectAspectPenalty
      : areaScore + sharpness - exposurePenalty - centerDistance * 3.2 - Math.max(0, nearbyFaces.length - 1) * 4;
    return {
      ...record,
      faces,
      detectedFace,
      primaryFace,
      faceArea,
      nearbyFaceCount: nearbyFaces.length,
      portraitFallback,
      subjectFallback,
      score,
    };
  });
}

function choosePackRecords(records, count) {
  const prepared = prepareAnalysis(records);
  const strict = prepared.filter(record => record.portraitFallback || (
    record.nearbyFaceCount === 1 && record.faceArea >= 0.012 && record.faceArea <= 0.34
    && Math.hypot(
      (record.primaryFace.x + record.primaryFace.width / 2) / record.width - 0.5,
      (record.primaryFace.y + record.primaryFace.height / 2) / record.height - 0.46,
    ) < 0.3
  ));
  const fallback = prepared.filter(record => record.primaryFace && !strict.includes(record));
  const subjects = prepared.filter(record => !record.primaryFace && !strict.includes(record));
  const chosen = [];
  const chooseFrom = candidates => {
    const remaining = candidates.filter(record => !chosen.includes(record));
    if (!remaining.length) return false;
    remaining.sort((left, right) => {
      const similarityPenalty = record => chosen.reduce((penalty, selected) => {
        const distance = hashDistance(record.quality?.visualHash, selected.quality?.visualHash);
        return penalty + (distance < 10 ? 4 : distance < 16 ? 1.5 : 0);
      }, 0);
      return (right.score - similarityPenalty(right)) - (left.score - similarityPenalty(left));
    });
    chosen.push(remaining[0]);
    return true;
  };
  while (chosen.length < Math.min(count, strict.length)) chooseFrom(strict);
  while (chosen.length < Math.min(count, strict.length + fallback.length)) {
    if (!chooseFrom(fallback)) break;
  }
  while (chosen.length < Math.min(count, prepared.length)) {
    if (!chooseFrom(subjects)) break;
  }
  return { chosen, strictCount: chosen.filter(record => strict.includes(record)).length };
}

async function smartFillPack() {
  const button = $('#smart-fill');
  button.disabled = true;
  button.textContent = '分析中…';
  try {
    const records = Object.values(packState.analysis);
    const { chosen, strictCount } = choosePackRecords(records, packState.count);
    packState.analysis = Object.fromEntries(prepareAnalysis(records).map(record => [record.id || record.name, record]));
    const withCaptions = packState.mode === 'sticker' && $('#auto-caption').checked;
    packState.items = Array.from({ length: packState.count }, (_, index) => {
      const record = chosen.length ? chosen[index % chosen.length] : null;
      return {
        ...blankItem(),
        imageName: record ? (record.id || record.name) : null,
        face: record?.detectedFace || record?.primaryFace || null,
        faces: record?.faces || [],
        selectedFaceIndices: null,
        quality: record ? { faceCount: record.faces.length, faceArea: record.faceArea, strict: index < strictCount } : null,
        caption: withCaptions ? STICKER_CAPTIONS[index % STICKER_CAPTIONS.length] : '',
      };
    });
    renderPackWorkspace();
    const fallbackCount = Math.max(0, packState.count - Math.min(strictCount, packState.count));
    packToast(fallbackCount
      ? `已填入；其中 ${fallbackCount} 張缺少理想單人素材`
      : `已挑選 ${Math.min(chosen.length, packState.count)} 張單人、構圖分散的素材`);
  } finally {
    button.disabled = false;
    button.textContent = '智慧填入';
  }
}

function updateBatchProgress(done, total, durations, current, cached = false) {
  const progress = $('#batch-progress');
  progress.hidden = false;
  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const remaining = Math.max(0, total - done);
  const eta = average ? Math.ceil(average * remaining) : 0;
  $('#batch-status-text').textContent = done >= total
    ? `已完成 ${total} 張`
    : `${current || '準備中'} · ${done}/${total}${cached ? ' · 快取' : ''}${eta ? ` · 約剩 ${eta} 秒` : ''}`;
  $('#batch-progress-bar').style.width = `${total ? done / total * 100 : 0}%`;
  $('#cancel-batch').disabled = done >= total;
}

async function batchRemovePackBackgrounds(modeOverride = null) {
  const names = [...new Set(packState.items.map(item => item.imageName).filter(Boolean))];
  const button = $('#batch-cutout');
  const mode = modeOverride || $('#cutout-mode').value;
  if (!names.length) { packToast('請先填入素材'); return false; }
  packState.batchController?.abort();
  const controller = new AbortController();
  packState.batchController = controller;
  const durations = [];
  let done = 0;
  let autoUpgraded = 0;
  button.disabled = true;
  $('#auto-build').disabled = true;
  updateBatchProgress(0, names.length, durations, '啟動去背引擎');
  try {
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      button.textContent = `去背 ${index + 1}/${names.length}`;
      const started = performance.now();
      let cached = Boolean(packState.processed[name] && packState.processedModes[name] === mode);
      if (!cached) {
        const response = await fetch('/api/remove-background', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ assetId: name, mode }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`${sourceName(name)}：${data.error || '去背失敗'}`);
        packState.processed[name] = data.url || data.image;
        packState.processedModes[name] = mode;
        if (data.quality) packState.cutoutQuality[name] = data.quality;
        cached = Boolean(data.cached);
      }
      if (mode === 'draft' && packState.cutoutQuality[name]?.risk === 'high') {
        updateBatchProgress(done, names.length, durations, `${sourceName(name)} · 草稿不穩，升級高品質`);
        let qualityResponse = await fetch(`/api/cutout-cache?asset=${encodeURIComponent(name)}&mode=quality`, { signal: controller.signal });
        let qualityData = await qualityResponse.json();
        if (!qualityData.cached) {
          qualityResponse = await fetch('/api/remove-background', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ assetId: name, mode: 'quality' }),
          });
          qualityData = await qualityResponse.json();
        }
        if (!qualityResponse.ok || !(qualityData.url || qualityData.image)) throw new Error(`${sourceName(name)}：高品質去背失敗`);
        packState.processed[name] = qualityData.url || qualityData.image;
        packState.processedModes[name] = 'quality';
        packState.cutoutQuality[name] = { ...(qualityData.quality || packState.cutoutQuality[name]), autoUpgraded: true };
        autoUpgraded += 1;
      }
      for (const item of packState.items.filter(candidate => candidate.imageName === name)) {
        item.isolatedUrl = null;
        item.isolationMode = null;
        await isolateSelectedPeople(item, controller.signal);
      }
      durations.push((performance.now() - started) / 1000);
      done += 1;
      updateBatchProgress(done, names.length, durations, sourceName(name), cached);
      renderPackWorkspace();
    }
    const risks = names.filter(name => ['high', 'review'].includes(packState.cutoutQuality[name]?.risk)).length;
    packToast(autoUpgraded
      ? `去背完成；${autoUpgraded} 張草稿不穩，已自動改用高品質${risks ? `；${risks} 張仍建議放大檢查` : ''}`
      : risks ? `去背完成；${risks} 張需要放大檢查` : `${mode === 'draft' ? '快速草稿' : '高品質'}去背完成`);
    return true;
  } catch (error) {
    if (error.name === 'AbortError') packToast('已取消批次去背');
    else packToast(error.message);
    return false;
  } finally {
    packState.batchController = null;
    button.textContent = '批次 AI 去背';
    button.disabled = !packState.modelReady;
    $('#auto-build').disabled = !packState.modelReady;
    renderPackWorkspace();
  }
}

function canvasTransparency(canvas) {
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = false, visible = false;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] === 0) transparent = true;
    if (data[index] > 10) visible = true;
    if (transparent && visible) break;
  }
  return { transparent, visible };
}

function canvasBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function buildPackFiles() {
  const errors = [];
  const files = [];
  if (packState.items.some(item => !item.imageName)) errors.push('尚有空白格位');
  for (let index = 0; index < packState.count; index += 1) {
    const width = packState.mode === 'sticker' ? 370 : 180;
    const height = packState.mode === 'sticker' ? 320 : 180;
    const canvas = await renderPackItem(index, width, height);
    const alpha = canvasTransparency(canvas);
    const name = packState.mode === 'sticker' ? `${String(index + 1).padStart(2, '0')}.png` : `${String(index + 1).padStart(3, '0')}.png`;
    if (!alpha.visible) errors.push(`${name} 沒有可見內容`);
    if (!alpha.transparent) errors.push(`${name} 背景不透明，請先批次 AI 去背`);
    const blob = await canvasBlob(canvas);
    if (blob.size >= 1_000_000) errors.push(`${name} 超過 1 MB`);
    files.push({ name, blob });
  }
  const first = 0;
  if (packState.mode === 'sticker') files.push({ name: 'main.png', blob: await canvasBlob(await renderPackItem(first, 240, 240)) });
  files.push({ name: 'tab_on.png', blob: await canvasBlob(await renderPackItem(first, 96, 74)) });
  return { files, errors };
}

function showPackValidation(errors) {
  const node = $('#pack-validation');
  node.hidden = errors.length === 0;
  node.textContent = errors.join('\n');
}

async function generatePackZip() {
  const button = $('#generate-pack');
  button.disabled = true;
  button.textContent = '驗證中…';
  try {
    const names = [...new Set(packState.items.map(item => item.imageName).filter(Boolean))];
    if (names.some(name => packState.processedModes[name] !== 'quality')) {
      button.textContent = '升級高品質…';
      const completed = await batchRemovePackBackgrounds('quality');
      if (!completed) return;
      button.disabled = true;
      button.textContent = '驗證中…';
    }
    const { files, errors } = await buildPackFiles();
    if (errors.length) { showPackValidation(errors); return; }
    const zip = new JSZip();
    files.forEach(file => zip.file(file.name, file.blob));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const limit = packState.mode === 'sticker' ? 60_000_000 : 20_000_000;
    if (blob.size >= limit) { showPackValidation([`ZIP 超過 ${limit / 1_000_000} MB`]); return; }
    const response = await fetch(`/api/save-product-zip?mode=${packState.mode}`, { method: 'POST', body: blob });
    const data = await response.json();
    if (!response.ok) { showPackValidation(data.errors || [data.error || '驗證失敗']); return; }
    showPackValidation([]);
    packToast(`已產生 ${data.path}`);
  } finally {
    button.textContent = '驗證並產生 ZIP';
    button.disabled = packState.items.some(item => !item.imageName);
  }
}

async function autoBuildDraft() {
  const button = $('#auto-build');
  button.disabled = true;
  button.textContent = '建立中…';
  try {
    await smartFillPack();
    $('#cutout-mode').value = 'draft';
    packState.cutoutMode = 'draft';
    const completed = await batchRemovePackBackgrounds('draft');
    if (completed) packToast('初稿已完成，請拖曳或縮放構圖後再輸出');
  } finally {
    button.textContent = '一鍵建立初稿';
    button.disabled = !packState.modelReady;
  }
}

function savePackProject() {
  const date = new Intl.DateTimeFormat('sv-SE').format(new Date());
  const payload = { format: 'line-pack-project', version: 2, mode: packState.mode, count: packState.count, selected: packState.selected, items: packState.items, processed: packState.processed, processedModes: packState.processedModes, cutoutMode: packState.cutoutMode, cutoutQuality: packState.cutoutQuality };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  link.download = `line-${packState.mode}-project-${date}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function loadPackProject(file) {
  const project = JSON.parse(await file.text());
  if (project.format !== 'line-pack-project' || ![1, 2].includes(project.version) || !['sticker', 'emoji'].includes(project.mode)) throw new Error('不支援的專案格式');
  const count = Number(project.count);
  if ((project.mode === 'sticker' && ![8, 16, 24, 32, 40].includes(count)) || (project.mode === 'emoji' && (count < 8 || count > 40))) throw new Error('專案張數不符合規格');
  packState.mode = project.mode;
  history.replaceState(null, '', `?mode=${project.mode}`);
  packState.count = count;
  const validIds = new Set(packState.sources.map(source => source.id));
  packState.items = (project.items || []).slice(0, packState.count).map(item => {
    const restored = { ...blankItem(), ...item, imageName: validIds.has(item.imageName) ? item.imageName : null };
    if (typeof restored.isolatedUrl !== 'string' || !restored.isolatedUrl.startsWith('/.cache/cutouts/')) restored.isolatedUrl = null;
    if (!['draft', 'quality'].includes(restored.isolationMode)) restored.isolationMode = null;
    return restored;
  });
  while (packState.items.length < packState.count) packState.items.push(blankItem());
  packState.processed = Object.fromEntries(Object.entries(project.processed || {}).filter(([name, value]) => validIds.has(name) && typeof value === 'string' && (value.startsWith('data:image/png;base64,') || value.startsWith('/.cache/'))));
  packState.processedModes = Object.fromEntries(Object.entries(project.processedModes || {}).filter(([name]) => validIds.has(name)));
  packState.cutoutMode = project.cutoutMode === 'quality' ? 'quality' : 'draft';
  packState.cutoutQuality = project.cutoutQuality && typeof project.cutoutQuality === 'object' ? project.cutoutQuality : {};
  $('#cutout-mode').value = packState.cutoutMode;
  packState.selected = Math.max(0, Math.min(packState.count - 1, Number(project.selected) || 0));
  renderPackWorkspace();
  packToast(`已載入 ${file.name}`);
}

$('#pack-count').addEventListener('change', event => resizeItems(Number(event.target.value)));
$('#smart-fill').addEventListener('click', smartFillPack);
$('#batch-cutout').addEventListener('click', () => batchRemovePackBackgrounds());
$('#auto-build').addEventListener('click', autoBuildDraft);
$('#cancel-batch').addEventListener('click', () => packState.batchController?.abort());
$('#generate-pack').addEventListener('click', generatePackZip);
$('#save-pack-project').addEventListener('click', savePackProject);
$('#load-pack-project').addEventListener('click', () => $('#pack-project-file').click());
$('#pack-project-file').addEventListener('change', async event => {
  try { if (event.target.files[0]) await loadPackProject(event.target.files[0]); }
  catch (error) { packToast(error.message); }
  event.target.value = '';
});
$('#select-all-faces').addEventListener('click', () => {
  const item = packState.items[packState.selected];
  const faces = itemFaceCandidates(item);
  if (faces.length < 2) return;
  item.selectedFaceIndices = faces.map((_, index) => index);
  item.offsetX = 0;
  item.offsetY = 0;
  item.isolatedUrl = null;
  item.isolationMode = null;
  item.isolationReport = null;
  renderPackWorkspace();
  packToast(`已保留全部 ${faces.length} 位人物`);
});
['#item-caption', '#caption-layout', '#subject-type', '#caption-color', '#outline-color', '#caption-size', '#focus-face', '#subject-outline', '#subject-outline-width', '#item-zoom'].forEach(selector => $(selector).addEventListener('input', () => {
  const item = packState.items[packState.selected];
  item.caption = $('#item-caption').value;
  item.captionLayout = $('#caption-layout').value;
  item.subjectType = $('#subject-type').value;
  item.captionColor = $('#caption-color').value;
  item.outlineColor = $('#outline-color').value;
  item.captionSize = Number($('#caption-size').value);
  item.focusFace = $('#focus-face').checked;
  item.subjectOutline = $('#subject-outline').checked;
  item.subjectOutlineWidth = Number($('#subject-outline-width').value);
  item.zoom = Number($('#item-zoom').value) / 100;
  $('#caption-size-value').textContent = item.captionSize;
  $('#subject-outline-width-value').textContent = item.subjectOutlineWidth;
  $('#item-zoom-value').textContent = `${Math.round(item.zoom * 100)}%`;
  renderPackWorkspace();
}));

$('#reset-crop').addEventListener('click', () => {
  const item = packState.items[packState.selected];
  item.offsetX = 0; item.offsetY = 0; item.zoom = DEFAULT_CROP_ZOOM;
  renderPackWorkspace();
  packToast('已重設為 AI 構圖');
});

const cropCanvas = $('#pack-preview');
let cropDrag = null;
cropCanvas.addEventListener('pointerdown', event => {
  if (!packState.items[packState.selected]?.imageName) return;
  const item = packState.items[packState.selected];
  cropDrag = { x: event.clientX, y: event.clientY, offsetX: Number(item.offsetX) || 0, offsetY: Number(item.offsetY) || 0 };
  cropCanvas.setPointerCapture(event.pointerId);
  cropCanvas.classList.add('dragging');
});
cropCanvas.addEventListener('pointermove', async event => {
  if (!cropDrag) return;
  const rect = cropCanvas.getBoundingClientRect();
  const item = packState.items[packState.selected];
  item.offsetX = cropDrag.offsetX + (event.clientX - cropDrag.x) / rect.width;
  item.offsetY = cropDrag.offsetY + (event.clientY - cropDrag.y) / rect.height;
  await syncInspector();
  const slotCanvas = document.querySelector(`.pack-slot[data-index="${packState.selected}"] canvas`);
  if (slotCanvas) renderSlotCanvas(packState.selected, slotCanvas);
});
cropCanvas.addEventListener('pointerup', () => {
  if (!cropDrag) return;
  cropDrag = null;
  cropCanvas.classList.remove('dragging');
  renderPackWorkspace();
});
cropCanvas.addEventListener('wheel', event => {
  if (!packState.items[packState.selected]?.imageName) return;
  event.preventDefault();
  const item = packState.items[packState.selected];
  item.zoom = Math.max(0.5, Math.min(3, (Number(item.zoom) || DEFAULT_CROP_ZOOM) * (event.deltaY < 0 ? 1.08 : 0.92)));
  renderPackWorkspace();
}, { passive: false });

$('#choose-files').addEventListener('click', () => $('#pack-file-input').click());
$('#choose-folder').addEventListener('click', () => $('#pack-folder-input').click());
$('#pack-file-input').addEventListener('change', event => { importPackFiles(event.target.files); event.target.value = ''; });
$('#pack-folder-input').addEventListener('change', event => { importPackFiles(event.target.files); event.target.value = ''; });
const packDropzone = $('#pack-dropzone');
['dragenter', 'dragover'].forEach(type => packDropzone.addEventListener(type, event => { event.preventDefault(); packDropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => packDropzone.addEventListener(type, event => { event.preventDefault(); packDropzone.classList.remove('dragging'); }));
packDropzone.addEventListener('drop', event => importPackFiles(event.dataTransfer.files));

$('#cutout-mode').addEventListener('change', async event => {
  packState.cutoutMode = event.target.value;
  await hydrateCachedCutouts();
  renderPackWorkspace();
});
window.addEventListener('beforeunload', saveAutosave);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveAutosave(); });

initializePacks().catch(error => packToast(error.message));
