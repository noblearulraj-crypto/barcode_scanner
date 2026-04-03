# ScanLab — Barcode Scanner

A production-grade barcode scanner web app. Runs entirely in the browser — no server, no data uploaded.

## Features

- **4-pass pipeline**: Direct decode → Preprocessed variants → 1D column projection → Manual EAN-13 bit decoder
- **Formats**: EAN-13, UPC-A, QR Code, Code 128, Code 39, ITF, Data Matrix, PDF417, and more
- **Camera support**: Live scanning from device camera
- **Privacy-first**: All processing is local, in-browser via ZXing WebAssembly
- **Scan history**: Last 10 scans stored in session

---

## Deploy to Vercel (Free — 2 minutes)

### Option A: GitHub + Vercel (recommended)

1. Push this folder to a new GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/barcode-scanner.git
   git push -u origin main
   ```

2. Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo

3. Keep all defaults → click **Deploy**

4. Your app is live at `https://your-project.vercel.app` ✓

### Option B: Vercel CLI (one command)

```bash
npm install -g vercel
cd barcode-scanner
vercel
```

Follow the prompts. Free tier is sufficient — no credit card needed.

---

## Local Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Build

```bash
npm run build
npm start
```

---

## Tech Stack

- **Next.js 14** — React framework (Pages Router)
- **@zxing/library** — Multi-format barcode decoder (WASM, runs in browser)
- **Tailwind CSS** — Utility styles
- **Canvas API** — Image preprocessing pipeline (grayscale, threshold, rotation, 1D projection)

## How the 4-Pass Pipeline Works

| Pass | Strategy | Best For |
|------|----------|----------|
| 1 | Direct ZXing decode (4 rotations) | Clean, well-lit images |
| 2 | Preprocessed variants (CLAHE, denoise, upscale, invert) | Slightly degraded images |
| 3 | 1D column projection → synthetic image | Blurry, color-noisy prints |
| 4 | Manual EAN-13 bit decoder | Extreme cases, partial results |

All processing runs in the browser. No image data is ever uploaded.
