const stage = document.querySelector('#stage');
const ctx = stage.getContext('2d');
const stageViewport = document.querySelector('#stageViewport');
const emptyState = document.querySelector('#emptyState');
const imageTitle = document.querySelector('#imageTitle');
const openImage = document.querySelector('#openImage');
const statusDot = document.querySelector('#statusDot');
const statusTitle = document.querySelector('#statusTitle');
const statusText = document.querySelector('#statusText');
const generatePrompt = document.querySelector('#generatePrompt');
const aspectRatio = document.querySelector('#aspectRatio');
const stylePreset = document.querySelector('#stylePreset');
const providerSelect = document.querySelector('#providerSelect');
const providerModel = document.querySelector('#providerModel');
const providerEndpoint = document.querySelector('#providerEndpoint');
const providerApiKey = document.querySelector('#providerApiKey');
const providerHint = document.querySelector('#providerHint');
const generateBtn = document.querySelector('#generateBtn');
const uploadInput = document.querySelector('#uploadInput');
const uploadName = document.querySelector('#uploadName');
const sampleBtn = document.querySelector('#sampleBtn');
const segmentSelectBtn = document.querySelector('#segmentSelectBtn');
const segmentBtn = document.querySelector('#segmentBtn');
const semanticSegmentToggle = document.querySelector('#semanticSegmentToggle');
const segmentStatus = document.querySelector('#segmentStatus');
const segmentList = document.querySelector('#segmentList');
const paintBtn = document.querySelector('#paintBtn');
const eraseBtn = document.querySelector('#eraseBtn');
const clearMaskBtn = document.querySelector('#clearMaskBtn');
const brushSize = document.querySelector('#brushSize');
const brushValue = document.querySelector('#brushValue');
const feedback = document.querySelector('#feedback');
const editBtn = document.querySelector('#editBtn');
const historyList = document.querySelector('#historyList');
const refreshOutputsBtn = document.querySelector('#refreshOutputsBtn');
const refreshNowBtn = document.querySelector('#refreshNowBtn');
const autoRefreshToggle = document.querySelector('#autoRefreshToggle');
const resultTitle = document.querySelector('#resultTitle');
const resultImage = document.querySelector('#resultImage');
const resultEmpty = document.querySelector('#resultEmpty');
const openResult = document.querySelector('#openResult');
const downloadResult = document.querySelector('#downloadResult');
const useResultBtn = document.querySelector('#useResultBtn');
const resultViewport = document.querySelector('#resultViewport');
const zoomOutBtn = document.querySelector('#zoomOutBtn');
const zoomResetBtn = document.querySelector('#zoomResetBtn');
const zoomInBtn = document.querySelector('#zoomInBtn');

let currentImage = null;
let currentImageUrl = '';
let currentSourceMeta = null;
let resultMeta = null;
let latestOutputUrl = '';
let maskCanvas = document.createElement('canvas');
let maskCtx = maskCanvas.getContext('2d');
let drawing = false;
let mode = 'paint';
let lastPoint = null;
let historyItems = [];
let busy = false;
let segments = [];
let selectedSegmentIds = new Set();
let segmentRunId = 0;
let stageZoom = 1;
let baseStageSize = { width: 960, height: 720 };

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

stage.width = 960;
stage.height = 720;
updateZoomUi();
loadProviderSettings();
loadInitialState();

const resizeObserver = new ResizeObserver(() => {
  if (currentImage) {
    fitStageToImage(currentImage);
    render();
  } else {
    updateZoomUi();
  }
});
resizeObserver.observe(stageViewport);
resizeObserver.observe(resultViewport);

setInterval(() => {
  if (autoRefreshToggle.checked && !busy) {
    loadRecentOutputs({ showLatest: false }).catch(() => {});
  }
}, 6500);

async function loadInitialState() {
  try {
    const data = await api('/api/samples');
    if (data.samples?.[0]) {
      addHistory(data.samples[0], '示例图');
      await loadSourceImage(data.samples[0], { title: data.samples[0].name, clearResult: false });
    }
    await loadRecentOutputs({ showLatest: false });
  } catch (error) {
    setStatus('error', 'Load failed', error.message);
  }
}

function setStatus(kind, title, text) {
  statusDot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusText.textContent = text;
}

async function loadProviderSettings() {
  const saved = JSON.parse(localStorage.getItem('semcanvas-provider') || '{}');
  try {
    const defaults = await api('/api/provider-defaults');
    providerSelect.value = saved.provider || defaults.provider || 'codex';
    providerModel.value = saved.model || defaults.model || '';
    providerEndpoint.value = saved.endpoint || defaults.endpoint || (providerSelect.value === 'openai' ? defaults.openaiBaseUrl || 'https://api.openai.com/v1' : '');
    providerApiKey.value = saved.apiKey || '';
    updateProviderUi(defaults);
  } catch {
    providerSelect.value = saved.provider || 'codex';
    providerModel.value = saved.model || '';
    providerEndpoint.value = saved.endpoint || '';
    providerApiKey.value = saved.apiKey || '';
    updateProviderUi();
  }
}

function saveProviderSettings() {
  localStorage.setItem('semcanvas-provider', JSON.stringify(providerConfig()));
}

function providerConfig() {
  return {
    provider: providerSelect.value,
    model: providerModel.value.trim(),
    endpoint: providerEndpoint.value.trim(),
    apiKey: providerApiKey.value.trim(),
  };
}

function updateProviderUi(defaults = {}) {
  const provider = providerSelect.value;
  const usesEndpoint = provider !== 'codex';
  providerEndpoint.closest('.provider-field').classList.toggle('hidden', !usesEndpoint);
  providerApiKey.closest('.provider-field').classList.toggle('hidden', !usesEndpoint);
  providerModel.placeholder = provider === 'openai' ? 'gpt-image-1.5' : provider === 'custom' ? 'nanobanana / your-model' : 'codex-cli';
  providerEndpoint.placeholder = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://your-service.example.com/image';
  if (provider === 'codex') {
    providerHint.textContent = '使用本地 Codex CLI，不需要 API key。';
    if (!providerModel.value || providerModel.value.startsWith('gpt-image') || providerModel.value === 'nanobanana2') providerModel.value = 'codex-cli';
  } else if (provider === 'openai') {
    providerHint.textContent = defaults.hasOpenAIKey ? '使用 OpenAI Images API；API key 可留空使用后端环境变量。' : '使用 OpenAI Images API；请填写 API key 或设置 OPENAI_API_KEY。';
    if (!providerEndpoint.value) providerEndpoint.value = defaults.openaiBaseUrl || 'https://api.openai.com/v1';
    if (!providerModel.value || providerModel.value === 'codex-cli' || providerModel.value === 'nanobanana2') providerModel.value = defaults.model || 'gpt-image-1.5';
  } else {
    providerHint.textContent = defaults.hasCustomKey ? '调用自定义 HTTP 图片服务；API key 可留空使用后端环境变量。' : '调用自定义 HTTP 图片服务，适合接 nanobanana、ComfyUI wrapper 或自己的网关。';
    if (!providerModel.value || providerModel.value === 'codex-cli' || providerModel.value.startsWith('gpt-image')) providerModel.value = 'nanobanana2';
  }
}

function setBusy(isBusy) {
  busy = isBusy;
  [generateBtn, editBtn, sampleBtn, uploadInput, segmentSelectBtn, segmentBtn, semanticSegmentToggle, paintBtn, eraseBtn, clearMaskBtn, brushSize, aspectRatio, stylePreset, providerSelect, providerModel, providerEndpoint, providerApiKey].forEach((el) => {
    el.disabled = isBusy;
  });
}

async function loadSourceImage(meta, options = {}) {
  const img = new Image();
  img.decoding = 'async';
  img.src = withCacheBust(meta.url);
  await img.decode();

  currentImage = img;
  currentImageUrl = meta.url;
  currentSourceMeta = meta;
  imageTitle.textContent = options.title || meta.name || 'source image';
  openImage.href = meta.url;
  openImage.classList.remove('hidden');
  emptyState.classList.add('hidden');

  maskCanvas.width = img.naturalWidth;
  maskCanvas.height = img.naturalHeight;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  clearSegments();
  fitStageToImage(img);
  render();

  if (options.clearResult !== false) clearResult();
  requestSegmentation(meta.url, { silent: true }).catch((error) => {
    segmentStatus.textContent = `分割失败：${error.message}`;
  });
}

function showResult(meta, label = '生成结果') {
  resultMeta = meta;
  latestOutputUrl = meta.url;
  resultTitle.textContent = label;
  resultImage.src = withCacheBust(meta.url);
  resultImage.classList.remove('hidden');
  resultEmpty.classList.add('hidden');
  openResult.href = meta.url;
  openResult.classList.remove('hidden');
  downloadResult.href = meta.url;
  downloadResult.download = meta.name || 'semcanvas-ai-result.png';
  downloadResult.classList.remove('hidden');
  useResultBtn.classList.remove('hidden');
  syncResultSizeToStage();
}

function clearResult() {
  resultMeta = null;
  resultTitle.textContent = '等待生成结果';
  resultImage.removeAttribute('src');
  resultImage.removeAttribute('style');
  resultImage.classList.add('hidden');
  resultEmpty.textContent = '新图片会直接显示在这里，并与原图并列比较。';
  resultEmpty.classList.remove('hidden');
  openResult.classList.add('hidden');
  downloadResult.classList.add('hidden');
  downloadResult.removeAttribute('href');
  useResultBtn.classList.add('hidden');
}

function showResultPending(title, text) {
  resultMeta = null;
  resultTitle.textContent = title;
  resultImage.removeAttribute('src');
  resultImage.removeAttribute('style');
  resultImage.classList.add('hidden');
  resultEmpty.textContent = text;
  resultEmpty.classList.remove('hidden');
  openResult.classList.add('hidden');
  downloadResult.classList.add('hidden');
  downloadResult.removeAttribute('href');
  useResultBtn.classList.add('hidden');
}

function fitStageToImage(img) {
  const box = stageViewport.getBoundingClientRect();
  const resultBox = resultViewport.getBoundingClientRect();
  const sharedWidth = Math.min(box.width || resultBox.width, resultBox.width || box.width);
  const sharedHeight = Math.min(box.height || resultBox.height, resultBox.height || box.height);
  const maxWidth = Math.max(260, sharedWidth - 36);
  const maxHeight = Math.max(260, sharedHeight - 36);
  const ratio = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1);
  baseStageSize = {
    width: Math.max(1, Math.round(img.naturalWidth * ratio)),
    height: Math.max(1, Math.round(img.naturalHeight * ratio)),
  };
  applyStageZoom();
}

function applyStageZoom() {
  const width = Math.max(1, Math.round(baseStageSize.width * stageZoom));
  const height = Math.max(1, Math.round(baseStageSize.height * stageZoom));
  stage.width = width;
  stage.height = height;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stageViewport.classList.toggle('is-zoomed', stageZoom > 1.01);
  resultViewport.classList.toggle('is-zoomed', stageZoom > 1.01);
  updateZoomUi();
  syncResultSizeToStage();
}

function setStageZoom(nextZoom) {
  stageZoom = clampZoom(nextZoom);
  if (currentImage) {
    applyStageZoom();
    render();
  } else {
    updateZoomUi();
  }
}

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value) || 1));
}

function updateZoomUi() {
  const percent = `${Math.round(stageZoom * 100)}%`;
  zoomResetBtn.textContent = percent;
  const disabled = !currentImage;
  zoomOutBtn.disabled = disabled || stageZoom <= MIN_ZOOM + 0.001;
  zoomResetBtn.disabled = disabled || Math.abs(stageZoom - 1) < 0.001;
  zoomInBtn.disabled = disabled || stageZoom >= MAX_ZOOM - 0.001;
}

function syncResultSizeToStage() {
  if (!resultMeta || resultImage.classList.contains('hidden') || !stage.width || !stage.height) return;
  resultImage.style.width = `${stage.width}px`;
  resultImage.style.height = `${stage.height}px`;
}

function render() {
  ctx.clearRect(0, 0, stage.width, stage.height);
  if (!currentImage) return;
  ctx.drawImage(currentImage, 0, 0, stage.width, stage.height);

  if (mode === 'segment' && segments.length) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    for (const segment of segments) {
      if (segment.maskCanvas) {
        ctx.drawImage(tintMask(segment.maskCanvas, '#73d0ff'), 0, 0, stage.width, stage.height);
      }
    }
    ctx.restore();
  }

  const maskDisplay = document.createElement('canvas');
  maskDisplay.width = stage.width;
  maskDisplay.height = stage.height;
  const maskDisplayCtx = maskDisplay.getContext('2d');
  maskDisplayCtx.drawImage(maskCanvas, 0, 0, stage.width, stage.height);

  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.drawImage(tintMask(maskDisplay, '#d4a84f'), 0, 0);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.lineWidth = 1.25;
  ctx.drawImage(edgeMask(maskDisplay), 0, 0);
  ctx.restore();
}

function tintMask(mask, color) {
  const tinted = document.createElement('canvas');
  tinted.width = mask.width;
  tinted.height = mask.height;
  const tctx = tinted.getContext('2d');
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, tinted.width, tinted.height);
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(mask, 0, 0);
  return tinted;
}

function edgeMask(mask) {
  const edge = document.createElement('canvas');
  edge.width = mask.width;
  edge.height = mask.height;
  const ectx = edge.getContext('2d');
  for (const dx of [-2, 0, 2]) {
    for (const dy of [-2, 0, 2]) {
      if (dx || dy) ectx.drawImage(mask, dx, dy);
    }
  }
  ectx.globalCompositeOperation = 'destination-out';
  ectx.drawImage(mask, 0, 0);
  ectx.globalCompositeOperation = 'source-in';
  ectx.fillStyle = 'rgba(255,255,255,0.65)';
  ectx.fillRect(0, 0, edge.width, edge.height);
  return edge;
}

function drawAt(event) {
  if (!currentImage) return;
  const point = eventToImagePoint(event);
  if (mode === 'segment') {
    pickSegmentAt(point);
    return;
  }
  const radius = Number(brushSize.value) / 2;
  maskCtx.save();
  maskCtx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
  maskCtx.strokeStyle = 'white';
  maskCtx.fillStyle = 'white';
  maskCtx.lineWidth = radius * 2;
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  if (lastPoint) {
    maskCtx.beginPath();
    maskCtx.moveTo(lastPoint.x, lastPoint.y);
    maskCtx.lineTo(point.x, point.y);
    maskCtx.stroke();
  } else {
    maskCtx.beginPath();
    maskCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    maskCtx.fill();
  }
  maskCtx.restore();
  lastPoint = point;
  render();
}

function clearSegments() {
  segments = [];
  selectedSegmentIds = new Set();
  segmentList.innerHTML = '';
  segmentStatus.textContent = '载入图片后自动提取清晰边界区域';
}

async function requestSegmentation(imageUrl = currentImageUrl, options = {}) {
  if (!imageUrl) return;
  const runId = ++segmentRunId;
  const semantic = Boolean(options.semantic);
  segmentStatus.textContent = semantic ? '正在提取并语义整理区域...' : '正在提取清晰边界区域...';
  if (!options.silent) {
    setStatus('busy', 'Segmenting', semantic ? '正在生成候选 mask，并用视觉模型判断语义区域。' : '正在生成主体、背景和清晰物体候选。');
  }
  const data = await api('/api/segment', { method: 'POST', body: { imageUrl, semantic } });
  if (runId !== segmentRunId) return;
  segments = (data.segments || []).map((segment) => ({ ...segment, maskCanvas: null }));
  selectedSegmentIds = new Set();
  renderSegmentList(data.backend || 'fallback');
  segmentStatus.textContent = `${segments.length} 个清晰边界区域 · ${data.backend || 'fallback'}`;
  await preloadSegmentMasks();
  render();
  if (!options.silent) setStatus('idle', 'Segmented', semantic ? '视觉模型已整理候选区域，可直接点选语义目标。' : '可切到“选分割”后直接点选主体、背景或清晰物体。');
}

function renderSegmentList(backend) {
  segmentList.innerHTML = '';
  if (!segments.length) {
    segmentList.innerHTML = '<div class="segment-empty">没有候选区域</div>';
    return;
  }
  for (const segment of segments) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `segment-chip ${selectedSegmentIds.has(segment.id) ? 'selected' : ''}`;
    chip.title = `${segment.label} · score ${segment.score}`;
    const percent = Math.max(0.1, Number(segment.areaRatio || 0) * 100).toFixed(1);
    chip.innerHTML = `
      <img alt="" src="${withCacheBust(segment.previewUrl)}">
      <span class="segment-copy">
        <strong>${escapeHtml(segment.label)}</strong>
        <small>${escapeHtml(segment.id)} · ${percent}% · ${escapeHtml(backend || '')}</small>
      </span>
    `;
    chip.addEventListener('click', async () => {
      await applySegment(segment);
    });
    segmentList.append(chip);
  }
}

async function preloadSegmentMasks() {
  await Promise.all(segments.slice(0, 18).map((segment) => loadSegmentMask(segment).catch(() => null)));
}

async function loadSegmentMask(segment) {
  if (segment.maskCanvas) return segment.maskCanvas;
  const img = new Image();
  img.decoding = 'async';
  img.src = withCacheBust(segment.maskUrl);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = maskCanvas.width;
  canvas.height = maskCanvas.height;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = c.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    pixels[i] = 255;
    pixels[i + 1] = 255;
    pixels[i + 2] = 255;
    pixels[i + 3] = alpha;
  }
  c.putImageData(imageData, 0, 0);
  segment.maskCanvas = canvas;
  return canvas;
}

async function applySegment(segment) {
  if (!segment) return;
  const canvas = await loadSegmentMask(segment);
  const isSelected = selectedSegmentIds.has(segment.id);
  maskCtx.save();
  maskCtx.globalCompositeOperation = isSelected ? 'destination-out' : 'source-over';
  maskCtx.drawImage(canvas, 0, 0);
  maskCtx.restore();
  if (isSelected) {
    selectedSegmentIds.delete(segment.id);
  } else {
    selectedSegmentIds.add(segment.id);
  }
  renderSegmentList();
  render();
  setStatus('idle', isSelected ? 'Mask removed' : 'Mask selected', `${isSelected ? '已反选' : '已加入选区'}：${segment.label}`);
}

function pickSegmentAt(point) {
  const hits = [];
  for (const segment of segments) {
    if (!segment.maskCanvas) continue;
    const c = segment.maskCanvas.getContext('2d');
    const px = Math.max(0, Math.min(segment.maskCanvas.width - 1, Math.round(point.x)));
    const py = Math.max(0, Math.min(segment.maskCanvas.height - 1, Math.round(point.y)));
    const pixel = c.getImageData(px, py, 1, 1).data;
    if (pixel[3] > 96) hits.push(segment);
  }
  if (!hits.length) {
    setStatus('error', 'No segment', '这个位置没有候选分割区域，可改用画笔。');
    return;
  }
  hits.sort((a, b) => a.areaRatio - b.areaRatio);
  applySegment(hits[0]).catch((error) => setStatus('error', 'Segment failed', error.message));
}

function eventToImagePoint(event) {
  const rect = stage.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * maskCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * maskCanvas.height,
  };
}

function exportMaskDataUrl() {
  const out = document.createElement('canvas');
  out.width = maskCanvas.width;
  out.height = maskCanvas.height;
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  const source = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const target = outCtx.createImageData(out.width, out.height);
  for (let i = 0; i < source.data.length; i += 4) {
    const value = source.data[i + 3] > 16 ? 255 : 0;
    target.data[i] = value;
    target.data[i + 1] = value;
    target.data[i + 2] = value;
    target.data[i + 3] = 255;
  }
  outCtx.putImageData(target, 0, 0);
  return out.toDataURL('image/png');
}

function exportOverlayDataUrl() {
  const out = document.createElement('canvas');
  out.width = currentImage.naturalWidth;
  out.height = currentImage.naturalHeight;
  const outCtx = out.getContext('2d');
  outCtx.drawImage(currentImage, 0, 0);
  const gold = document.createElement('canvas');
  gold.width = out.width;
  gold.height = out.height;
  const goldCtx = gold.getContext('2d');
  goldCtx.fillStyle = '#d4a84f';
  goldCtx.fillRect(0, 0, gold.width, gold.height);
  goldCtx.globalCompositeOperation = 'destination-in';
  goldCtx.drawImage(maskCanvas, 0, 0);
  outCtx.globalAlpha = 0.38;
  outCtx.drawImage(gold, 0, 0);
  return out.toDataURL('image/png');
}

function maskHasPixels() {
  if (!maskCanvas.width || !maskCanvas.height) return false;
  const data = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

async function loadRecentOutputs(options = {}) {
  const data = await api('/api/outputs');
  const outputs = data.outputs || [];
  for (const output of [...outputs].reverse()) addHistory(output, '最近输出');

  const newest = outputs[0];
  if (options.showLatest && newest && newest.url !== latestOutputUrl) {
    showResult(newest, '自动刷新结果');
    addHistory(newest, '自动刷新结果');
  }
}

function addHistory(meta, label) {
  historyItems = historyItems.filter((item) => item.meta.url !== meta.url);
  historyItems.unshift({ meta, label, time: new Date() });
  historyItems = historyItems.slice(0, 18);
  historyList.innerHTML = '';
  for (const item of historyItems) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-item';
    row.innerHTML = `
      <img alt="" src="${withCacheBust(item.meta.url)}">
      <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.meta.name)}</small></span>
    `;
    row.addEventListener('click', () => loadSourceImage(item.meta, { title: item.label }));
    historyList.append(row);
  }
}

function withCacheBust(url) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

stage.addEventListener('pointerdown', (event) => {
  if (mode === 'segment') {
    drawAt(event);
    return;
  }
  drawing = true;
  lastPoint = null;
  stage.setPointerCapture(event.pointerId);
  drawAt(event);
});
stage.addEventListener('pointermove', (event) => { if (drawing) drawAt(event); });
stage.addEventListener('pointerup', () => { drawing = false; lastPoint = null; });
stage.addEventListener('pointercancel', () => { drawing = false; lastPoint = null; });

function setToolMode(nextMode) {
  mode = nextMode;
  segmentSelectBtn.classList.toggle('active', mode === 'segment');
  paintBtn.classList.toggle('active', mode === 'paint');
  eraseBtn.classList.toggle('active', mode === 'erase');
  render();
}

segmentSelectBtn.addEventListener('click', () => setToolMode('segment'));
paintBtn.addEventListener('click', () => setToolMode('paint'));
eraseBtn.addEventListener('click', () => setToolMode('erase'));
segmentBtn.addEventListener('click', () => requestSegmentation(currentImageUrl, { silent: false, semantic: semanticSegmentToggle.checked }).catch((error) => {
  setStatus('error', 'Segmentation failed', error.message);
  segmentStatus.textContent = `分割失败：${error.message}`;
}));
clearMaskBtn.addEventListener('click', () => {
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  selectedSegmentIds = new Set();
  renderSegmentList();
  render();
});
brushSize.addEventListener('input', () => { brushValue.textContent = brushSize.value; });
resultImage.addEventListener('load', syncResultSizeToStage);
zoomOutBtn.addEventListener('click', () => setStageZoom(stageZoom - ZOOM_STEP));
zoomInBtn.addEventListener('click', () => setStageZoom(stageZoom + ZOOM_STEP));
zoomResetBtn.addEventListener('click', () => setStageZoom(1));
providerSelect.addEventListener('change', () => {
  updateProviderUi();
  saveProviderSettings();
});
[providerModel, providerEndpoint, providerApiKey].forEach((el) => {
  el.addEventListener('input', saveProviderSettings);
});

sampleBtn.addEventListener('click', async () => {
  const data = await api('/api/samples');
  if (!data.samples?.[0]) throw new Error('No sample image found');
  uploadName.textContent = 'PNG / JPG / WebP';
  await loadSourceImage(data.samples[0], { title: '示例边牧' });
  setStatus('idle', 'Sample loaded', '筛选区域后输入修改要求。');
});

uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  uploadName.textContent = file.name;
  setBusy(true);
  setStatus('busy', 'Uploading', '正在保存本地图片。');
  try {
    const imageDataUrl = await fileToDataUrl(file);
    const data = await api('/api/upload', { method: 'POST', body: { imageDataUrl, name: file.name } });
    addHistory(data.image, '上传图片');
    await loadSourceImage(data.image, { title: file.name });
    setStatus('idle', 'Image loaded', '可以开始筛选区域。');
  } catch (error) {
    setStatus('error', 'Upload failed', error.message);
  } finally {
    setBusy(false);
  }
});

generateBtn.addEventListener('click', async () => {
  const prompt = generatePrompt.value.trim();
  if (!prompt) return setStatus('error', 'Missing prompt', '先输入图片生成 prompt。');
  setBusy(true);
  showResultPending('正在生成图片', '新图片生成中，完成后会显示在这里。');
  setStatus('busy', 'Generating', '后台模型正在生成图片。自动刷新会检查新输出。');
  try {
    const data = await api('/api/generate', {
      method: 'POST',
      body: {
        prompt,
        aspectRatio: aspectRatio.value,
        stylePreset: stylePreset.value,
        provider: providerConfig(),
      },
    });
    addHistory(data.image, '生成图片');
    await loadSourceImage(data.image, { title: '生成图片', clearResult: false });
    showResult(data.image, '生成图片');
    setStatus('idle', 'Generated', '图片已生成，可以继续筛选修改。');
  } catch (error) {
    setStatus('error', 'Generation failed', error.message);
  } finally {
    setBusy(false);
    loadRecentOutputs({ showLatest: false }).catch(() => {});
  }
});

editBtn.addEventListener('click', async () => {
  if (!currentImageUrl) return setStatus('error', 'No image', '先加载或生成一张图片。');
  if (!maskHasPixels()) return setStatus('error', 'No selection', '先用画笔粗选要修改的区域。');
  const text = feedback.value.trim();
  if (!text) return setStatus('error', 'Missing feedback', '请输入修改要求。');

  setBusy(true);
  showResultPending('正在生成修改结果', '正在根据当前原图、选区和修改要求生成新图片。');
  setStatus('busy', 'Editing', '后台模型正在语义重绘，不会直接把选区图层盖到原图上。');
  try {
    const data = await api('/api/edit', {
      method: 'POST',
      body: {
        imageUrl: currentImageUrl,
        overlayDataUrl: exportOverlayDataUrl(),
        maskDataUrl: exportMaskDataUrl(),
        feedback: text,
        provider: providerConfig(),
      },
    });
    addHistory(data.image, '修改结果');
    showResult(data.image, '修改结果');
    setStatus('idle', 'Edited', '结果已显示在右侧，原图仍保留在左侧。');
  } catch (error) {
    setStatus('error', 'Edit failed', error.message);
  } finally {
    setBusy(false);
    loadRecentOutputs({ showLatest: false }).catch(() => {});
  }
});

async function refreshOutputs(showLatest = true) {
  setStatus('busy', 'Refreshing', '正在读取 storage/outputs。');
  try {
    await loadRecentOutputs({ showLatest });
    setStatus('idle', 'Refreshed', '最近输出已更新。');
  } catch (error) {
    setStatus('error', 'Refresh failed', error.message);
  }
}
refreshOutputsBtn.addEventListener('click', () => refreshOutputs(true));
refreshNowBtn.addEventListener('click', () => refreshOutputs(true));

useResultBtn.addEventListener('click', async () => {
  if (!resultMeta) return;
  await loadSourceImage(resultMeta, { title: '结果作为原图', clearResult: false });
  setStatus('idle', 'Result loaded', '结果已设为新的编辑原图。');
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
