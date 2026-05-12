# SemCanvas AI

[English](./README.md) | [简体中文](./README.zh-CN.md)

Semantic AI image editing canvas. Generate an image, segment it into editable regions, select a subject or rough brush area, describe the change in natural language, and send the edit to a pluggable image model provider.

This repository is a local-first demo/prototype. It is designed to be easy to fork and adapt for GPT Image, nano-banana-style services, ComfyUI wrappers, or your own image generation gateway.

## Features

- Prompt-to-image generation with aspect ratio and style presets.
- Local image upload and side-by-side original/result comparison.
- Automatic segmentation with `FastSAM`, full `SAM`, or a lightweight fallback.
- Optional LLM semantic cleanup for segmentation candidates.
- Click-to-select segment chips, brush selection, erase, clear, and canvas zoom.
- Semantic local editing: the mask is treated as a rough object pointer, not as a pasted overlay.
- Pluggable image providers:
  - `codex`: local Codex CLI provider for local prototyping.
  - `openai`: OpenAI Images API provider.
  - `custom`: generic HTTP provider for nano-banana, ComfyUI wrappers, or your own service.

## Examples

These are real local demo outputs from the current prototype, not external product mockups.

### What Semantic Selection Should Prove

The important UX is not “write a perfect image prompt.” The intended workflow is:

```text
select a region -> type a short user instruction -> backend expands it with image context, mask, and guardrails
```

For a fair semantic-editing demo, the user-facing instruction should be short. The selection identifies *what* to edit, and the text describes *how* to change it.

| Selected region | User typed | What the backend should infer |
| --- | --- | --- |
| Background around the motorcycle | `背景换成清晨森林山路` | Replace only the selected background, keep the motorcycle stable. |
| Red robot on the desk | `删掉这个` | Remove the selected object and reconstruct the desk underneath. |
| Whole flower market scene | `改成雨夜霓虹` | Preserve layout while changing time, weather, light, and reflections. |
| Cat subject | `换成橘猫` | Edit the selected cat, preserve pose and background. |

### Short Instruction Semantic Examples

These examples were regenerated with short user feedback only. The green overlay on the `Before` image shows the selected mask.

![Short instruction semantic examples](docs/images/example-semantic-short-grid.jpg)

#### Semantic Background Replacement

User typed:

```text
背景换成清晨森林山路
```

![Short background replacement before and after](docs/images/example-semantic-short-background-replace.jpg)

#### Semantic Object Removal

User typed:

```text
删掉这个
```

![Short object removal before and after](docs/images/example-semantic-short-object-removal.jpg)

#### Semantic Scene Transformation

User typed:

```text
改成雨夜霓虹
```

![Short scene transformation before and after](docs/images/example-semantic-short-weather-time-change.jpg)

Some later examples use more explicit stress-test instructions to make README outputs reproducible. They should not be read as the ideal user input.

### App UI

![SemCanvas AI app UI](docs/images/semcanvas-ui.jpg)

### Style Preset Examples

The following examples were created with the local workflow:

```text
/api/generate -> rough region selection or segment mask -> /api/edit -> docs/images
```

![Generated style preset examples](docs/images/example-style-grid.jpg)

#### Photorealistic Editorial (`photo`, `4:3`)

Edit instruction:

```text
把选中的白色陶瓷杯改成深海蓝色釉面杯，保留桌面、光线、背景和摄影构图
```

![Photorealistic editorial before and after](docs/images/example-style-photo.jpg)

#### Cinematic Still (`cinematic`, `16:9`)

Edit instruction:

```text
把选中的红色雨伞改成明亮的向日葵黄色，保留雨夜巷子、石板路、倒影和电影感光线
```

![Cinematic still before and after](docs/images/example-style-cinematic.jpg)

#### Premium Product (`product`, `1:1`)

Edit instruction:

```text
把选中的白色头戴式耳机改成磨砂黑和深石墨高光，保留底座、阴影、构图和摄影棚光线
```

![Premium product before and after](docs/images/example-style-product.jpg)

#### Modern Illustration (`illustration`, `4:3`)

Edit instruction:

```text
只把选中的陶土花盆改成钴蓝色陶瓷花盆，保留绿叶、窗台、构图和现代插画风格
```

![Modern illustration before and after](docs/images/example-style-illustration.jpg)

#### Anime Concept (`anime`, `16:9`)

Edit instruction:

```text
把选中的白色机器人改成樱花粉和奶油白配色，保留姿势、比例、霓虹街景和动漫概念风格
```

![Anime concept before and after](docs/images/example-style-anime.jpg)

### Advanced Edit Examples

These examples are intentionally harder than simple color/material changes. They test rough-mask semantic editing across background replacement, object removal, and global scene transformation.

![Advanced edit examples](docs/images/example-complex-grid.jpg)

#### Background Replacement (`cinematic`, `16:9`)

Edit instruction:

```text
把选中的城市夜市背景替换成清晨有薄雾的松林山路，保留红色复古摩托车的位置、比例、透视和光影融合
```

![Background replacement before and after](docs/images/example-complex-background-replace.jpg)

#### Object Removal And Fill (`photo`, `4:3`)

Edit instruction:

```text
完全移除选中的红色玩具机器人，自然补全下面的木质桌面，保留周围物品、阴影、透视和复杂桌面布局
```

![Object removal before and after](docs/images/example-complex-object-removal.jpg)

#### Weather And Time Change (`photo`, `16:9`)

Edit instruction:

```text
把整张白天花市街景转换成雨夜霓虹版本，保留街道布局、摊位位置、自行车、箱子和整体构图
```

![Weather and time change before and after](docs/images/example-complex-weather-time-change.jpg)

### Region Edit: Dog Coat Color

Edit instruction:

```text
把这只黑白边牧换成金色边牧，毛发自然，保留姿势、背景和光照
```

![Dog coat color before and after](docs/images/example-dog-before-after.jpg)

### Region Edit: Cat Color With Background Preserved

Edit instruction:

```text
把猫咪改成橘色猫，保留姿势、墙面、街道和日落光照
```

![Cat color before and after](docs/images/example-cat-before-after.jpg)

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://127.0.0.1:4321
```

The default provider is `codex`, which calls your local Codex CLI. You can switch providers in the UI under **模型接口**.

## Provider Configuration

You can configure providers from the UI or environment variables.

### 1. Local Codex CLI

```bash
IMAGE_PROVIDER=codex npm start
```

Requirements:

- Local `codex` CLI is installed and authenticated.
- Your local Codex setup can generate/edit images.
- Complex image edits can take several minutes. Use `CODEX_TIMEOUT_MS` if you need a longer local timeout.

This provider is useful for proof-of-concept work. It is not a stable production image API.

### 2. OpenAI Images API

```bash
OPENAI_API_KEY=sk-...
IMAGE_PROVIDER=openai
OPENAI_IMAGE_MODEL=gpt-image-1.5
OPENAI_IMAGES_BASE_URL=https://api.openai.com/v1
npm start
```

In the UI, select `OpenAI GPT Image`. You may leave the API key field empty if `OPENAI_API_KEY` is set on the server.

Notes:

- Generation calls `POST /v1/images/generations`.
- Editing calls `POST /v1/images/edits` with an image and alpha mask.
- The app normalizes output dimensions after generation/editing, so the comparison canvas stays stable.
- Check the current OpenAI image model names and parameters in the official docs before production use: https://platform.openai.com/docs/guides/image-generation

### 3. Custom HTTP Provider

Use this for nano-banana-style APIs, ComfyUI wrappers, Replicate-style gateways, or a small adapter you write yourself.

```bash
IMAGE_PROVIDER=custom
IMAGE_API_ENDPOINT=http://127.0.0.1:8787/image
IMAGE_API_KEY=optional-token
IMAGE_MODEL=nanobanana2
npm start
```

In the UI, select `Custom HTTP` and fill endpoint/model/key as needed.

The app sends JSON.

Generate request:

```json
{
  "task": "generate",
  "model": "nanobanana2",
  "prompt": "Generate one finished image...",
  "aspectRatio": "1:1",
  "stylePreset": "photo",
  "targetSize": { "width": 1024, "height": 1024 }
}
```

Edit request:

```json
{
  "task": "edit",
  "model": "nanobanana2",
  "prompt": "Create a new, flattened image...",
  "targetSize": { "width": 1024, "height": 1024 },
  "image": "data:image/png;base64,...",
  "mask": "data:image/png;base64,...",
  "overlay": "data:image/png;base64,..."
}
```

Supported response shapes:

```json
{ "imageDataUrl": "data:image/png;base64,..." }
```

```json
{ "imageBase64": "..." }
```

```json
{ "url": "https://example.com/result.png" }
```

```json
{ "path": "/absolute/local/result.png" }
```

## Segmentation Setup

The app auto-selects segmentation backends in this order:

```text
SAM checkpoint > FastSAM > lightweight fallback
```

FastSAM is recommended for this demo because it is small and practical locally:

```bash
./tools/setup_fastsam.sh
npm start
```

Full SAM:

```bash
./tools/setup_sam.sh
npm start
```

Force a backend:

```bash
SEGMENT_BACKEND=fastsam npm start
SEGMENT_BACKEND=sam npm start
SEGMENT_BACKEND=fallback npm start
```

Related environment variables:

- `SAM_PYTHON`: segmentation virtualenv Python, default `.venv-seg/bin/python`
- `SAM_CHECKPOINT`: SAM checkpoint path, default `models/sam_vit_b_01ec64.pth`
- `SAM_DEVICE`: default `cpu`
- `SAM_MAX_DIM`: default `768`
- `FASTSAM_MODEL`: default `models/FastSAM-s.pt`
- `FASTSAM_DEVICE`: default follows `SAM_DEVICE`
- `FASTSAM_MAX_DIM`: default `768`

## Usage Flow

1. Generate or upload an image.
2. Click **自动分割**. Keep **LLM 语义整理** enabled if you want semantic cleanup.
3. Choose **选分割** and click a segment, or use **画选区** / **擦除**.
4. Type a natural-language edit instruction.
5. Click **生成修改结果**.
6. Download the result or set it as the new source image for another edit pass.

Example edit prompts:

- `把这只黑白边牧换成金色边牧，毛发自然，保留姿势、背景和光照`
- `把天空改成日落时的粉橙色云层，保持街道和建筑不变`
- `把选中的产品换成磨砂黑材质，保留阴影和拍摄角度`
- `移除墙上的涂鸦，让墙面纹理自然延续`

## Project Structure

```text
public/                 Frontend UI
docs/images/            README screenshots and real before/after examples
server.mjs              Local HTTP server and provider orchestration
tools/                  Python helpers for segmentation, masks, and resizing
storage/uploads/        Local uploaded/source images, gitignored except .gitkeep
storage/outputs/        Generated results, gitignored except .gitkeep
storage/tmp/            Temporary masks/contact sheets, gitignored except .gitkeep
models/                 Local segmentation model weights, gitignored except .gitkeep
```

## Development

```bash
npm run check
npm start
```

The server intentionally uses `cache-control: no-store` for local frontend iteration.

## Security Notes

- This is a local demo. Do not expose it directly to the public internet.
- API keys entered in the UI are stored in browser `localStorage` for convenience. For shared machines, prefer environment variables.
- Generated images, uploads, masks, and temporary files stay on disk under `storage/`.
- Model weights are ignored by git. Download them locally with the setup scripts.

## GitHub Release Checklist

Before pushing:

```bash
npm run check
rm -rf storage/tmp/* storage/outputs/*
find storage/uploads -type f ! -name '.gitkeep' -delete
```

Keep sample images only if you have rights to publish them. Large model files should not be committed.

## Limitations

- The lightweight fallback segmentation is only for interaction testing. Use FastSAM or SAM for real object masks.
- LLM semantic cleanup currently uses the local Codex CLI path. If you want semantic cleanup through another model, adapt `enhanceSegmentsWithCodex` in `server.mjs`.
- Different image providers use different mask semantics. The OpenAI provider converts the UI's white-selected mask into an alpha mask before calling the Images API.
- Custom provider behavior depends on your adapter returning a supported image field.

## License

MIT. See [LICENSE](./LICENSE).
