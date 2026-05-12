import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = path.join(ROOT, 'storage');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const OUTPUT_DIR = path.join(STORAGE_DIR, 'outputs');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const CODEX_GENERATED_DIR = path.join(process.env.HOME || '', '.codex', 'generated_images');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const SEGMENT_BACKEND = String(process.env.SEGMENT_BACKEND || 'auto').toLowerCase();
const SAM_PYTHON = process.env.SAM_PYTHON || path.join(ROOT, '.venv-seg', 'bin', 'python');
const SAM_CHECKPOINT = process.env.SAM_CHECKPOINT || path.join(ROOT, 'models', 'sam_vit_b_01ec64.pth');
const SAM_MODEL_TYPE = process.env.SAM_MODEL_TYPE || 'vit_b';
const SAM_DEVICE = process.env.SAM_DEVICE || 'cpu';
const SAM_MAX_DIM = Number(process.env.SAM_MAX_DIM || 768);
const FASTSAM_MODEL = process.env.FASTSAM_MODEL || path.join(ROOT, 'models', 'FastSAM-s.pt');
const FASTSAM_DEVICE = process.env.FASTSAM_DEVICE || SAM_DEVICE;
const FASTSAM_MAX_DIM = Number(process.env.FASTSAM_MAX_DIM || 768);
const DEFAULT_IMAGE_PROVIDER = String(process.env.IMAGE_PROVIDER || 'codex').toLowerCase();
const DEFAULT_OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-1.5';
const DEFAULT_IMAGE_API_ENDPOINT = process.env.IMAGE_API_ENDPOINT || '';
const DEFAULT_IMAGE_MODEL = process.env.IMAGE_MODEL || '';
const OPENAI_IMAGES_BASE_URL = process.env.OPENAI_IMAGES_BASE_URL || 'https://api.openai.com/v1';
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 12 * 60 * 1000);
const ASPECT_PRESETS = {
  '1:1': { label: '1:1 square', width: 1024, height: 1024, prompt: 'square 1:1 composition' },
  '16:9': { label: '16:9 landscape', width: 1536, height: 864, prompt: 'wide 16:9 landscape composition' },
  '4:3': { label: '4:3 landscape', width: 1408, height: 1056, prompt: 'classic 4:3 landscape composition' },
  '3:4': { label: '3:4 portrait', width: 1056, height: 1408, prompt: 'vertical 3:4 portrait composition' },
  '9:16': { label: '9:16 vertical', width: 864, height: 1536, prompt: 'tall 9:16 vertical composition' },
};
const STYLE_PRESETS = {
  photo: {
    label: 'Photorealistic editorial',
    prompt: 'photorealistic editorial image, natural textures, believable lens perspective, controlled depth of field, refined but not over-processed',
  },
  cinematic: {
    label: 'Cinematic still',
    prompt: 'cinematic still frame, motivated lighting, atmospheric color grade, strong composition, realistic detail, subtle film grain',
  },
  product: {
    label: 'Premium product',
    prompt: 'premium commercial product visual, clean art direction, precise materials, soft studio lighting, polished shadows, uncluttered composition',
  },
  illustration: {
    label: 'Modern illustration',
    prompt: 'modern editorial illustration, intentional shapes, cohesive color palette, crisp details, expressive but clean visual language',
  },
  anime: {
    label: 'Anime concept',
    prompt: 'high-quality anime concept art, clean linework, expressive lighting, detailed background, polished character design',
  },
};

await Promise.all([mkdir(UPLOAD_DIR, { recursive: true }), mkdir(OUTPUT_DIR, { recursive: true }), mkdir(TMP_DIR, { recursive: true })]);
await seedLocalSamples();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), { headOnly: req.method === 'HEAD' });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/public/')) {
      return serveFile(res, safeJoin(PUBLIC_DIR, url.pathname.replace('/public/', '')), { headOnly: req.method === 'HEAD' });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/storage/')) {
      return serveFile(res, safeJoin(STORAGE_DIR, url.pathname.replace('/storage/', '')), { headOnly: req.method === 'HEAD' });
    }

    if (req.method === 'GET' && url.pathname === '/api/samples') {
      const samples = (await listImages(UPLOAD_DIR)).sort((a, b) => sampleRank(a) - sampleRank(b));
      return sendJson(res, { samples: samples.map((file) => imageMeta(file, 'uploads')) });
    }

    if (req.method === 'GET' && url.pathname === '/api/outputs') {
      const outputs = await listImages(OUTPUT_DIR, { maxDepth: 1 });
      return sendJson(res, { outputs: outputs.map((file) => imageMeta(file, 'outputs')) });
    }

    if (req.method === 'GET' && url.pathname === '/api/presets') {
      return sendJson(res, {
        aspects: Object.entries(ASPECT_PRESETS).map(([id, preset]) => ({ id, ...preset })),
        styles: Object.entries(STYLE_PRESETS).map(([id, preset]) => ({ id, ...preset })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/provider-defaults') {
      const provider = ['codex', 'openai', 'custom'].includes(DEFAULT_IMAGE_PROVIDER) ? DEFAULT_IMAGE_PROVIDER : 'codex';
      return sendJson(res, {
        provider,
        model: providerDefaultModel(provider),
        endpoint: DEFAULT_IMAGE_API_ENDPOINT,
        openaiBaseUrl: OPENAI_IMAGES_BASE_URL,
        hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
        hasCustomKey: Boolean(process.env.IMAGE_API_KEY),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/segment') {
      const body = await readJson(req);
      const imagePath = resolveStorageUrl(body.imageUrl);
      if (!imagePath || !existsSync(imagePath)) return sendJson(res, { error: 'Invalid imageUrl' }, 400);
      const segmentation = await segmentImage(imagePath, { semantic: Boolean(body.semantic) });
      return sendJson(res, segmentation);
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const body = await readJson(req);
      const sourceName = typeof body.name === 'string' ? body.name : 'upload.png';
      const file = await saveDataUrl(body.imageDataUrl, UPLOAD_DIR, sourceName);
      return sendJson(res, { image: imageMeta(file, 'uploads') });
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readJson(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, { error: 'Missing prompt' }, 400);
      const aspect = ASPECT_PRESETS[String(body.aspectRatio || '1:1')] || ASPECT_PRESETS['1:1'];
      const style = STYLE_PRESETS[String(body.stylePreset || 'photo')] || STYLE_PRESETS.photo;
      const provider = resolveImageProvider(body.provider);

      const sourcePath = await generateImageWithProvider(provider, {
        userPrompt: prompt,
        aspect,
        style,
        aspectRatio: String(body.aspectRatio || '1:1'),
        stylePreset: String(body.stylePreset || 'photo'),
      });
      const copied = await copyIntoOutputs(sourcePath, 'generated', { width: aspect.width, height: aspect.height });
      return sendJson(res, { image: imageMeta(copied, 'outputs'), provider: providerPublicMeta(provider) });
    }

    if (req.method === 'POST' && url.pathname === '/api/edit') {
      const body = await readJson(req, 40 * 1024 * 1024);
      const feedback = String(body.feedback || '').trim();
      if (!feedback) return sendJson(res, { error: 'Missing feedback' }, 400);

      const originalPath = resolveStorageUrl(body.imageUrl);
      if (!originalPath || !existsSync(originalPath)) return sendJson(res, { error: 'Invalid imageUrl' }, 400);
      const originalSize = await readImageSize(originalPath);
      const provider = resolveImageProvider(body.provider);

      const overlayPath = await saveDataUrl(body.overlayDataUrl, TMP_DIR, 'selection-overlay.png');
      const maskPath = await saveDataUrl(body.maskDataUrl, TMP_DIR, 'selection-mask.png');

      const sourcePath = await editImageWithProvider(provider, {
        feedback,
        originalPath,
        overlayPath,
        maskPath,
        originalSize,
      });
      const copied = await copyIntoOutputs(sourcePath, 'edited', originalSize);
      return sendJson(res, { image: imageMeta(copied, 'outputs'), provider: providerPublicMeta(provider) });
    }

    return sendJson(res, { error: 'Not found' }, 404);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: error.message || 'Server error' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SemCanvas AI demo: http://${HOST}:${PORT}`);
});

async function seedLocalSamples() {
  const candidates = ['border-collie.png', 'border-collie-red-collar.png'];
  for (const name of candidates) {
    const src = path.join(ROOT, name);
    const dest = path.join(UPLOAD_DIR, name);
    if (existsSync(src) && !existsSync(dest)) await copyFile(src, dest);
  }
}

async function serveFile(res, filePath, options = {}) {
  if (!filePath || !existsSync(filePath)) return sendText(res, 'Not found', 404);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return sendText(res, 'Not found', 404);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': mimeTypes.get(ext) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (options.headOnly) return res.end();
  res.end(await readFile(filePath));
}

function safeJoin(base, requestPath) {
  const clean = decodeURIComponent(requestPath).replace(/^[/\\]+/, '');
  const full = path.resolve(base, clean);
  if (!full.startsWith(path.resolve(base) + path.sep) && full !== path.resolve(base)) {
    throw new Error('Unsafe path');
  }
  return full;
}

async function readJson(req, limit = 10 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function saveDataUrl(dataUrl, dir, originalName) {
  if (typeof dataUrl !== 'string') throw new Error('Missing image data');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) throw new Error('Unsupported image data URL');
  const ext = match[1] === 'image/jpeg' ? '.jpg' : match[1] === 'image/webp' ? '.webp' : '.png';
  const safeBase = path.basename(originalName || 'image').replace(/[^a-z0-9._-]+/gi, '-').replace(/\.(png|jpg|jpeg|webp)$/i, '');
  const file = path.join(dir, `${Date.now()}-${safeBase}${ext}`);
  await writeFile(file, Buffer.from(match[2], 'base64'));
  return file;
}

function resolveImageProvider(input = {}) {
  const requested = String(input?.provider || DEFAULT_IMAGE_PROVIDER || 'codex').toLowerCase();
  const type = ['codex', 'openai', 'custom'].includes(requested) ? requested : 'codex';
  const model = String(input?.model || providerDefaultModel(type) || '').trim();
  const endpoint = String(input?.endpoint || providerDefaultEndpoint(type) || '').trim();
  const apiKey = String(input?.apiKey || providerDefaultApiKey(type) || '').trim();
  if (type === 'openai' && !apiKey) throw new Error('OpenAI provider requires OPENAI_API_KEY or an API key in the UI.');
  if (type === 'custom' && !endpoint) throw new Error('Custom provider requires IMAGE_API_ENDPOINT or an endpoint in the UI.');
  return { type, model, endpoint, apiKey };
}

function providerDefaultModel(type) {
  if (type === 'openai') return DEFAULT_OPENAI_IMAGE_MODEL;
  if (type === 'custom') return DEFAULT_IMAGE_MODEL;
  return 'codex-cli';
}

function providerDefaultEndpoint(type) {
  if (type === 'openai') return OPENAI_IMAGES_BASE_URL;
  if (type === 'custom') return DEFAULT_IMAGE_API_ENDPOINT;
  return '';
}

function providerDefaultApiKey(type) {
  if (type === 'openai') return process.env.OPENAI_API_KEY || process.env.IMAGE_API_KEY || '';
  if (type === 'custom') return process.env.IMAGE_API_KEY || '';
  return '';
}

function providerPublicMeta(provider) {
  return {
    type: provider.type,
    model: provider.model,
    endpoint: provider.type === 'codex' ? '' : provider.endpoint,
  };
}

async function generateImageWithProvider(provider, params) {
  if (provider.type === 'codex') {
    const startedAt = Date.now();
    const finalPrompt = buildGenerationPrompt(params.userPrompt, params.aspect, params.style, { forCodex: true });
    const result = await runCodex({ prompt: finalPrompt });
    return resolveGeneratedImagePath(result.lastMessage, startedAt);
  }

  const prompt = buildGenerationPrompt(params.userPrompt, params.aspect, params.style);
  if (provider.type === 'openai') return generateWithOpenAI(provider, { ...params, prompt });
  if (provider.type === 'custom') return callCustomImageProvider(provider, { task: 'generate', ...params, prompt });
  throw new Error(`Unsupported image provider: ${provider.type}`);
}

async function editImageWithProvider(provider, params) {
  if (provider.type === 'codex') {
    const startedAt = Date.now();
    const finalPrompt = buildEditPrompt(params.feedback, params.originalSize, { forCodex: true });
    const result = await runCodex({ prompt: finalPrompt, images: [params.originalPath, params.maskPath] });
    return resolveGeneratedImagePath(result.lastMessage, startedAt, { allowWorkspacePath: true });
  }

  const prompt = buildEditPrompt(params.feedback, params.originalSize);
  if (provider.type === 'openai') return editWithOpenAI(provider, { ...params, prompt });
  if (provider.type === 'custom') return callCustomImageProvider(provider, { task: 'edit', ...params, prompt });
  throw new Error(`Unsupported image provider: ${provider.type}`);
}

function buildGenerationPrompt(userPrompt, aspect, style, options = {}) {
  return [
    'Generate one finished image from the user request below.',
    'Create exactly one final output image. Do not create multiple variants or contact sheets.',
    `Target aspect ratio and canvas: ${aspect.label}, exactly ${aspect.width}x${aspect.height} pixels if possible.`,
    `Visual style preset: ${style.label}. ${style.prompt}.`,
    'Use this structure when interpreting the request: purpose, subject, action, setting, composition, lighting, color palette, style, constraints.',
    ...(options.forCodex ? [
      'Save the image as a local PNG file.',
      'In the final answer, output only the absolute local file path to the saved image. No Markdown, no explanation.',
    ] : []),
    '',
    `User request: ${userPrompt}`,
  ].join('\n');
}

function buildEditPrompt(feedback, originalSize, options = {}) {
  return [
    'Create a new, flattened image by semantically editing the provided original image.',
    'Use the selection mask only to identify the intended object or part. White/transparent selected area means the rough region to edit; the rest is context/reference.',
    'The mask is only a rough semantic pointer. It is not a texture, color, alpha layer, transparency, paint stroke, or visual effect to copy into the output.',
    '',
    'Semantic editing requirements:',
    '- Interpret the user feedback first, then use the mask only to identify the intended object or part.',
    '- If the brush is imprecise, infer the coherent semantic target from the image and user feedback; do not restrict the edit to raw brush pixels when that would create a pasted blob.',
    '- Replace/regenerate the underlying image content so the result looks like a natural photograph or illustration, not a colored overlay.',
    '- Do not create any semi-transparent layer, tint wash, mask visualization, red/gold paint blob, or pasted patch.',
    '- Do not solve this by applying a flat PIL/OpenCV color overlay or alpha blend to the selected pixels.',
    '- Preserve the original background, composition, lighting direction, camera angle, pose, and unmentioned objects as much as possible.',
    `- Preserve the original image resolution exactly: ${originalSize.width}x${originalSize.height} pixels.`,
    '- Use generative image editing if available; do not return only instructions.',
    '- Create exactly one final output image. Do not create multiple variants.',
    ...(options.forCodex ? [
      '- Image 1 is the original image.',
      '- Image 2 is an aligned black/white selection mask. White means the rough area the user pointed at; black means background/reference.',
      '- Stop immediately after saving the final output image.',
      '- Save the edited result as a local PNG file.',
      '- In the final answer, output only the absolute local file path to the saved image. No Markdown, no explanation.',
    ] : []),
    '',
    `User feedback for the selected region: ${feedback}`,
  ].join('\n');
}

async function generateWithOpenAI(provider, params) {
  const response = await fetchJson(`${trimTrailingSlash(provider.endpoint || OPENAI_IMAGES_BASE_URL)}/images/generations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model || DEFAULT_OPENAI_IMAGE_MODEL,
      prompt: params.prompt,
      size: openAIImageSizeForAspect(params.aspectRatio),
      n: 1,
    }),
  });
  return saveProviderImageResponse(response, 'openai-generated.png');
}

async function editWithOpenAI(provider, params) {
  const prepared = await prepareOpenAIEditInputs(params.originalPath, params.maskPath);
  const form = new FormData();
  form.append('model', provider.model || DEFAULT_OPENAI_IMAGE_MODEL);
  form.append('prompt', params.prompt);
  form.append('size', openAIImageSizeForDimensions(params.originalSize));
  form.append('image', await fileBlob(prepared.imagePath), path.basename(prepared.imagePath));
  form.append('mask', await fileBlob(prepared.maskPath), path.basename(prepared.maskPath));

  const response = await fetchJson(`${trimTrailingSlash(provider.endpoint || OPENAI_IMAGES_BASE_URL)}/images/edits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}` },
    body: form,
  });
  return saveProviderImageResponse(response, 'openai-edited.png');
}

async function callCustomImageProvider(provider, params) {
  const body = {
    task: params.task,
    model: provider.model,
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    stylePreset: params.stylePreset,
    targetSize: params.aspect ? { width: params.aspect.width, height: params.aspect.height } : params.originalSize,
  };
  if (params.task === 'edit') {
    body.image = await imageFileToDataUrl(params.originalPath);
    body.mask = await imageFileToDataUrl(params.maskPath);
    body.overlay = await imageFileToDataUrl(params.overlayPath);
  }

  const response = await fetchJson(provider.endpoint, {
    method: 'POST',
    headers: {
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return saveProviderImageResponse(response, `custom-${params.task}.png`);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.raw || response.statusText;
    throw new Error(`Image provider request failed (${response.status}): ${message}`);
  }
  return payload;
}

async function saveProviderImageResponse(payload, fileName) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload;
  const dataUrl = item?.imageDataUrl || item?.dataUrl || payload?.imageDataUrl || payload?.dataUrl;
  if (dataUrl) return saveDataUrl(dataUrl, TMP_DIR, fileName);

  const base64 = item?.b64_json || item?.b64Json || item?.imageBase64 || item?.base64 || payload?.b64_json || payload?.imageBase64;
  if (base64) {
    const file = path.join(TMP_DIR, `${Date.now()}-${path.basename(fileName).replace(/[^a-z0-9._-]+/gi, '-')}`);
    await writeFile(file, Buffer.from(String(base64).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    return file;
  }

  const url = item?.url || payload?.url || item?.imageUrl || payload?.imageUrl;
  if (url) return saveProviderImageUrl(url, fileName);

  const localPath = item?.path || payload?.path || item?.filePath || payload?.filePath;
  if (localPath && existsSync(localPath)) return localPath;

  throw new Error(`Image provider response did not include an image. Supported fields: data[0].b64_json, imageDataUrl, url, path.`);
}

async function saveProviderImageUrl(url, fileName) {
  if (String(url).startsWith('file://')) {
    const file = decodeURIComponent(String(url).replace(/^file:\/\//, ''));
    if (existsSync(file)) return file;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download provider image (${response.status}): ${response.statusText}`);
  const ext = extensionFromMime(response.headers.get('content-type')) || path.extname(new URL(url).pathname) || '.png';
  const file = path.join(TMP_DIR, `${Date.now()}-${path.basename(fileName, path.extname(fileName))}${ext}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function prepareOpenAIEditInputs(originalPath, maskPath) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const imagePath = path.join(TMP_DIR, `openai-image-${stamp}.png`);
  const alphaMaskPath = path.join(TMP_DIR, `openai-mask-${stamp}.png`);
  const result = await spawnSimple('python3', [
    path.join(ROOT, 'tools', 'prepare_openai_edit_inputs.py'),
    originalPath,
    maskPath,
    imagePath,
    alphaMaskPath,
  ], { cwd: ROOT, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Unable to prepare OpenAI edit inputs: ${result.stderr || result.stdout}`);
  return { imagePath, maskPath: alphaMaskPath };
}

async function fileBlob(file) {
  return new Blob([await readFile(file)], { type: mimeTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream' });
}

async function imageFileToDataUrl(file) {
  const mime = mimeTypes.get(path.extname(file).toLowerCase()) || 'image/png';
  const buffer = await readFile(file);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function openAIImageSizeForAspect(aspectRatio) {
  if (aspectRatio === '1:1') return '1024x1024';
  if (aspectRatio === '3:4' || aspectRatio === '9:16') return '1024x1536';
  return '1536x1024';
}

function openAIImageSizeForDimensions(size) {
  if (!size?.width || !size?.height) return 'auto';
  const ratio = size.width / size.height;
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

function extensionFromMime(mime) {
  if (!mime) return '';
  if (mime.includes('image/png')) return '.png';
  if (mime.includes('image/jpeg')) return '.jpg';
  if (mime.includes('image/webp')) return '.webp';
  return '';
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function runCodex({ prompt, images = [] }) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lastMessagePath = path.join(TMP_DIR, `codex-last-${stamp}.txt`);
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
  for (const image of images) args.push('-i', image);
  args.push('--output-last-message', lastMessagePath, prompt);

  const startedAt = Date.now();
  const { stdout, stderr, code, earlyImagePath } = await spawnCollect('codex', args, {
    cwd: ROOT,
    timeoutMs: CODEX_TIMEOUT_MS,
    watchImagesSince: startedAt - 5000,
    watchDirs: [ROOT, CODEX_GENERATED_DIR],
  });
  const lastMessage = existsSync(lastMessagePath) ? (await readFile(lastMessagePath, 'utf8')).trim() : '';
  if (code !== 0) {
    const details = [stderr, stdout, lastMessage].filter(Boolean).join('\n').slice(-4000);
    throw new Error(`codex exec failed with code ${code}\n${details}`);
  }
  return { stdout, stderr, lastMessage: lastMessage || earlyImagePath || '', startedAt };
}

function spawnCollect(command, args, { cwd, timeoutMs, watchImagesSince, watchDirs = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    let latestImage = null;
    let latestImageSignature = '';
    let latestImageChangedAt = Date.now();
    child.stdin?.end();

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(watcher);
      resolve(payload);
    };

    const fail = (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(watcher);
      reject(error);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (latestImage) {
        finish({ stdout, stderr, code: 0, earlyImagePath: latestImage.path });
      } else {
        fail(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
      }
    }, timeoutMs);

    const watcher = setInterval(async () => {
      if (!watchImagesSince || watchDirs.length === 0 || resolved) return;
      try {
        const found = await latestImageInDirs(watchDirs, { since: watchImagesSince });
        if (!found) return;
        const signature = `${found.path}:${found.mtimeMs}:${found.size}`;
        if (signature !== latestImageSignature) {
          latestImage = found;
          latestImageSignature = signature;
          latestImageChangedAt = Date.now();
          return;
        }
        const hasSettled = Date.now() - latestImageChangedAt > 25_000;
        const hasRunLongEnough = Date.now() - watchImagesSince > 45_000;
        if (hasSettled && hasRunLongEnough) {
          child.kill('SIGTERM');
          finish({ stdout, stderr, code: 0, earlyImagePath: latestImage.path });
        }
      } catch {
        // Image watching is a best-effort fallback; normal process exit still handles success.
      }
    }, 5_000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, code });
    });
  });
}

async function resolveGeneratedImagePath(lastMessage, startedAt, options = {}) {
  const candidates = extractImagePaths(lastMessage);
  for (const file of candidates) {
    if (existsSync(file)) return file;
  }

  if (options.allowWorkspacePath) {
    const recentWorkspaceImages = (await listImages(ROOT, { since: startedAt - 5000, maxDepth: 2 }))
      .filter((file) => !isStorageArtifact(file));
    if (recentWorkspaceImages[0]) return recentWorkspaceImages[0];
  }

  const recentCodexImages = await listImages(CODEX_GENERATED_DIR, { since: startedAt - 5000, maxDepth: 3 });
  if (recentCodexImages[0]) return recentCodexImages[0];
  throw new Error(`Could not find generated image path. Last message: ${lastMessage || '(empty)'}`);
}

function extractImagePaths(text) {
  if (!text) return [];
  const paths = [];
  const fileUrlMatches = text.matchAll(/file:\/\/([^\s)]+\.(?:png|jpg|jpeg|webp))/gi);
  for (const match of fileUrlMatches) paths.push(decodeURIComponent(match[1]));
  const absoluteMatches = text.matchAll(/(\/[^\n\r]+?\.(?:png|jpg|jpeg|webp))/gi);
  for (const match of absoluteMatches) paths.push(match[1].trim().replace(/^file:\/\//, ''));
  return [...new Set(paths)];
}

async function listImages(dir, options = {}) {
  if (!dir || !existsSync(dir)) return [];
  const maxDepth = options.maxDepth ?? 1;
  const files = [];
  await walk(dir, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((item) => item.path);

  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) {
        const fileStat = await stat(full);
        if (!options.since || fileStat.mtimeMs >= options.since) files.push({ path: full, mtimeMs: fileStat.mtimeMs });
      }
    }
  }
}

async function latestImageInDirs(dirs, options = {}) {
  const stats = [];
  for (const dir of dirs) {
    const maxDepth = dir === ROOT ? 1 : 3;
    for (const file of await listImages(dir, { since: options.since, maxDepth })) {
      if (isStorageArtifact(file)) continue;
      try {
        const fileStat = await stat(file);
        stats.push({ path: file, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
      } catch {
        // Ignore files that disappeared while scanning.
      }
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats[0] || null;
}

function isStorageArtifact(file) {
  const full = path.resolve(file);
  const storageRoot = path.resolve(STORAGE_DIR);
  return full.startsWith(`${storageRoot}${path.sep}`);
}

async function copyIntoOutputs(sourcePath, prefix, targetSize = null) {
  const ext = path.extname(sourcePath) || '.png';
  const dest = path.join(OUTPUT_DIR, `${Date.now()}-${prefix}${ext}`);
  if (targetSize?.width && targetSize?.height) {
    await fitImageToDimensions(sourcePath, dest, targetSize);
  } else {
    await copyFile(sourcePath, dest);
  }
  return dest;
}

async function readImageSize(file) {
  const code = [
    'from PIL import Image',
    'import json, sys',
    'with Image.open(sys.argv[1]) as im:',
    '    print(json.dumps({"width": im.width, "height": im.height}))',
  ].join('\n');
  const result = await spawnSimple('python3', ['-c', code, file], { cwd: ROOT, timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error(`Unable to read image size: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

async function fitImageToDimensions(sourcePath, destPath, targetSize) {
  const result = await spawnSimple('python3', [
    path.join(ROOT, 'tools', 'fit_image.py'),
    sourcePath,
    destPath,
    String(targetSize.width),
    String(targetSize.height),
    '--mode',
    'cover',
  ], { cwd: ROOT, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Unable to normalize image dimensions: ${result.stderr || result.stdout}`);
}

function spawnSimple(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
    }, timeoutMs);
    child.stdin?.end();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function imageMeta(file, bucket) {
  return {
    path: file,
    url: `/storage/${bucket}/${encodeURIComponent(path.basename(file))}`,
    name: path.basename(file),
  };
}

function resolveStorageUrl(imageUrl) {
  if (typeof imageUrl !== 'string') return null;
  const urlPath = imageUrl.split('?')[0];
  if (urlPath.startsWith('/storage/uploads/')) return safeJoin(UPLOAD_DIR, urlPath.replace('/storage/uploads/', ''));
  if (urlPath.startsWith('/storage/outputs/')) return safeJoin(OUTPUT_DIR, urlPath.replace('/storage/outputs/', ''));
  return null;
}

function compactCodexResult(result) {
  return {
    lastMessage: result.lastMessage,
    stderrTail: result.stderr.slice(-1600),
  };
}

function sampleRank(file) {
  const name = path.basename(file);
  if (name === 'border-collie.png') return 0;
  if (name === 'border-collie-red-collar.png') return 1;
  return 2;
}

async function segmentImage(imagePath, options = {}) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outDir = path.join(TMP_DIR, 'segments', stamp);
  await mkdir(outDir, { recursive: true });
  const runner = selectSegmentationRunner();
  const result = await spawnSimple(runner.command, runner.args(imagePath, outDir, options), { cwd: ROOT, timeoutMs: runner.timeoutMs });
  if (result.code !== 0) throw new Error(`Segmentation failed: ${result.stderr || result.stdout}`);
  let payload = JSON.parse(result.stdout.trim());
  if (options.semantic) {
    payload = await enhanceSegmentsWithCodex(imagePath, outDir, payload);
  }
  const baseUrl = `/storage/tmp/segments/${encodeURIComponent(stamp)}`;
  return {
    backend: payload.backend,
    width: payload.width,
    height: payload.height,
    semantic: payload.semantic,
    segments: payload.segments.map((segment) => ({
      id: segment.id,
      label: segment.label,
      score: segment.score,
      areaRatio: segment.areaRatio,
      bbox: segment.bbox,
      sourceIds: segment.sourceIds,
      maskUrl: `${baseUrl}/${encodeURIComponent(segment.maskFile)}`,
      previewUrl: `${baseUrl}/${encodeURIComponent(segment.previewFile)}`,
    })),
  };
}

function selectSegmentationRunner() {
  const fallback = {
    command: 'python3',
    timeoutMs: 60_000,
    args: (imagePath, outDir) => [
      path.join(ROOT, 'tools', 'segment_image.py'),
      imagePath,
      outDir,
    ],
  };

  if (SEGMENT_BACKEND === 'fallback' || SEGMENT_BACKEND === 'numpy') return fallback;

  const samReady = existsSync(SAM_PYTHON) && hasUsableSamCheckpoint();
  if (samReady && SEGMENT_BACKEND !== 'fastsam') return {
    command: SAM_PYTHON,
    timeoutMs: 180_000,
    args: (imagePath, outDir, options = {}) => [
      path.join(ROOT, 'tools', 'segment_sam.py'),
      imagePath,
      outDir,
      '--checkpoint',
      SAM_CHECKPOINT,
      '--model-type',
      SAM_MODEL_TYPE,
      '--device',
      SAM_DEVICE,
      '--max-dim',
      String(SAM_MAX_DIM),
      '--max-masks',
      String(options.semantic ? 16 : 8),
    ],
  };

  if (SEGMENT_BACKEND === 'sam') {
    throw new Error(`SAM backend is not ready. Run tools/setup_sam.sh first, or use SEGMENT_BACKEND=fallback. Missing: ${[
      existsSync(SAM_PYTHON) ? null : SAM_PYTHON,
      hasUsableSamCheckpoint() ? null : SAM_CHECKPOINT,
    ].filter(Boolean).join(', ')}`);
  }

  const fastSamReady = existsSync(SAM_PYTHON) && hasUsableFastSamModel();
  if (fastSamReady) return {
    command: SAM_PYTHON,
    timeoutMs: 240_000,
    args: (imagePath, outDir, options = {}) => [
      path.join(ROOT, 'tools', 'segment_fastsam.py'),
      imagePath,
      outDir,
      '--model',
      FASTSAM_MODEL,
      '--device',
      FASTSAM_DEVICE,
      '--max-dim',
      String(FASTSAM_MAX_DIM),
      '--max-masks',
      String(options.semantic ? 16 : 8),
    ],
  };

  if (SEGMENT_BACKEND === 'fastsam') {
    throw new Error(`FastSAM backend is not ready. Run tools/setup_fastsam.sh first, or use SEGMENT_BACKEND=fallback. Missing: ${[
      existsSync(SAM_PYTHON) ? null : SAM_PYTHON,
      hasUsableFastSamModel() ? null : FASTSAM_MODEL,
    ].filter(Boolean).join(', ')}`);
  }

  return fallback;
}

function hasUsableSamCheckpoint() {
  try {
    return existsSync(SAM_CHECKPOINT) && statSync(SAM_CHECKPOINT).size > 300 * 1024 * 1024;
  } catch {
    return false;
  }
}

function hasUsableFastSamModel() {
  try {
    return existsSync(FASTSAM_MODEL) && statSync(FASTSAM_MODEL).size > 20 * 1024 * 1024;
  } catch {
    return false;
  }
}

async function enhanceSegmentsWithCodex(imagePath, outDir, payload) {
  if (!payload.segments?.length) return { ...payload, semantic: { enabled: true, error: 'No candidate masks' } };

  const rawPayloadPath = path.join(outDir, 'segments-raw.json');
  const sheetPath = path.join(outDir, 'segments-contact-sheet.jpg');
  await writeFile(rawPayloadPath, JSON.stringify(payload, null, 2));
  const sheetResult = await spawnSimple('python3', [
    path.join(ROOT, 'tools', 'segment_contact_sheet.py'),
    imagePath,
    rawPayloadPath,
    outDir,
    sheetPath,
  ], { cwd: ROOT, timeoutMs: 60_000 });
  if (sheetResult.code !== 0) {
    return { ...payload, semantic: { enabled: true, error: sheetResult.stderr || sheetResult.stdout } };
  }

  const candidates = payload.segments.map((segment) => [
    `${segment.id}: label=${segment.label}`,
    `area=${segment.areaRatio}`,
    `bbox=${JSON.stringify(segment.bbox)}`,
  ].join(', ')).join('\n');

  const prompt = [
    'You are improving mask candidates for a local image editing tool.',
    'Image 1 is the original image.',
    'Image 2 is a contact sheet. Each tile shows one candidate mask as an orange overlay with its id, label, and area.',
    '',
    'Task:',
    '- Select the most useful semantic regions a user would want to click for image editing.',
    '- Prefer coherent real-world objects and large scene regions: animals, people, products, walls, sky, road, water, foreground, background.',
    '- Prefer a complete object mask over small fragments.',
    '- Remove duplicate masks, tiny accidental fragments, and masks that only cover random texture.',
    '- You may merge multiple source ids when together they form one useful region.',
    '- Use short Simplified Chinese labels, 2 to 8 Chinese characters when possible.',
    '- Return 3 to 8 regions. The first region should be the main subject if a clear subject exists.',
    '',
    'Candidate ids:',
    candidates,
    '',
    'Return JSON only. No Markdown, no explanation.',
    'Schema:',
    '{"segments":[{"label":"猫咪主体","sourceIds":["seg-01"],"confidence":0.95},{"label":"围墙","sourceIds":["seg-03"],"confidence":0.9}]}',
    '',
    'Rules:',
    '- sourceIds must only use candidate ids listed above.',
    '- Do not invent new ids.',
    '- Do not include a reason field.',
  ].join('\n');

  try {
    const result = await runCodex({ prompt, images: [imagePath, sheetPath] });
    const decision = extractJsonObject(result.lastMessage);
    const segments = await applySemanticSelection(outDir, payload.segments, decision.segments || []);
    if (!segments.length) {
      return { ...payload, semantic: { enabled: true, error: 'Codex returned no usable segments', raw: result.lastMessage.slice(0, 1200) } };
    }
    return {
      ...payload,
      backend: `${payload.backend}+codex`,
      segments,
      semantic: {
        enabled: true,
        sheetFile: path.basename(sheetPath),
        raw: result.lastMessage.slice(0, 1200),
      },
    };
  } catch (error) {
    return { ...payload, semantic: { enabled: true, error: error.message } };
  }
}

function extractJsonObject(text) {
  const value = String(text || '').trim();
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
    throw new Error(`Could not parse Codex JSON: ${value.slice(0, 600)}`);
  }
}

async function applySemanticSelection(outDir, rawSegments, decisions) {
  const byId = new Map(rawSegments.map((segment) => [segment.id, segment]));
  const usedKeys = new Set();
  const selected = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const sourceIds = [...new Set((decision.sourceIds || []).filter((id) => byId.has(id)))];
    if (!sourceIds.length) continue;
    const key = sourceIds.slice().sort().join('+');
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const index = selected.length + 1;
    const label = sanitizeChineseLabel(decision.label || byId.get(sourceIds[0]).label || `区域${index}`);
    const merged = await materializeSemanticMask(outDir, rawSegments, sourceIds, index);
    selected.push({
      id: `seg-${String(index).padStart(2, '0')}`,
      label,
      score: clampScore(decision.confidence ?? sourceIds.reduce((sum, id) => sum + Number(byId.get(id).score || 0), 0) / sourceIds.length),
      areaRatio: merged.areaRatio,
      bbox: merged.bbox,
      maskFile: merged.maskFile,
      previewFile: merged.previewFile,
      sourceIds,
    });
    if (selected.length >= 8) break;
  }
  return selected;
}

async function materializeSemanticMask(outDir, rawSegments, sourceIds, index) {
  const byId = new Map(rawSegments.map((segment) => [segment.id, segment]));
  if (sourceIds.length === 1) {
    const segment = byId.get(sourceIds[0]);
    return {
      areaRatio: segment.areaRatio,
      bbox: segment.bbox,
      maskFile: segment.maskFile,
      previewFile: segment.previewFile,
    };
  }
  const maskFile = `semantic-mask-${String(index).padStart(2, '0')}.png`;
  const previewFile = `semantic-mask-${String(index).padStart(2, '0')}-preview.png`;
  const result = await spawnSimple('python3', [
    path.join(ROOT, 'tools', 'merge_masks.py'),
    outDir,
    maskFile,
    previewFile,
    ...sourceIds.map((id) => byId.get(id).maskFile),
  ], { cwd: ROOT, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Mask merge failed: ${result.stderr || result.stdout}`);
  return { ...JSON.parse(result.stdout.trim()), maskFile, previewFile };
}

function sanitizeChineseLabel(value) {
  const text = String(value || '').trim().replace(/[^\p{Script=Han}A-Za-z0-9/（）()_-]+/gu, '');
  return text.slice(0, 16) || '语义区域';
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0.75;
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}
