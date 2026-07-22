// State Variables
let images = [];              // Raw images loaded from the workspace
let activeImageIndex = -1;    // Currently selected raw image index
let activeImage = null;       // Currently selected raw image Image object
let activeRole = '';          // Currently selected LINE role

// Crop Box Specifications (Target sizes)
const ROLE_SPECS = {
  chat_bg_ios: { width: 1482, height: 1334, label: '聊天背景 (iOS) 1482x1334' },
  chat_bg_android: { width: 1300, height: 1300, label: '聊天背景 (Android) 1300x1300' },
  main_cover_ios: { width: 200, height: 284, label: '主題小舖封面 (iOS) 200x284' },
  main_cover_android: { width: 136, height: 202, label: '主題小舖封面 (Android) 136x202' },
  main_cover_store: { width: 198, height: 278, label: 'LINE STORE 封面 198x278' },
  menu_bg: { width: 1472, height: 150, label: '選單背景 1472x150' },

  menu_home: { width: 128, height: 150, label: '選單按鍵 (主頁) 128x150' },
  menu_chats: { width: 128, height: 150, label: '選單按鍵 (聊天) 128x150' },
  menu_voom: { width: 128, height: 150, label: '選單按鍵 (VOOM) 128x150' },
  menu_today: { width: 128, height: 150, label: '選單按鍵 (新聞/TODAY) 128x150' },
  menu_wallet: { width: 128, height: 150, label: '選單按鍵 (錢包) 128x150' },

  passcode_1: { width: 120, height: 120, label: '解鎖鍵 1 (iOS) 120x120' },
  passcode_2: { width: 120, height: 120, label: '解鎖鍵 2 (iOS) 120x120' },
  passcode_3: { width: 120, height: 120, label: '解鎖鍵 3 (iOS) 120x120' },
  passcode_4: { width: 120, height: 120, label: '解鎖鍵 4 (iOS) 120x120' },

  profile_user: { width: 240, height: 240, label: '個人預設頭像 240x240' },
  profile_group: { width: 240, height: 240, label: '群組預設頭像 240x240' }
};

// Group options mapped to individual keys
const GROUP_ROLES = {
  chat_bg_all: ['chat_bg_ios', 'chat_bg_android'],
  menu_all: ['menu_home', 'menu_chats', 'menu_voom', 'menu_today', 'menu_wallet'],
  passcode_all: ['passcode_1', 'passcode_2', 'passcode_3', 'passcode_4'],
  profile_all: ['profile_user', 'profile_group']
};

// Assignments map: roleKey -> { imageName, scale, tx, ty }
let assignments = {};

// Canvas Editor parameters
const canvas = document.getElementById('crop-canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');
const overlay = document.getElementById('crop-overlay');
const targetBox = document.getElementById('crop-target-box');
const targetLabel = document.getElementById('crop-target-label');

let imgScale = 1.0;
let imgTx = 0;
let imgTy = 0;
let isDragging = false;
let startX = 0;
let startY = 0;

// Box coordinates relative to canvas
let boxWidth = 0;
let boxHeight = 0;
let boxX = 0;
let boxY = 0;

// Cached Image elements: imageName -> HTMLImageElement
const imageCache = {};

// Eraser tool parameters
let isEraserMode = false;
let eraserSize = 40;
const editedCanvases = {}; // Cache of canvas elements: imageName -> HTMLCanvasElement
const modifiedImages = new Set();
const faceCache = {};
let mouseCanvasX = 0;
let mouseCanvasY = 0;
let isMouseOverCanvas = false;
let backgroundRemovalReady = false;
let faceDetectionReady = false;
let faceGuides = [];

// Helper to get or initialize an edited canvas for an image
function getEditedCanvas(imgName) {
  if (!imgName) return null;
  if (editedCanvases[imgName]) {
    return editedCanvases[imgName];
  }
  const img = imageCache[imgName];
  if (!img) return null;

  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const tempCtx = c.getContext('2d');
  tempCtx.drawImage(img, 0, 0);

  editedCanvases[imgName] = c;
  return c;
}

// Initialize App
window.addEventListener('DOMContentLoaded', () => {
  fetchImages();
  checkProcessingHealth();
  setupEventListeners();
  updateProgress();
});

async function checkProcessingHealth() {
  const status = document.getElementById('cutout-status');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    backgroundRemovalReady = Boolean(data.backgroundRemoval);
    faceDetectionReady = Boolean(data.faceDetection);
    status.textContent = backgroundRemovalReady
      ? `前景 ${data.model} · 人臉 ${faceDetectionReady ? '就緒' : '未安裝'}`
      : '未安裝 rembg';
  } catch {
    backgroundRemovalReady = false;
    faceDetectionReady = false;
    status.textContent = '圖像服務無法連線';
  }
  document.getElementById('btn-auto-remove').disabled = !backgroundRemovalReady || !activeImage;
  document.getElementById('btn-face-crop').disabled = !faceDetectionReady || !activeImage;
}

function loadDataImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function canvasHasTransparency(sourceCanvas) {
  const data = sourceCanvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 250) return true;
  }
  return false;
}

async function autoRemoveActiveImage() {
  if (!activeImage || !backgroundRemovalReady) return;
  const button = document.getElementById('btn-auto-remove');
  const status = document.getElementById('cutout-status');
  const imageName = images[activeImageIndex];
  const sourceCanvas = getEditedCanvas(imageName);
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 處理中';
  status.textContent = '正在建立 Alpha 遮罩…';
  try {
    const response = await fetch('/api/remove-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: sourceCanvas.toDataURL('image/png') }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI 去背失敗');
    const cutout = await loadDataImage(data.image);
    const result = document.createElement('canvas');
    result.width = cutout.naturalWidth;
    result.height = cutout.naturalHeight;
    result.getContext('2d').drawImage(cutout, 0, 0);
    editedCanvases[imageName] = result;
    modifiedImages.add(imageName);
    status.textContent = '已使用 Alpha 前景遮罩';
    drawEditor();
    renderEmulatorPreviews();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !backgroundRemovalReady;
    button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 去背';
  }
}

async function detectFacesForImage(imageName) {
  if (faceCache[imageName]) return faceCache[imageName];
  const sourceCanvas = getEditedCanvas(imageName);
  if (!sourceCanvas) return [];
  const response = await fetch('/api/detect-faces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: sourceCanvas.toDataURL('image/jpeg', 0.9) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '人臉偵測失敗');
  faceCache[imageName] = data.faces || [];
  return faceCache[imageName];
}

function faceAwareBounds(faces, imageWidth, imageHeight, compact = false) {
  const minX = Math.min(...faces.map(face => face.x));
  const minY = Math.min(...faces.map(face => face.y));
  const maxX = Math.max(...faces.map(face => face.x + face.width));
  const maxY = Math.max(...faces.map(face => face.y + face.height));
  const averageFace = faces.reduce((sum, face) => sum + face.width, 0) / faces.length;
  let top = minY - averageFace * 0.85;
  const eyed = faces.filter(face => face.leftEye && face.rightEye);
  if (eyed.length) {
    // Anchor headroom to the eye line: stays stable when the detector box
    // clips hats or hair, which box-top margins cannot account for.
    const minEyeY = Math.min(...eyed.map(face => (face.leftEye.y + face.rightEye.y) / 2));
    top = Math.min(minEyeY - averageFace * 1.45, minY - averageFace * 0.2);
  }
  const left = Math.max(0, minX - averageFace * 0.75);
  top = Math.max(0, top);
  const right = Math.min(imageWidth, maxX + averageFace * 0.75);
  const bottom = Math.min(imageHeight, maxY + averageFace * (compact ? 1.35 : 2.4));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function detectSubjectForImage(imageName) {
  const sourceCanvas = getEditedCanvas(imageName);
  if (!sourceCanvas) return null;
  const response = await fetch('/api/detect-subject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: sourceCanvas.toDataURL('image/png') }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '主體偵測失敗');
  return data.subject;
}

function subjectBounds(subject, imageWidth, imageHeight) {
  const marginX = subject.width * 0.08;
  const marginY = subject.height * 0.08;
  const x = Math.max(0, subject.x - marginX);
  const y = Math.max(0, subject.y - marginY);
  return {
    x,
    y,
    width: Math.min(imageWidth, subject.x + subject.width + marginX) - x,
    height: Math.min(imageHeight, subject.y + subject.height + marginY) - y,
  };
}

async function applyFaceAssistedCrop() {
  if (!activeImage || !faceDetectionReady) return;
  const button = document.getElementById('btn-face-crop');
  const status = document.getElementById('cutout-status');
  button.disabled = true;
  status.textContent = '正在偵測人臉位置…';
  try {
    const imageName = images[activeImageIndex];
    const faces = await detectFacesForImage(imageName);
    const compact = /^(menu_|passcode_|profile_)/.test(activeRole);
    let bounds;
    if (faces.length) {
      bounds = faceAwareBounds(faces, activeImage.naturalWidth, activeImage.naturalHeight, compact);
      status.textContent = `偵測到 ${faces.length} 張人臉，已輔助置中（不辨識身分）`;
    } else {
      status.textContent = '沒有人臉，改用主體偵測…';
      const subject = await detectSubjectForImage(imageName);
      if (!subject) throw new Error('沒有偵測到人臉或明顯主體，保留目前裁切');
      bounds = subjectBounds(subject, activeImage.naturalWidth, activeImage.naturalHeight);
      status.textContent = subject.source === 'alpha'
        ? '未偵測到人臉，已依去背主體置中'
        : '未偵測到人臉，已依顯著性主體置中';
    }
    imgScale = Math.min(boxWidth / bounds.width, boxHeight / bounds.height);
    imgTx = boxX + boxWidth / 2 - (bounds.x + bounds.width / 2) * imgScale;
    imgTy = boxY + boxHeight / 2 - (bounds.y + bounds.height / 2) * imgScale;
    faceGuides = faces;
    drawEditor();
    setTimeout(() => { faceGuides = []; drawEditor(); }, 2200);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !faceDetectionReady;
  }
}

function restoreActiveImage() {
  if (activeImageIndex < 0) return;
  const imageName = images[activeImageIndex];
  delete editedCanvases[imageName];
  delete faceCache[imageName];
  modifiedImages.delete(imageName);
  faceGuides = [];
  getEditedCanvas(imageName);
  document.getElementById('cutout-status').textContent = '已還原為原始圖片';
  drawEditor();
  renderEmulatorPreviews();
}

function downloadJson(payload, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function saveProject() {
  const edits = {};
  modifiedImages.forEach(imageName => {
    const edited = editedCanvases[imageName];
    if (edited) edits[imageName] = edited.toDataURL('image/png');
  });
  const localDate = new Intl.DateTimeFormat('sv-SE').format(new Date());
  downloadJson({
    format: 'line-theme-project',
    version: 1,
    savedAt: new Date().toISOString(),
    sourceImages: images,
    assignments,
    edits,
  }, `line-theme-project-${localDate}.json`);
}

function waitForImageCache(imageNames) {
  return Promise.all(imageNames.map(imageName => new Promise(resolve => {
    if (imageCache[imageName]?.complete) return resolve();
    const image = new Image();
    image.onload = () => { imageCache[imageName] = image; resolve(); };
    image.onerror = resolve;
    image.src = imageName;
  })));
}

async function loadProjectFile(file) {
  const project = JSON.parse(await file.text());
  if (project.format !== 'line-theme-project' || project.version !== 1) {
    throw new Error('不支援的專案檔格式');
  }
  const missing = (project.sourceImages || []).filter(imageName => !images.includes(imageName));
  if (missing.length) throw new Error(`缺少原始圖片：${missing.slice(0, 4).join(', ')}`);
  await waitForImageCache(project.sourceImages || []);
  Object.keys(editedCanvases).forEach(imageName => delete editedCanvases[imageName]);
  Object.keys(faceCache).forEach(imageName => delete faceCache[imageName]);
  modifiedImages.clear();
  assignments = Object.fromEntries(Object.entries(project.assignments || {}).filter(([roleKey, config]) => (
    ROLE_SPECS[roleKey] && images.includes(config.imageName)
  )));
  for (const imageName of Object.keys(project.edits || {})) {
    const image = await loadDataImage(project.edits[imageName]);
    const restored = document.createElement('canvas');
    restored.width = image.naturalWidth;
    restored.height = image.naturalHeight;
    restored.getContext('2d').drawImage(image, 0, 0);
    editedCanvases[imageName] = restored;
    modifiedImages.add(imageName);
  }
  refreshAssignmentUi();
  if (activeImageIndex < 0 && images.length) selectRawImage(0);
  else drawEditor();
  renderEmulatorPreviews();
  document.getElementById('editor-subtitle').textContent = `已載入專案：${file.name}`;
}

function refreshAssignmentUi() {
  Object.keys(ROLE_SPECS).forEach(roleKey => {
    const card = document.getElementById(`status-card-${roleKey}`);
    const icon = document.getElementById(`status-icon-${roleKey}`);
    if (!card || !icon) return;
    const assigned = Boolean(assignments[roleKey]);
    card.className = `summary-item ${assigned ? 'assigned' : 'unassigned'}`;
    icon.innerHTML = assigned ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-regular fa-circle"></i>';
  });
  updateSourceImageBadges();
  updateProgress();
}

// Fetch images list from Node server
function fetchImages() {
  fetch('/api/images')
    .then(res => res.json())
    .then(data => {
      images = data.images;
      renderSourceImages();
      initSummaryTable();
    })
    .catch(err => {
      console.error('Error fetching images:', err);
      document.getElementById('source-list').innerHTML = `
        <div class="loading-state" style="color: #ef4444;">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <p>無法讀取資料夾，請確認統一圖像服務是否正常運行</p>
        </div>
      `;
    });
}

// Render source list
function renderSourceImages() {
  const list = document.getElementById('source-list');
  if (images.length === 0) {
    list.innerHTML = `
      <div class="loading-state">
        <i class="fa-regular fa-image" style="opacity:0.2;"></i>
        <p>沒有發現任何 JPEG 或 PNG 圖片檔案</p>
      </div>
    `;
    return;
  }

  document.getElementById('image-count').textContent = images.length;

  list.innerHTML = images.map((imgName, index) => {
    return `
      <div class="source-item" data-index="${index}">
        <div class="source-thumbnail-container">
          <img class="source-thumbnail" src="${imgName}" alt="${imgName}">
        </div>
        <div class="source-info">
          <div class="source-name" title="${imgName}">${imgName}</div>
          <div class="source-meta" id="meta-${index}">
            <i class="fa-solid fa-spinner fa-spin"></i> 載入中...
          </div>
          <div id="assigned-badge-${index}" style="display:none;"></div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers & load metadata (dimensions)
  document.querySelectorAll('.source-item').forEach(item => {
    const index = parseInt(item.dataset.index);
    const imgName = images[index];

    // Create and cache Image element to read dimensions and perform drawing
    const img = new Image();
    img.src = imgName;
    img.onload = () => {
      imageCache[imgName] = img;
      const meta = document.getElementById(`meta-${index}`);
      if (meta) {
        meta.innerHTML = `<i class="fa-solid fa-expand"></i> ${img.naturalWidth} x ${img.naturalHeight}`;
      }
    };

    item.addEventListener('click', () => {
      selectRawImage(index);
    });
  });
}

// Select raw image
function selectRawImage(index) {
  activeImageIndex = index;
  const imgName = images[index];

  document.querySelectorAll('.source-item').forEach(item => {
    item.classList.remove('active');
  });
  const activeItem = document.querySelector(`.source-item[data-index="${index}"]`);
  if (activeItem) activeItem.classList.add('active');

  // Load image
  activeImage = imageCache[imgName];
  if (!activeImage) {
    activeImage = new Image();
    activeImage.src = imgName;
    activeImage.onload = () => {
      imageCache[imgName] = activeImage;
      setupCanvasEditor();
    };
  } else {
    setupCanvasEditor();
  }

  // Update instructions
  document.getElementById('editor-subtitle').innerHTML = `正在編輯: <strong style="color:var(--accent-color);">${imgName}</strong>. 請在下方選擇要指派的功能。`;
}

// Initialize summary table of the 62 required files
function initSummaryTable() {
  const container = document.getElementById('summary-list');

  let html = '';
  // Loop through all specs
  for (const [key, spec] of Object.entries(ROLE_SPECS)) {
    html += `
      <div class="summary-item unassigned" id="status-card-${key}">
        <span class="role-name" title="${spec.label}">${spec.label}</span>
        <span class="status-icon" id="status-icon-${key}"><i class="fa-regular fa-circle"></i></span>
      </div>
    `;
  }
  container.innerHTML = html;
}

// Setup canvas dimensions and initial placement
function setupCanvasEditor() {
  if (!activeImage) return;

  // Make canvas visible
  canvas.style.display = 'block';
  document.getElementById('canvas-placeholder').style.display = 'none';
  overlay.style.display = 'flex';

  // Enable toolbars
  document.getElementById('editor-toolbar').style.opacity = '1';
  document.getElementById('editor-toolbar').style.pointerEvents = 'auto';
  document.getElementById('silhouette-toolbar').style.opacity = '1';
  document.getElementById('silhouette-toolbar').style.pointerEvents = 'auto';
  document.getElementById('btn-auto-remove').disabled = !backgroundRemovalReady;
  document.getElementById('btn-face-crop').disabled = !faceDetectionReady;
  document.getElementById('btn-restore-image').disabled = false;

  // Resize canvas to match its screen layout container
  const rect = container.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  // Default placing: Fit image inside the editor window
  resetImagePlacement();

  // Update crop overlay box based on selected role
  updateCropOverlayBox();
  drawEditor();
}

// Reset image position and scale to fit container
function resetImagePlacement() {
  if (!activeImage) return;

  const canvasRatio = canvas.width / canvas.height;
  const imgRatio = activeImage.naturalWidth / activeImage.naturalHeight;

  if (imgRatio > canvasRatio) {
    imgScale = canvas.width / activeImage.naturalWidth;
  } else {
    imgScale = canvas.height / activeImage.naturalHeight;
  }

  imgTx = (canvas.width - activeImage.naturalWidth * imgScale) / 2;
  imgTy = (canvas.height - activeImage.naturalHeight * imgScale) / 2;
}

// Update overlay box size based on chosen role and canvas dimensions
function updateCropOverlayBox() {
  const roleVal = document.getElementById('role-select').value;
  if (!roleVal) {
    // Default aspect box (e.g. chat window 1482x1334 scale)
    setCropBoxSize(1482, 1334, '請指派功能元件...');
    return;
  }

  activeRole = roleVal;

  let spec = ROLE_SPECS[roleVal];

  // If a group option is selected (like menu_all), use the first sub-spec for aspect ratio
  if (GROUP_ROLES[roleVal]) {
    const firstSubKey = GROUP_ROLES[roleVal][0];
    spec = ROLE_SPECS[firstSubKey];
    targetLabel.textContent = `[多重套用] ` + spec.label.split(')')[0] + ')';
  } else {
    targetLabel.textContent = spec.label;
  }

  setCropBoxSize(spec.width, spec.height);

  // If the user already had a saved crop for this specific role, restore it
  if (assignments[roleVal] && assignments[roleVal].imageName === images[activeImageIndex]) {
    imgScale = assignments[roleVal].scale;
    imgTx = assignments[roleVal].tx;
    imgTy = assignments[roleVal].ty;

    // Restore silhouette controls
    document.getElementById('check-silhouette').checked = !!assignments[roleVal].isSilhouette;
    document.getElementById('silhouette-threshold').value = assignments[roleVal].silhouetteThreshold !== undefined ? assignments[roleVal].silhouetteThreshold : 10;
    document.getElementById('threshold-val').textContent = assignments[roleVal].silhouetteThreshold !== undefined ? assignments[roleVal].silhouetteThreshold : 10;
    document.getElementById('silhouette-color').value = assignments[roleVal].silhouetteColor || '#888888';
  } else {
    // Reset silhouette controls to default
    document.getElementById('check-silhouette').checked = false;
    document.getElementById('silhouette-threshold').value = 10;
    document.getElementById('threshold-val').textContent = 10;
    document.getElementById('silhouette-color').value = '#888888';
  }
}

// Set target crop bounding box in center of screen
function setCropBoxSize(targetW, targetH) {
  // Max width or height of the crop box is 80% of container size
  const maxW = canvas.width * 0.8;
  const maxH = canvas.height * 0.8;

  const aspect = targetW / targetH;

  if (maxW / maxH > aspect) {
    boxHeight = maxH;
    boxWidth = maxH * aspect;
  } else {
    boxWidth = maxW;
    boxHeight = maxW / aspect;
  }

  boxX = (canvas.width - boxWidth) / 2;
  boxY = (canvas.height - boxHeight) / 2;

  targetBox.style.width = `${boxWidth}px`;
  targetBox.style.height = `${boxHeight}px`;

  drawEditor();
}

// Main Draw Loop for canvas
function drawEditor() {
  if (!activeImage) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const editedCanvas = getEditedCanvas(images[activeImageIndex]);
  if (!editedCanvas) return;

  // Draw edited image (with any eraser marks) with transformation matrix
  ctx.save();
  ctx.translate(imgTx, imgTy);
  ctx.scale(imgScale, imgScale);
  ctx.drawImage(editedCanvas, 0, 0);
  ctx.restore();

  // Apply silhouette filter if enabled
  const isSilhouette = document.getElementById('check-silhouette').checked;
  if (isSilhouette) {
    const threshold = parseInt(document.getElementById('silhouette-threshold').value);
    const color = document.getElementById('silhouette-color').value;
    applySilhouetteFilterToCanvas(canvas, threshold, color);
  }

  if (faceGuides.length) {
    ctx.save();
    ctx.translate(imgTx, imgTy);
    ctx.scale(imgScale, imgScale);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = Math.max(2, 3 / imgScale);
    ctx.setLineDash([10 / imgScale, 6 / imgScale]);
    faceGuides.forEach(face => ctx.strokeRect(face.x, face.y, face.width, face.height));
    ctx.restore();
  }

  // Draw eraser brush cursor overlay on top of everything
  if (isEraserMode && isMouseOverCanvas) {
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(mouseCanvasX, mouseCanvasY, eraserSize, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// Setup Mouse, Touch, Wheel Event Listeners for Editor
function setupEventListeners() {

  // Handle window resizing
  window.addEventListener('resize', () => {
    if (activeImage) {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      updateCropOverlayBox();
      drawEditor();
    }
  });

  // Helper to erase at client point
  function eraseAtPoint(e) {
    if (activeImageIndex === -1) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Translate back to image space
    const imgX = (mx - imgTx) / imgScale;
    const imgY = (my - imgTy) / imgScale;
    const radius = eraserSize / imgScale;

    const ec = getEditedCanvas(images[activeImageIndex]);
    if (ec) {
      const eCtx = ec.getContext('2d');
      eCtx.save();
      eCtx.fillStyle = 'rgba(0,0,0,1)';
      eCtx.globalCompositeOperation = 'destination-out';
      eCtx.beginPath();
      eCtx.arc(imgX, imgY, radius, 0, Math.PI * 2);
      eCtx.fill();
      eCtx.restore();
      modifiedImages.add(images[activeImageIndex]);
      delete faceCache[images[activeImageIndex]];
    }
  }

  // Canvas Mouse down
  container.addEventListener('mousedown', e => {
    if (!activeImage) return;
    if (isEraserMode) {
      eraseAtPoint(e);
      isDragging = true; // Still flag dragging to allow dragging-to-erase
      return;
    }
    isDragging = true;
    startX = e.clientX - imgTx;
    startY = e.clientY - imgTy;
  });

  // Canvas Mouse move
  window.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    mouseCanvasX = e.clientX - rect.left;
    mouseCanvasY = e.clientY - rect.top;

    isMouseOverCanvas = (e.clientX >= rect.left && e.clientX <= rect.right &&
                         e.clientY >= rect.top && e.clientY <= rect.bottom);

    if (isEraserMode) {
      if (isDragging && isMouseOverCanvas) {
        eraseAtPoint(e);
      }
      drawEditor(); // Redraw cursor circle
      return;
    }

    if (!isDragging || !activeImage) return;
    imgTx = e.clientX - startX;
    imgTy = e.clientY - startY;
    drawEditor();
  });

  // Canvas Mouse up
  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // Mouse leave container
  container.addEventListener('mouseleave', () => {
    isMouseOverCanvas = false;
    drawEditor();
  });

  // Canvas Wheel zooming
  container.addEventListener('wheel', e => {
    if (!activeImage) return;
    e.preventDefault();

    // Zoom around cursor position
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = 1.1;
    let nextScale = imgScale;

    if (e.deltaY < 0) {
      // Zoom in
      nextScale = imgScale * zoomFactor;
    } else {
      // Zoom out
      nextScale = imgScale / zoomFactor;
    }

    // Restrict scale bounds
    nextScale = Math.max(0.05, Math.min(20, nextScale));

    // Adjust translations so the point under cursor remains stable
    imgTx = mouseX - (mouseX - imgTx) * (nextScale / imgScale);
    imgTy = mouseY - (mouseY - imgTy) * (nextScale / imgScale);
    imgScale = nextScale;

    drawEditor();
  }, { passive: false });

  // Toolbar button handlers
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    zoom(1.2);
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    zoom(1 / 1.2);
  });

  document.getElementById('btn-fit').addEventListener('click', () => {
    // Crop box width / image width
    const scaleW = boxWidth / activeImage.naturalWidth;
    const scaleH = boxHeight / activeImage.naturalHeight;
    imgScale = Math.max(scaleW, scaleH);

    imgTx = boxX + (boxWidth - activeImage.naturalWidth * imgScale) / 2;
    imgTy = boxY + (boxHeight - activeImage.naturalHeight * imgScale) / 2;
    drawEditor();
  });

  document.getElementById('btn-center').addEventListener('click', () => {
    imgTx = boxX + (boxWidth - activeImage.naturalWidth * imgScale) / 2;
    imgTy = boxY + (boxHeight - activeImage.naturalHeight * imgScale) / 2;
    drawEditor();
  });

  // Role dropdown changes
  document.getElementById('role-select').addEventListener('change', () => {
    updateCropOverlayBox();
  });

  // Silhouette controls event listeners
  document.getElementById('btn-auto-remove').addEventListener('click', autoRemoveActiveImage);
  document.getElementById('btn-face-crop').addEventListener('click', applyFaceAssistedCrop);
  document.getElementById('btn-restore-image').addEventListener('click', restoreActiveImage);
  document.getElementById('check-silhouette').addEventListener('change', () => {
    const checkbox = document.getElementById('check-silhouette');
    const edited = getEditedCanvas(images[activeImageIndex]);
    if (checkbox.checked && edited && !canvasHasTransparency(edited)) {
      checkbox.checked = false;
      document.getElementById('cutout-status').textContent = '請先按「AI 去背」建立 Alpha 遮罩';
    }
    drawEditor();
  });

  // Eraser Mode toggle
  const eraserBtn = document.getElementById('btn-eraser-mode');
  eraserBtn.addEventListener('click', () => {
    isEraserMode = !isEraserMode;
    if (isEraserMode) {
      eraserBtn.className = 'btn btn-success';
      eraserBtn.innerHTML = '<i class="fa-solid fa-eraser"></i> 橡皮擦模式: ON';
      container.style.cursor = 'crosshair';
    } else {
      eraserBtn.className = 'btn btn-secondary';
      eraserBtn.innerHTML = '<i class="fa-solid fa-eraser"></i> 橡皮擦模式: OFF';
      container.style.cursor = 'grab';
    }
    drawEditor();
  });

  // Eraser size slider
  const eraserSizeSlider = document.getElementById('eraser-size');
  const eraserSizeVal = document.getElementById('eraser-size-val');
  eraserSizeSlider.addEventListener('input', () => {
    eraserSize = parseInt(eraserSizeSlider.value);
    eraserSizeVal.textContent = `${eraserSize}px`;
    drawEditor();
  });

  const threshSlider = document.getElementById('silhouette-threshold');
  const threshVal = document.getElementById('threshold-val');
  threshSlider.addEventListener('input', () => {
    threshVal.textContent = threshSlider.value;
    drawEditor();
  });

  document.getElementById('silhouette-color').addEventListener('input', () => {
    drawEditor();
  });

  // Save Crop Assignment
  document.getElementById('btn-save-crop').addEventListener('click', saveActiveAssignment);

  document.getElementById('btn-save-project').addEventListener('click', saveProject);
  document.getElementById('btn-load-project').addEventListener('click', () => document.getElementById('project-file-input').click());
  document.getElementById('project-file-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await loadProjectFile(file);
    } catch (error) {
      alert(`專案載入失敗：${error.message}`);
    } finally {
      event.target.value = '';
    }
  });

  // 一鍵自動指派 (Auto-Assign)
  document.getElementById('btn-auto-assign').addEventListener('click', autoAssignAll);

  // Generate ZIP
  document.getElementById('btn-generate-zip').addEventListener('click', generateThemeZIP);

  // Close Success Modal
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('modal-overlay').style.display = 'none';
  });
  document.getElementById('btn-close-error').addEventListener('click', () => {
    document.getElementById('modal-overlay').style.display = 'none';
  });

  // Mobile Emulator Tabs Switch
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tabName = btn.dataset.preview;
      document.querySelectorAll('.preview-screen-page').forEach(p => p.classList.remove('active'));

      if (tabName === 'chat') {
        document.getElementById('page-chat').classList.add('active');
      } else if (tabName === 'menu') {
        document.getElementById('page-menu').classList.add('active');
      } else if (tabName === 'passcode') {
        document.getElementById('page-passcode').classList.add('active');
      } else if (tabName === 'profile') {
        document.getElementById('page-profile').classList.add('active');
      }
    });
  });

  // Mobile Skin dots Switch
  document.querySelectorAll('.skin-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.skin-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');

      const skin = dot.dataset.skin;
      const phoneUI = document.getElementById('phone-ui');

      phoneUI.className = 'smartphone-mockup skin-' + skin;
    });
  });

  // Bottom Menu buttons interactivity in emulator
  document.querySelectorAll('.bottom-tab-bar .tab-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.bottom-tab-bar .tab-item').forEach(t => t.classList.remove('active'));
      item.classList.add('active');

      // Sync with pages
      const tabName = item.dataset.btn;
      // We switch to chat page if Chats selected, else we show menu preview page
      document.querySelectorAll('.preview-screen-page').forEach(p => p.classList.remove('active'));
      if (tabName === 'chats') {
        document.getElementById('page-chat').classList.add('active');
        // Activate top tab as well
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.tab-btn[data-preview="chat"]').classList.add('active');
      } else {
        document.getElementById('page-menu').classList.add('active');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.tab-btn[data-preview="menu"]').classList.add('active');
      }
      updateMenuIconsState(tabName);
    });
  });
}

// Zoom helper
function zoom(factor) {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  let nextScale = imgScale * factor;
  nextScale = Math.max(0.05, Math.min(20, nextScale));

  imgTx = centerX - (centerX - imgTx) * (nextScale / imgScale);
  imgTy = centerY - (centerY - imgTy) * (nextScale / imgScale);
  imgScale = nextScale;

  drawEditor();
}

// Save active crop parameters to assignments map
function saveActiveAssignment() {
  if (!activeImage || !activeRole) return;

  const currentImgName = images[activeImageIndex];

  // Get keys to assign (handles grouping cases)
  let keysToAssign = [];
  if (GROUP_ROLES[activeRole]) {
    keysToAssign = GROUP_ROLES[activeRole];
  } else {
    keysToAssign = [activeRole];
  }

  // Store crop values
  keysToAssign.forEach(roleKey => {
    assignments[roleKey] = {
      imageName: currentImgName,
      scale: imgScale,
      tx: imgTx,
      ty: imgTy,
      boxX: boxX,
      boxY: boxY,
      boxWidth: boxWidth,
      boxHeight: boxHeight,
      isSilhouette: document.getElementById('check-silhouette').checked,
      silhouetteThreshold: parseInt(document.getElementById('silhouette-threshold').value),
      silhouetteColor: document.getElementById('silhouette-color').value
    };

    // Update summary table status
    const card = document.getElementById(`status-card-${roleKey}`);
    if (card) {
      card.className = 'summary-item assigned';
      document.getElementById(`status-icon-${roleKey}`).innerHTML = `<i class="fa-solid fa-circle-check"></i>`;
    }
  });

  // Show visual badge on image list item
  updateSourceImageBadges();

  // Update progress
  updateProgress();

  // Render emulator visual previews immediately
  renderEmulatorPreviews();
}

// Update visual badges on the left side menu
function updateSourceImageBadges() {
  images.forEach((imgName, idx) => {
    const badge = document.getElementById(`assigned-badge-${idx}`);
    if (!badge) return;

    // Count how many roles this image is assigned to
    const assignedRoles = Object.entries(assignments)
      .filter(([rKey, rVal]) => rVal.imageName === imgName)
      .map(([rKey]) => {
        const spec = ROLE_SPECS[rKey];
        return spec ? spec.label.split(' ')[0] : rKey;
      });

    // Deduplicate
    const uniqueRoles = [...new Set(assignedRoles)];

    if (uniqueRoles.length > 0) {
      badge.className = 'source-badge-assigned';
      badge.style.display = 'inline-block';
      badge.textContent = `已配置為 ${uniqueRoles[0]} ${uniqueRoles.length > 1 ? '+' + (uniqueRoles.length - 1) : ''}`;
    } else {
      badge.style.display = 'none';
    }
  });
}

function autoAssignmentConfig(record, roleKey, useFaces = false) {
  const spec = ROLE_SPECS[roleKey];
  const canvasW = 500;
  const canvasH = 400;
  const maxW = canvasW * 0.8;
  const maxH = canvasH * 0.8;
  const aspect = spec.width / spec.height;
  const boxW = maxW / maxH > aspect ? maxH * aspect : maxW;
  const boxH = maxW / maxH > aspect ? maxH : maxW / aspect;
  const bX = (canvasW - boxW) / 2;
  const bY = (canvasH - boxH) / 2;
  let scale = Math.max(boxW / record.width, boxH / record.height);
  let centerX = record.width / 2;
  let centerY = record.height / 2;
  if (useFaces && record.faces.length) {
    const compact = /^(menu_|passcode_|profile_)/.test(roleKey);
    const bounds = faceAwareBounds(record.faces, record.width, record.height, compact);
    scale = Math.min(boxW / bounds.width, boxH / bounds.height);
    centerX = bounds.x + bounds.width / 2;
    centerY = bounds.y + bounds.height / 2;
  }
  return {
    imageName: record.name,
    scale,
    tx: bX + boxW / 2 - centerX * scale,
    ty: bY + boxH / 2 - centerY * scale,
    boxX: bX,
    boxY: bY,
    boxWidth: boxW,
    boxHeight: boxH,
    isSilhouette: false,
    silhouetteThreshold: 10,
    silhouetteColor: '#888888',
  };
}

// Batch-analyze dimensions and face locations instead of relying on filename order.
async function autoAssignAll() {
  if (images.length === 0) return;
  const button = document.getElementById('btn-auto-assign');
  const originalLabel = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 批次分析中';
  try {
    const response = await fetch('/api/analyze-images');
    const data = await response.json();
    if (!response.ok || !data.images?.length) throw new Error(data.error || '無法分析素材');
    const records = data.images.filter(record => images.includes(record.name));
    records.forEach(record => { faceCache[record.name] = record.faces || []; });
    const faceArea = record => record.faces.reduce((max, face) => Math.max(max, face.width * face.height), 0) / (record.width * record.height);
    const people = [...records].filter(record => record.faces.length).sort((a, b) => faceArea(b) - faceArea(a));
    const groups = [...records].filter(record => record.faces.length > 1).sort((a, b) => b.faces.length - a.faces.length || faceArea(b) - faceArea(a));
    const portraits = [...records].filter(record => record.faces.length).sort((a, b) => Math.abs(a.width / a.height - 0.72) - Math.abs(b.width / b.height - 0.72));
    const scenic = [...records].sort((a, b) => a.faces.length - b.faces.length || (b.width * b.height) - (a.width * a.height));
    const widest = [...records].sort((a, b) => b.width / b.height - a.width / a.height)[0];
    const fallback = records[0];
    const pickPerson = index => people[index % Math.max(1, people.length)] || fallback;

    const selected = {
      main_cover_ios: portraits[0] || pickPerson(0),
      main_cover_android: portraits[0] || pickPerson(0),
      main_cover_store: portraits[0] || pickPerson(0),
      chat_bg_ios: scenic[0] || fallback,
      chat_bg_android: scenic[0] || fallback,
      menu_bg: widest || fallback,
      profile_user: pickPerson(0),
      profile_group: groups[0] || pickPerson(1),
      passcode_1: pickPerson(1),
      passcode_2: pickPerson(2),
      passcode_3: pickPerson(3),
      passcode_4: pickPerson(4),
      menu_home: pickPerson(5),
      menu_chats: pickPerson(6),
      menu_voom: pickPerson(7),
      menu_today: pickPerson(8),
      menu_wallet: pickPerson(9),
    };
    assignments = {};
    Object.entries(selected).forEach(([roleKey, record]) => {
      assignments[roleKey] = autoAssignmentConfig(record, roleKey, record.faces.length > 0 && roleKey !== 'menu_bg');
    });
    refreshAssignmentUi();
    renderEmulatorPreviews();
    if (activeImageIndex === -1 && images.length) selectRawImage(0);
    document.getElementById('editor-subtitle').textContent = `智慧指派完成：批次分析 ${records.length} 張圖片、${records.reduce((sum, record) => sum + record.faces.length, 0)} 張人臉`;
  } catch (error) {
    alert(`智慧指派失敗：${error.message}`);
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

// Update progress bar at the top
function updateProgress() {
  const total = Object.keys(ROLE_SPECS).length; // 17 core roles
  // Actually, we generate 62 files. In assignments we track the core roles: 17 roles.
  // When compiling we map these 17 roles to 62 files.
  // Let's show progress based on assigned core roles:
  const assigned = Object.keys(assignments).length;

  const pct = Math.round((assigned / total) * 100);

  document.getElementById('progress-text').textContent = `${assigned} / ${total} 元件`;
  document.getElementById('progress-percent').textContent = `${pct}%`;
  document.getElementById('progress-bar').style.width = `${pct}%`;

  // A marketplace package must not silently fill missing roles with unrelated images.
  const generateBtn = document.getElementById('btn-generate-zip');
  if (assigned === total) {
    generateBtn.removeAttribute('disabled');
  } else {
    generateBtn.setAttribute('disabled', 'true');
  }
}

// Generate dataURL from canvas crop configuration
function getCroppedDataURL(roleKey, W, H) {
  const config = assignments[roleKey];
  if (!config) return null;

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = W;
  tempCanvas.height = H;
  const tempCtx = tempCanvas.getContext('2d');

  const editedCanvas = getEditedCanvas(config.imageName);
  if (!editedCanvas) return null;

  const ratio = W / config.boxWidth;
  tempCtx.save();
  tempCtx.translate((config.tx - config.boxX) * ratio, (config.ty - config.boxY) * ratio);
  tempCtx.scale(config.scale * ratio, config.scale * ratio);
  tempCtx.drawImage(editedCanvas, 0, 0);
  tempCtx.restore();

  if (config.isSilhouette) {
    applySilhouetteFilterToCanvas(tempCanvas, config.silhouetteThreshold, config.silhouetteColor);
  }

  return tempCanvas.toDataURL('image/png');
}

// Update visual representations in the Mobile Emulator
function renderEmulatorPreviews() {
  // 1. Chat background
  const chatBgUrl = getCroppedDataURL('chat_bg_ios', 320, 480) ||
                    getCroppedDataURL('chat_bg_android', 320, 480);
  const chatViewport = document.getElementById('chat-bg-preview');
  if (chatBgUrl) {
    chatViewport.style.backgroundImage = `url(${chatBgUrl})`;
  } else {
    chatViewport.style.backgroundImage = 'none';
  }

  // 2. Profile images
  const profileUserUrl = getCroppedDataURL('profile_user', 120, 120);
  const profileGroupUrl = getCroppedDataURL('profile_group', 120, 120);

  if (profileUserUrl) {
    document.getElementById('profile-user-preview').style.backgroundImage = `url(${profileUserUrl})`;
    // Also update conversation avatar mockups
    document.querySelectorAll('.avatar-placeholder').forEach(el => {
      el.style.backgroundImage = `url(${profileUserUrl})`;
    });
    const avatarMenu = document.getElementById('avatar-mock-menu');
    if (avatarMenu) avatarMenu.style.backgroundImage = `url(${profileUserUrl})`;
  } else {
    document.getElementById('profile-user-preview').style.backgroundImage = 'none';
    document.querySelectorAll('.avatar-placeholder').forEach(el => {
      el.style.backgroundImage = 'none';
    });
  }

  if (profileGroupUrl) {
    document.getElementById('profile-group-preview').style.backgroundImage = `url(${profileGroupUrl})`;
  } else {
    document.getElementById('profile-group-preview').style.backgroundImage = 'none';
  }

  // 3. Passcode dots preview (digital state)
  const passcodeActiveUrl = getCroppedDataURL('passcode_1', 60, 60); // Use passcode 1 ON
  if (passcodeActiveUrl) {
    document.getElementById('dot-1').style.backgroundImage = `url(${passcodeActiveUrl})`;
    document.getElementById('dot-1').style.backgroundColor = 'transparent';
    document.getElementById('dot-1').style.border = 'none';
  } else {
    document.getElementById('dot-1').style.backgroundImage = 'none';
    document.getElementById('dot-1').style.backgroundColor = '';
    document.getElementById('dot-1').style.border = '';
  }

  // 4. Menu Buttons icons preview in bottom bar
  const activeTabItem = document.querySelector('.bottom-tab-bar .tab-item.active');
  const activeKey = activeTabItem ? activeTabItem.dataset.btn : 'home';
  updateMenuIconsState(activeKey);
}

// Draw tab bar icons dynamically based on crop data, matching ON/OFF states
function updateMenuIconsState(activeTabKey) {
  const tabs = ['home', 'chats', 'voom', 'today', 'wallet'];

  tabs.forEach(tab => {
    const roleKey = `menu_${tab}`;
    const iconSlot = document.getElementById(`icon-${tab}`);
    if (!iconSlot) return;

    // Get cropped canvas
    const isON = (tab === activeTabKey);
    const canvasURL = getCroppedMenuIconDataURL(roleKey, isON);

    if (canvasURL) {
      iconSlot.innerHTML = '';
      iconSlot.style.backgroundImage = `url(${canvasURL})`;
      iconSlot.style.width = '24px';
      iconSlot.style.height = '24px';
    } else {
      // Restore fallback fontawesome icon
      iconSlot.style.backgroundImage = 'none';
      iconSlot.style.width = '';
      iconSlot.style.height = '';
      if (tab === 'home') iconSlot.innerHTML = '<i class="fa-solid fa-house"></i>';
      if (tab === 'chats') iconSlot.innerHTML = '<i class="fa-solid fa-message"></i>';
      if (tab === 'voom') iconSlot.innerHTML = '<i class="fa-solid fa-play"></i>';
      if (tab === 'today') iconSlot.innerHTML = '<i class="fa-solid fa-newspaper"></i>';
      if (tab === 'wallet') iconSlot.innerHTML = '<i class="fa-solid fa-wallet"></i>';
    }
  });
}

// Generate data URL for menu icon, applying filters for OFF state
function getCroppedMenuIconDataURL(roleKey, isON) {
  const config = assignments[roleKey];
  if (!config) return null;

  const editedCanvas = getEditedCanvas(config.imageName);
  if (!editedCanvas) return null;

  const tempCanvas = document.createElement('canvas');
  // Menu icon dimensions (for preview, use 80x56 px aspect)
  const W = 80;
  const H = 56;
  tempCanvas.width = W;
  tempCanvas.height = H;
  const tempCtx = tempCanvas.getContext('2d');

  const ratio = W / config.boxWidth;

  if (config.isSilhouette) {
    tempCtx.save();
    tempCtx.translate((config.tx - config.boxX) * ratio, (config.ty - config.boxY) * ratio);
    tempCtx.scale(config.scale * ratio, config.scale * ratio);
    tempCtx.drawImage(editedCanvas, 0, 0);
    tempCtx.restore();

    applySilhouetteFilterToCanvas(tempCanvas, config.silhouetteThreshold, config.silhouetteColor);

    if (!isON) {
      // Inactive silhouette: dim alpha
      const ctx2 = tempCanvas.getContext('2d');
      const imgData = ctx2.getImageData(0, 0, W, H);
      const data = imgData.data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) data[i] = 100; // ~40% opacity
      }
      ctx2.putImageData(imgData, 0, 0);
    }
  } else {
    tempCtx.save();
    // Apply visual style filter for OFF state
    if (!isON) {
      // Semi-transparent and desaturated for inactive icons
      tempCtx.filter = 'grayscale(80%) opacity(50%)';
    } else {
      // Rich contrast for active icon
      tempCtx.filter = 'drop-shadow(0px 2px 4px rgba(0,0,0,0.15))';
    }

    tempCtx.translate((config.tx - config.boxX) * ratio, (config.ty - config.boxY) * ratio);
    tempCtx.scale(config.scale * ratio, config.scale * ratio);
    tempCtx.drawImage(editedCanvas, 0, 0);
    tempCtx.restore();
  }

  // If active, draw a small dot under it in the preview to look extra premium
  if (isON) {
    tempCtx.fillStyle = '#10b981';
    tempCtx.beginPath();
    tempCtx.arc(W/2, H - 4, 3, 0, Math.PI * 2);
    tempCtx.fill();
  }

  return tempCanvas.toDataURL('image/png');
}

// -------------------------------------------------------------
// ZIP Compilation and server upload
// -------------------------------------------------------------
function expectedThemeSpecs() {
  const specs = new Map([
    ['ios_thumbnail.png', [200, 284]],
    ['android_thumbnail.png', [136, 202]],
    ['store_thumbnail.png', [198, 278]],
    ['i_11.png', [1472, 150]],
    ['i_20.png', [240, 240]], ['i_21.png', [240, 240]],
    ['a_20.png', [247, 247]], ['a_21.png', [247, 247]],
    ['i_22.png', [1482, 1334]], ['a_22.png', [1300, 1300]],
  ]);
  for (let index = 0; index < 4; index += 1) {
    const off = 12 + index * 2;
    specs.set(`i_${off}.png`, [120, 120]);
    specs.set(`i_${off + 1}.png`, [120, 120]);
    specs.set(`a_${off}.png`, [116, 116]);
    specs.set(`a_${off + 1}.png`, [116, 116]);
  }
  [
    ['i_29', 'i_30'], ['i_03', 'i_04'], ['i_33', 'i_34'],
    ['i_31', 'i_32'], ['i_25', 'i_26'], ['i_27', 'i_28'],
    ['i_37', 'i_38'], ['i_35', 'i_36'], ['i_07', 'i_08'],
  ].forEach(([off, on]) => {
    specs.set(`${off}.png`, [128, 150]);
    specs.set(`${on}.png`, [128, 150]);
    specs.set(`${off}_g.png`, [80, 56]);
    specs.set(`${on}_g.png`, [80, 56]);
  });
  return specs;
}

async function validateThemeFiles(fileList) {
  const errors = [];
  const missingRoles = Object.keys(ROLE_SPECS).filter(roleKey => !assignments[roleKey]);
  if (missingRoles.length) errors.push(`尚未配置 ${missingRoles.length} 個核心元件`);
  const expected = expectedThemeSpecs();
  const names = fileList.map(file => file.name);
  if (fileList.length !== expected.size) errors.push(`檔案數應為 ${expected.size}，實際為 ${fileList.length}`);
  if (new Set(names).size !== names.length) errors.push('存在重複檔名');
  [...expected.keys()].filter(name => !names.includes(name)).forEach(name => errors.push(`缺少 ${name}`));
  names.filter(name => !expected.has(name)).forEach(name => errors.push(`多出未知檔案 ${name}`));

  for (const file of fileList) {
    if (!(file.blob instanceof Blob) || file.blob.size === 0) {
      errors.push(`${file.name} 為空檔案`);
      continue;
    }
    if (file.blob.type !== 'image/png') errors.push(`${file.name} 不是 PNG`);
    const expectedSize = expected.get(file.name);
    if (!expectedSize) continue;
    const bitmap = await createImageBitmap(file.blob);
    if (bitmap.width !== expectedSize[0] || bitmap.height !== expectedSize[1]) {
      errors.push(`${file.name} 尺寸應為 ${expectedSize.join('×')}，實際為 ${bitmap.width}×${bitmap.height}`);
    }
    if (file.name === 'i_11.png') {
      const check = document.createElement('canvas');
      check.width = bitmap.width;
      check.height = bitmap.height;
      const checkContext = check.getContext('2d', { willReadFrequently: true });
      checkContext.drawImage(bitmap, 0, 0);
      const pixels = checkContext.getImageData(0, Math.max(0, bitmap.height - 100), bitmap.width, Math.min(100, bitmap.height)).data;
      for (let alpha = 3; alpha < pixels.length; alpha += 4) {
        if (pixels[alpha] !== 255) {
          errors.push('i_11.png 底部 100px 必須完全不透明');
          break;
        }
      }
    }
    bitmap.close();
    // The server performs loss-aware PNG palette optimization for chat images,
    // then validates the final saved bytes against the 1 MB marketplace limit.
  }
  return errors;
}

function showValidationErrors(errors) {
  document.getElementById('modal-spinner').style.display = 'none';
  document.getElementById('modal-success').style.display = 'none';
  document.getElementById('modal-error').style.display = 'flex';
  const list = document.getElementById('validation-errors');
  list.replaceChildren(...errors.slice(0, 20).map(error => {
    const item = document.createElement('li');
    item.textContent = error;
    return item;
  }));
}

async function generateThemeZIP() {
  // Show spinner
  const overlay = document.getElementById('modal-overlay');
  const spinner = document.getElementById('modal-spinner');
  const successBox = document.getElementById('modal-success');
  const errorBox = document.getElementById('modal-error');

  overlay.style.display = 'flex';
  spinner.style.display = 'flex';
  successBox.style.display = 'none';
  errorBox.style.display = 'none';

  try {
    const zip = new JSZip();

    // We will render and add all 62 required PNG files
    // Let's create an list of files
    const fileList = [];

    // Helper to get fallback role (uses any assigned image to avoid blank files)
    const getFallbackRole = () => {
      return Object.keys(assignments)[0]; // returns the first assigned role
    };

    // Helper to render PNG blob
    const renderPngBlob = (roleKey, W, H, options = {}) => {
      return new Promise(resolve => {
        let config = assignments[roleKey];
        if (!config) {
          // Fallback to another assigned role, or if nothing assigned, we use first raw image
          const fallbackKey = getFallbackRole();
          if (fallbackKey) {
            config = assignments[fallbackKey];
          }
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = W;
        tempCanvas.height = H;
        const tempCtx = tempCanvas.getContext('2d');

        if (!config) {
          // Draw a solid color block if no images whatsoever are assigned
          tempCtx.fillStyle = '#10b981';
          tempCtx.fillRect(0, 0, W, H);
          tempCanvas.toBlob(resolve, 'image/png');
          return;
        }

        const editedCanvas = getEditedCanvas(config.imageName);
        if (!editedCanvas) {
          tempCanvas.toBlob(resolve, 'image/png');
          return;
        }

        const ratio = Math.max(W / config.boxWidth, H / config.boxHeight);
        const drawW = config.boxWidth * ratio;
        const drawH = config.boxHeight * ratio;
        const offsetX = (W - drawW) / 2;
        const offsetY = (H - drawH) / 2;

        if (config.isSilhouette) {
          tempCtx.save();
          tempCtx.translate(offsetX + (config.tx - config.boxX) * ratio, offsetY + (config.ty - config.boxY) * ratio);
          tempCtx.scale(config.scale * ratio, config.scale * ratio);
          tempCtx.drawImage(editedCanvas, 0, 0);
          tempCtx.restore();

          applySilhouetteFilterToCanvas(tempCanvas, config.silhouetteThreshold, config.silhouetteColor);

          if (options.grayscale) {
            // Inactive silhouette: dim alpha
            const imgData = tempCtx.getImageData(0, 0, W, H);
            const data = imgData.data;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 0) data[i] = 100; // ~40% opacity
            }
            tempCtx.putImageData(imgData, 0, 0);
          }
        } else {
          tempCtx.save();
          // Apply filters (e.g. grayscale for OFF, color tints)
          if (options.grayscale) {
            tempCtx.filter = 'grayscale(100%) opacity(60%)';
          }

          tempCtx.translate(offsetX + (config.tx - config.boxX) * ratio, offsetY + (config.ty - config.boxY) * ratio);
          tempCtx.scale(config.scale * ratio, config.scale * ratio);
          tempCtx.drawImage(editedCanvas, 0, 0);
          tempCtx.restore();
        }

        tempCanvas.toBlob(resolve, 'image/png');
      });
    };

    // 1. 主要圖片 A
    fileList.push({ name: 'ios_thumbnail.png', blob: await renderPngBlob('main_cover_ios', 200, 284) });
    fileList.push({ name: 'android_thumbnail.png', blob: await renderPngBlob('main_cover_android', 136, 202) });
    fileList.push({ name: 'store_thumbnail.png', blob: await renderPngBlob('main_cover_store', 198, 278) });

    // 2. 選單背景 C
    fileList.push({ name: 'i_11.png', blob: await renderPngBlob('menu_bg', 1472, 150) });

    // 3. 個人頭像 E
    fileList.push({ name: 'i_20.png', blob: await renderPngBlob('profile_user', 240, 240) });
    fileList.push({ name: 'i_21.png', blob: await renderPngBlob('profile_group', 240, 240) });
    fileList.push({ name: 'a_20.png', blob: await renderPngBlob('profile_user', 247, 247) });
    fileList.push({ name: 'a_21.png', blob: await renderPngBlob('profile_group', 247, 247) });

    // 4. 聊天背景 F
    fileList.push({ name: 'i_22.png', blob: await renderPngBlob('chat_bg_ios', 1482, 1334) });
    fileList.push({ name: 'a_22.png', blob: await renderPngBlob('chat_bg_android', 1300, 1300) });

    // 5. 密碼畫面 D (iOS 8張: i_12 to i_19; Android 8張: a_12 to a_19)
    const passcodeKeys = ['passcode_1', 'passcode_2', 'passcode_3', 'passcode_4'];
    for (let i = 0; i < 4; i++) {
      const key = passcodeKeys[i];
      const offset = i * 2;

      // iOS (120x120)
      const iosOffName = `i_${12 + offset}.png`;
      const iosOnName = `i_${13 + offset}.png`;
      fileList.push({ name: iosOffName, blob: await renderPngBlob(key, 120, 120, { grayscale: true }) });
      fileList.push({ name: iosOnName, blob: await renderPngBlob(key, 120, 120) });

      // Android (116x116)
      const androidOffName = `a_${12 + offset}.png`;
      const androidOnName = `a_${13 + offset}.png`;
      fileList.push({ name: androidOffName, blob: await renderPngBlob(key, 116, 116, { grayscale: true }) });
      fileList.push({ name: androidOnName, blob: await renderPngBlob(key, 116, 116) });
    }

    // 6. 選單按鍵 B
    // We map keys:
    // Home: menu_home (i_29, i_30)
    // Chats: menu_chats (i_03, i_04)
    // VOOM: menu_voom (i_33, i_34)
    // Today: menu_today (i_31, i_32)
    // News: menu_today (i_25, i_26) - (falls back to menu_today)
    // Wallet: menu_wallet (i_27, i_28)
    // Apps: menu_wallet (i_37, i_38) - (falls back to menu_wallet / fallbackRole)
    // Shopping: menu_wallet (i_35, i_36) - (falls back)
    // Calls: menu_chats (i_07, i_08) - (falls back)

    const menuMapping = [
      { key: 'menu_home', off: 'i_29', on: 'i_30' },
      { key: 'menu_chats', off: 'i_03', on: 'i_04' },
      { key: 'menu_voom', off: 'i_33', on: 'i_34' },
      { key: 'menu_today', off: 'i_31', on: 'i_32' },
      { key: 'menu_today', off: 'i_25', on: 'i_26' }, // News
      { key: 'menu_wallet', off: 'i_27', on: 'i_28' },
      { key: 'menu_wallet', off: 'i_37', on: 'i_38' }, // Apps
      { key: 'menu_wallet', off: 'i_35', on: 'i_36' }, // Shopping
      { key: 'menu_chats', off: 'i_07', on: 'i_08' }  // Calls
    ];

    for (const mapping of menuMapping) {
      // Older iOS & Android Size: 128 x 150 px
      fileList.push({ name: `${mapping.off}.png`, blob: await renderPngBlob(mapping.key, 128, 150, { grayscale: true }) });
      fileList.push({ name: `${mapping.on}.png`, blob: await renderPngBlob(mapping.key, 128, 150) });

      // iOS 26+ Size: 80 x 56 px
      fileList.push({ name: `${mapping.off}_g.png`, blob: await renderPngBlob(mapping.key, 80, 56, { grayscale: true }) });
      fileList.push({ name: `${mapping.on}_g.png`, blob: await renderPngBlob(mapping.key, 80, 56) });
    }

    const validationErrors = await validateThemeFiles(fileList);
    if (validationErrors.length) {
      showValidationErrors(validationErrors);
      return;
    }

    // Add all validated files to the ZIP
    fileList.forEach(file => {
      zip.file(file.name, file.blob);
    });

    // Generate zip blob
    const content = await zip.generateAsync({ type: 'blob' });

    // Send ZIP to server
    const response = await fetch('/api/save-zip', {
      method: 'POST',
      body: content
    });

    const result = await response.json();
    if (!response.ok) {
      showValidationErrors(result.errors || [result.error || '伺服器驗證失敗']);
      return;
    }

    if (result.success) {
      // Update modal to success state
      document.getElementById('saved-zip-path').textContent = result.path;
      document.getElementById('zip-size').textContent = `檔案大小: ${(result.size / 1024 / 1024).toFixed(2)} MB`;

      spinner.style.display = 'none';
      successBox.style.display = 'flex';
    } else {
      throw new Error(result.error || 'Server returned error');
    }

  } catch (error) {
    console.error('Error generating theme:', error);
    alert('產生主題包時發生錯誤，請查看主控台或重試！\n錯誤原因: ' + error.message);
    overlay.style.display = 'none';
  }
}

// Utility to turn canvas images into silhouettes
function applySilhouetteFilterToCanvas(canvasElement, threshold, colorHex) {
  const ctxEl = canvasElement.getContext('2d');
  const imgData = ctxEl.getImageData(0, 0, canvasElement.width, canvasElement.height);
  const data = imgData.data;

  // Parse Hex Color
  const rColor = parseInt(colorHex.slice(1, 3), 16);
  const gColor = parseInt(colorHex.slice(3, 5), 16);
  const bColor = parseInt(colorHex.slice(5, 7), 16);

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i+3];
    if (a > threshold) {
      // Alpha is the single source of truth for foreground membership.
      data[i] = rColor;
      data[i+1] = gColor;
      data[i+2] = bColor;
      data[i+3] = a;
    } else {
      data[i+3] = 0;
    }
  }
  ctxEl.putImageData(imgData, 0, 0);
}

// Vector illustration: Classic Individual Portrait Silhouette (similar to Outlook 2010 default avatar)
function drawClassicIndividualSilhouette(ctx, x, y, width, height, fillColor) {
  ctx.save();
  ctx.fillStyle = fillColor;

  const cx = x + width / 2;
  const cy = y + height / 2;

  // Head
  const headRadius = width * 0.22;
  const headY = cy - height * 0.15;
  ctx.beginPath();
  ctx.arc(cx, headY, headRadius, 0, Math.PI * 2);
  ctx.fill();

  // Neck & Shoulders
  ctx.beginPath();
  ctx.moveTo(cx - width * 0.08, headY + headRadius);
  ctx.quadraticCurveTo(cx - width * 0.14, cy + 5, cx - width * 0.36, cy + height * 0.3);
  ctx.lineTo(cx + width * 0.36, cy + height * 0.3);
  ctx.quadraticCurveTo(cx + width * 0.14, cy + 5, cx + width * 0.08, headY + headRadius);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// Vector illustration: Classic Group Portrait Silhouette
function drawClassicGroupSilhouette(ctx, x, y, width, height, fillColor) {
  ctx.save();
  ctx.fillStyle = fillColor;

  const cx = x + width / 2;
  const cy = y + height / 2;

  // Left Avatar (slightly smaller and behind)
  const leftCX = cx - width * 0.12;
  const leftCY = cy + height * 0.02;
  const leftHeadR = width * 0.18;
  const leftHeadY = leftCY - height * 0.15;

  ctx.beginPath();
  ctx.arc(leftCX, leftHeadY, leftHeadR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(leftCX - width * 0.06, leftHeadY + leftHeadR);
  ctx.quadraticCurveTo(leftCX - width * 0.12, leftCY + 5, leftCX - width * 0.3, leftCY + height * 0.25);
  ctx.lineTo(leftCX + width * 0.3, leftCY + height * 0.25);
  ctx.quadraticCurveTo(leftCX + width * 0.12, leftCY + 5, leftCX + width * 0.06, leftHeadY + leftHeadR);
  ctx.closePath();
  ctx.fill();

  // Right Avatar (slightly larger and in front)
  const rightCX = cx + width * 0.12;
  const rightCY = cy + height * 0.05;
  const rightHeadR = width * 0.20;
  const rightHeadY = rightCY - height * 0.15;

  ctx.beginPath();
  ctx.arc(rightCX, rightHeadY, rightHeadR, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(rightCX - width * 0.07, rightHeadY + rightHeadR);
  ctx.quadraticCurveTo(rightCX - width * 0.14, rightCY + 5, rightCX - width * 0.35, rightCY + height * 0.25);
  ctx.lineTo(rightCX + width * 0.35, rightCY + height * 0.25);
  ctx.quadraticCurveTo(rightCX + width * 0.14, rightCY + 5, rightCX + width * 0.07, rightHeadY + rightHeadR);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
