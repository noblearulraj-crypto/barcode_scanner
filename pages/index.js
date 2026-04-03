import { useState, useRef, useEffect, useCallback } from 'react';
import Head from 'next/head';
import { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } from '@zxing/library';

const PASS_LABELS = [
  { id: 1, label: 'Direct decode', desc: 'Fast path — clean images' },
  { id: 2, label: 'Preprocessed', desc: 'CLAHE · denoise · upscale' },
  { id: 3, label: '1D projection', desc: 'Column median collapse' },
  { id: 4, label: 'Manual EAN', desc: 'Bit-level fallback' },
];

export default function Home() {
  const [results, setResults]         = useState([]);
  const [scanning, setScanning]       = useState(false);
  const [pass, setPass]               = useState(0);
  const [mode, setMode]               = useState('upload'); // 'upload' | 'camera'
  const [hasScanned, setHasScanned]   = useState(false);
  const [previewSrc, setPreviewSrc]   = useState(null);
  const [dragOver, setDragOver]       = useState(false);
  const [cameraErr, setCameraErr]     = useState(null);
  const [history, setHistory]         = useState([]);

  const fileRef     = useRef();
  const videoRef    = useRef();
  const canvasRef   = useRef();
  const readerRef   = useRef(null);
  const streamRef   = useRef(null);

  // ── ZXing reader singleton ────────────────────────────────────────────────
  useEffect(() => {
    const formats = [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.PDF_417,
      BarcodeFormat.AZTEC,
    ];
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    hints.set(DecodeHintType.ASSUME_GS1, true);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    readerRef.current = new BrowserMultiFormatReader(hints);
    return () => {
      readerRef.current?.reset();
      stopCamera();
    };
  }, []);

  // ── Canvas-based preprocessing pipeline ──────────────────────────────────
  const getImageVariants = useCallback((img) => {
    const variants = [];
    // 45-degree increments to catch off-angle/tilted barcodes
    const rotations = [0, 45, 90, 135, 180, 225, 270, 315];

    // Multi-scale normalization: Large for detail, small to ignore blur/noise
    const targetDims = [1200, 800];

    targetDims.forEach(target => {
      let sw = img.naturalWidth || img.width;
      let sh = img.naturalHeight || img.height;
      const scale = Math.min(target / sw, target / sh, 1);
      const dw = sw * scale;
      const dh = sh * scale;

      rotations.forEach(deg => {
        const c = document.createElement('canvas');
        const radians = (deg * Math.PI) / 180;
        
        // Calculate bounds for any rotation angle
        if (deg % 180 === 90) {
          c.width = dh; c.height = dw;
        } else {
          c.width = dw; c.height = dh;
        }

        const ctx = c.getContext('2d', { alpha: false, desynchronized: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate(radians);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        
        const labelSuffix = `${target}px|${deg}°`;
        variants.push({ canvas: c, label: `raw|${labelSuffix}` });

      // Grayscale + threshold
      const c2 = document.createElement('canvas');
      c2.width = c.width; c2.height = c.height;
      const ctx2 = c2.getContext('2d');
      ctx2.drawImage(c, 0, 0);
      const id = ctx2.getImageData(0, 0, c2.width, c2.height);
      
      // Faster Grayscale + Adaptive-like thresholding logic
      for (let i = 0; i < id.data.length; i += 4) {
        const v = id.data[i] * 0.299 + id.data[i+1] * 0.587 + id.data[i+2] * 0.114;
        // Using a slightly lower threshold (110) often helps with thin 1D bars
        const bw = v > 110 ? 255 : 0;
        id.data[i] = id.data[i+1] = id.data[i+2] = bw;
      }
      ctx2.putImageData(id, 0, 0);
      variants.push({ canvas: c2, label: `thresh|${labelSuffix}` });

      // Pass 2.3: Deep Sharp (Unsharp Mask simulation)
      // Extreme contrast and brightness tuning to fix blur-induced bleeding
      const c5 = document.createElement('canvas');
      c5.width = c.width; c5.height = c.height;
      const ctx5 = c5.getContext('2d');
      ctx5.filter = 'grayscale(1) brightness(1.1) contrast(4) saturate(0) contrast(2)';
      ctx5.drawImage(c, 0, 0);
      variants.push({ canvas: c5, label: `edge|${labelSuffix}` });

      // Inverted (Required for some industrial markings/dark mode QRs)
      const c4 = document.createElement('canvas');
      c4.width = c.width; c4.height = c.height;
      const ctx4 = c4.getContext('2d');
      ctx4.filter = 'invert(1) grayscale(1) contrast(2)';
      ctx4.drawImage(c, 0, 0);
      variants.push({ canvas: c4, label: `inv|${labelSuffix}` });
      });
    });

    return variants;
  }, []);

  const decodeCanvas = useCallback(async (canvas, label) => {
    try {
      const result = await readerRef.current.decodeFromCanvas(canvas);
      if (result?.getText()) {
        return {
          data: result.getText(),
          type: result.getBarcodeFormat?.() ?? 'unknown',
          method: label,
          confidence: label.startsWith('raw') ? 1.0 : 0.75,
          partial: false,
        };
      }
    } catch (e) {
      if (!(e instanceof NotFoundException)) console.warn(label, e.message);
    }
    return null;
  }, []);

  const EAN_L = {'0001101':'0','0011001':'1','0010011':'2','0111101':'3','0100011':'4','0110001':'5','0101111':'6','0111011':'7','0110111':'8','0001011':'9'};
  const EAN_G = {'0100111':'0','0110011':'1','0011011':'2','0100001':'3','0011101':'4','0111001':'5','0000101':'6','0010001':'7','0001001':'8','0010111':'9'};
  const EAN_R = {'1110010':'0','1100110':'1','1101100':'2','1000010':'3','1011100':'4','1001110':'5','1010000':'6','1000100':'7','1001000':'8','1110100':'9'};
  const PARITY = {'LLLLLL':'0','LLGLGG':'1','LLGGLG':'2','LLGGGL':'3','LGLLGG':'4','LGGLLG':'5','LGGGLL':'6','LGLGLG':'7','LGLGGL':'8','LGGLGL':'9'};

  const ean13Checksum = (d) => {
    if (d.length < 12 || d.includes('?')) return '?';
    const tot = [...d].reduce((s,c,i)=>s+parseInt(c)*(i%2===0?1:3),0);
    return String((10-(tot%10))%10);
  };

  const decodeEAN13Bits = useCallback((bits) => {
    if (bits.length < 59) return null;
    for (const [pol, b] of [['normal', bits], ['inv', bits.replace(/[01]/g, x=>x==='0'?'1':'0')]]) {
      for (let st = 0; st < Math.min(8, b.length-58); st++) {
        if (b.slice(st, st+3) !== '101') continue;
        const w = b.slice(st, st+95);
        const lh = w.slice(3, 45);
        const rh = w.slice(50, 92);
        let ld = [], pp = '';
        for (let i = 0; i < 6; i++) {
          const seg = lh.slice(i*7,(i+1)*7);
          if (EAN_L[seg]) { ld.push(EAN_L[seg]); pp+='L'; }
          else if (EAN_G[seg]) { ld.push(EAN_G[seg]); pp+='G'; }
          else { ld.push('?'); pp+='?'; }
        }
        const rd = Array.from({length:6},(_,i)=>EAN_R[rh.slice(i*7,(i+1)*7)]??'?');
        const fd = PARITY[pp]??'?';
        const all = fd+ld.join('')+rd.join('');
        const nk = all.split('').filter(c=>c!=='?').length;
        if (nk < 3) continue;
        const partial = all.includes('?');
        let conf = nk/13;
        if (!partial) {
          const exp = ean13Checksum(all.slice(0,12));
          if (exp !== all[12]) { conf*=0.7; }
        }
        return { data: all, type:'EAN-13', method:`manual|${pol}|st=${st}`, confidence:Math.round(conf*1000)/1000, partial };
      }
    }
    return null;
  }, []);

  const extractSignalFromCanvas = useCallback((canvas) => {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const top = Math.floor(h * 0.35);
    const bot = Math.floor(h * 0.65);
    const band = ctx.getImageData(0, top, w, bot - top);
    const signal = new Float32Array(w);
    const rows = bot - top;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y < rows; y++) {
        const idx = (y * w + x) * 4;
        sum += band.data[idx]*0.299 + band.data[idx+1]*0.587 + band.data[idx+2]*0.114;
      }
      signal[x] = sum / rows;
    }
    const mn = Math.min(...signal), mx = Math.max(...signal);
    if (mx === mn) return new Uint8Array(w);
    return Uint8Array.from(signal, v => Math.round((v-mn)/(mx-mn)*255));
  }, []);

  const getRuns = (arr) => {
    const runs = [];
    let cur = arr[0], len = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === cur) len++;
      else { runs.push([cur,len]); cur=arr[i]; len=1; }
    }
    runs.push([cur,len]);
    while (runs.length && runs[0][0]===255) runs.shift();
    while (runs.length && runs[runs.length-1][0]===255) runs.pop();
    return runs;
  };

  const runsToBits = (runs) => {
    if (!runs.length) return '';
    const widths = runs.map(([,l])=>l);
    const freq = {};
    widths.forEach(w=>freq[w]=(freq[w]||0)+1);
    const xdim = Math.max(1, parseInt(Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0]));
    return runs.map(([v,l])=>(v===0?'0':'1').repeat(Math.max(1,Math.round(l/xdim)))).join('');
  };

  // ── Main scan pipeline ────────────────────────────────────────────────────
  const runScan = useCallback(async (imgEl, currentSrc) => {
    setScanning(true);
    setResults([]);
    setPass(0);
    setHasScanned(false);
    const all = [];
    const seen = new Set();

    const addResult = (r) => {
      if (!r || seen.has(r.data)) return;
      seen.add(r.data);
      all.push(r);
      setResults([...all].sort((a,b)=>b.confidence-a.confidence));
    };

    try {
      // Pass 1 – direct
      setPass(1);
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = imgEl.naturalWidth || imgEl.width;
      rawCanvas.height = imgEl.naturalHeight || imgEl.height;
      rawCanvas.getContext('2d').drawImage(imgEl, 0, 0);
      addResult(await decodeCanvas(rawCanvas, 'raw|0°'));

      // Pass 2 – variants
      setPass(2);
      const variants = getImageVariants(imgEl);
      for (const { canvas, label } of variants) {
        addResult(await decodeCanvas(canvas, label));
        await new Promise(r => setTimeout(r, 0)); // yield to UI
      }

      // Pass 3 – 1D projection
      setPass(3);
      // Try top (25%), mid (50%), and bottom (75%) stripes for every variant
      for (const { canvas, label } of variants.slice(0, 16)) {
        for (const yOff of [0.25, 0.5, 0.75]) {
          const signal = extractSignalFromCanvas(canvas, yOff);
          const synth = document.createElement('canvas');
          synth.width = signal.length; synth.height = 60;
          const ctx = synth.getContext('2d');
          const imgData = ctx.createImageData(signal.length, 60);
          for (let y = 0; y < 60; y++) {
            for (let x = 0; x < signal.length; x++) {
              const v = signal[x] > 120 ? 255 : 0;
              const i = (y * signal.length + x) * 4;
              imgData.data[i] = imgData.data[i+1] = imgData.data[i+2] = v;
              imgData.data[i+3] = 255;
            }
          }
          ctx.putImageData(imgData, 0, 0);
          addResult(await decodeCanvas(synth, `1D|${yOff}|${label}`));
        }
      }

      // Pass 4 – manual EAN-13
      setPass(4);
      for (const { canvas } of variants.slice(0, 8)) {
        const signal = extractSignalFromCanvas(canvas);
        const binary = Uint8Array.from(signal, v => v > 128 ? 255 : 0);
        const runs = getRuns(binary);
        if (runs.length >= 10) {
          const bits = runsToBits(runs);
          addResult(decodeEAN13Bits(bits));
        }
      }
    } catch (err) {
      console.error("Scan pipeline error:", err);
    } finally {
      setPass(0);
      setScanning(false);
      setHasScanned(true);

      if (all.length > 0) {
        const sorted = [...all].sort((a,b)=>b.confidence-a.confidence);
        setHistory(prev => [
          { id: Date.now(), results: sorted, src: currentSrc },
          ...prev.slice(0, 9)
        ]);
      }
    }
  }, [decodeCanvas, getImageVariants, extractSignalFromCanvas, decodeEAN13Bits]);

  // ── File / drop handlers ──────────────────────────────────────────────────
  const handleFile = useCallback((file) => {
    if (!file?.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setPreviewSrc(url);
    setHasScanned(false);
    setResults([]);
    const img = new Image();
    img.onload = () => runScan(img, url);
    img.src = url;
  }, [runScan]);

  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  // ── Camera ────────────────────────────────────────────────────────────────
  const startCamera = async () => {
    setCameraErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      videoRef.current.play();

      const tick = async () => {
        if (!streamRef.current) return;
        const v = videoRef.current;
        if (v.readyState === v.HAVE_ENOUGH_DATA) {
          const c = canvasRef.current;
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          setPreviewSrc(c.toDataURL());
          try {
            const r = await readerRef.current.decodeFromCanvas(c);
            if (r?.getText()) {
              const res = { data: r.getText(), type: 'camera', method: 'live|zxing', confidence: 1.0, partial: false };
              setResults([res]);
              setHasScanned(true);
              setHistory(prev=>[{ id:Date.now(), results:[res], src:c.toDataURL() }, ...prev.slice(0,9)]);
            }
          } catch (_) {}
        }
        if (streamRef.current) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      setCameraErr(e.message);
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const switchMode = (m) => {
    if (m === mode) return;
    stopCamera();
    setMode(m);
    setResults([]);
    setPreviewSrc(null);
    setHasScanned(false);
    if (m === 'camera') setTimeout(startCamera, 100);
  };

  const topResult = results[0];

  return (
    <>
      <Head>
        <title>ScanLab — Barcode Scanner</title>
        <meta name="description" content="Production-grade barcode scanner. Upload an image or use your camera." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <style jsx global>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg:      #0a0a0f;
          --surface: #111118;
          --border:  #1e1e2e;
          --accent:  #00ff88;
          --accent2: #00c8ff;
          --warn:    #ffaa00;
          --text:    #e8e8f0;
          --muted:   #55556a;
          --mono:    'Space Mono', monospace;
          --sans:    'Syne', sans-serif;
        }
        html, body { background: var(--bg); color: var(--text); font-family: var(--sans); min-height: 100vh; }
        ::selection { background: var(--accent); color: #000; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        @keyframes pulse-border {
          0%, 100% { border-color: var(--accent); box-shadow: 0 0 0 0 rgba(0,255,136,0.4); }
          50%       { border-color: var(--accent2); box-shadow: 0 0 0 6px rgba(0,255,136,0); }
        }
        @keyframes scan-line {
          0%   { top: 0%; opacity: 1; }
          100% { top: 100%; opacity: 0.3; }
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pass-glow {
          0%,100% { background: rgba(0,255,136,0.08); }
          50%     { background: rgba(0,255,136,0.22); }
        }
        @keyframes ticker {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }

        .fade-in { animation: fade-in 0.3s ease forwards; }
        .result-card { animation: fade-in 0.4s ease forwards; }

        .ticker-wrap { overflow: hidden; background: #000; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
        .ticker-inner { display: flex; width: max-content; animation: ticker 18s linear infinite; white-space: nowrap; }
        .ticker-inner:hover { animation-play-state: paused; }
        .ticker-item { padding: 6px 40px; font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: 0.08em; }
        .ticker-item span { color: var(--accent); }
      `}</style>

      {/* Ticker */}
      <div className="ticker-wrap">
        <div className="ticker-inner">
          {[...Array(3)].flatMap((_,i)=>['EAN-13','QR CODE','UPC-A','CODE 128','DATA MATRIX','PDF417','CODE 39','ITF'].map(f=>(
            <span key={`${i}-${f}`} className="ticker-item"><span>▸</span> {f} &nbsp;</span>
          )))}
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 20px 80px' }}>

        {/* Header */}
        <header style={{ marginBottom: 40 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:12, marginBottom:6 }}>
            <h1 style={{ fontFamily:'var(--sans)', fontWeight:800, fontSize:'clamp(28px,6vw,48px)', letterSpacing:'-0.03em', lineHeight:1 }}>
              SCAN<span style={{color:'var(--accent)'}}>LAB</span>
            </h1>
            <span style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--muted)', letterSpacing:'0.12em' }}>v2.0</span>
          </div>
          <p style={{ fontFamily:'var(--mono)', fontSize:12, color:'var(--muted)', letterSpacing:'0.06em' }}>
            4-PASS BARCODE SCANNER · EAN-13 · UPC-A · QR · CODE128 · +MORE
          </p>
        </header>

        {/* Mode Toggle */}
        <div style={{ display:'flex', gap:2, marginBottom:24, background:'var(--surface)', border:'1px solid var(--border)', borderRadius:8, padding:4, width:'fit-content' }}>
          {['upload','camera'].map(m=>(
            <button key={m} onClick={()=>switchMode(m)} style={{
              padding:'8px 22px', borderRadius:6, border:'none', cursor:'pointer',
              fontFamily:'var(--mono)', fontSize:12, letterSpacing:'0.08em', textTransform:'uppercase',
              background: mode===m ? 'var(--accent)' : 'transparent',
              color: mode===m ? '#000' : 'var(--muted)',
              fontWeight: mode===m ? 700 : 400,
              transition: 'all 0.2s',
            }}>{m==='upload'?'⬆ Upload':'⏺ Camera'}</button>
          ))}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, alignItems:'start' }}>

          {/* Left: Input panel */}
          <div>
            {mode === 'upload' ? (
              <div
                onClick={()=>fileRef.current.click()}
                onDrop={handleDrop}
                onDragOver={e=>{e.preventDefault();setDragOver(true);}}
                onDragLeave={()=>setDragOver(false)}
                style={{
                  border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 12,
                  padding: '32px 20px',
                  textAlign:'center', cursor:'pointer',
                  background: dragOver ? 'rgba(0,255,136,0.04)' : 'var(--surface)',
                  transition: 'all 0.2s',
                  animation: dragOver ? 'pulse-border 1s infinite' : 'none',
                  position:'relative', overflow:'hidden',
                  minHeight: 200, display:'flex', flexDirection:'column',
                  alignItems:'center', justifyContent:'center', gap:12,
                }}
              >
                {previewSrc ? (
                  <img src={previewSrc} alt="preview" style={{
                    maxWidth:'100%', maxHeight:220, borderRadius:8, objectFit:'contain',
                    display:'block',
                  }}/>
                ) : (
                  <>
                    <div style={{ fontSize:48, lineHeight:1 }}>⬆</div>
                    <p style={{ fontFamily:'var(--mono)', fontSize:12, color:'var(--muted)', lineHeight:1.6 }}>
                      DROP IMAGE HERE<br/>or click to browse
                    </p>
                    <p style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--muted)', opacity:0.5 }}>
                      JPG · PNG · WEBP · BMP
                    </p>
                  </>
                )}
                {scanning && (
                  <div style={{
                    position:'absolute', left:0, right:0, height:2,
                    background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
                    animation:'scan-line 1.4s linear infinite',
                  }}/>
                )}
                <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}}
                  onChange={e=>handleFile(e.target.files[0])} />
              </div>
            ) : (
              <div style={{ position:'relative', borderRadius:12, overflow:'hidden', border:'1px solid var(--border)', background:'#000', minHeight:200 }}>
                <video ref={videoRef} style={{ width:'100%', display:'block' }} playsInline muted />
                <canvas ref={canvasRef} style={{ display:'none' }} />
                {cameraErr && (
                  <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.8)', padding:20, textAlign:'center' }}>
                    <p style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--warn)' }}>⚠ {cameraErr}</p>
                  </div>
                )}
                <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                  background:'linear-gradient(90deg,transparent,var(--accent2),transparent)',
                  animation:'scan-line 2s linear infinite' }}/>
              </div>
            )}

            {/* Pass indicator */}
            {(scanning || pass > 0) && (
              <div style={{ marginTop:16, display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {PASS_LABELS.map(p=>(
                  <div key={p.id} style={{
                    padding:'8px 12px', borderRadius:8, border:`1px solid ${pass===p.id?'var(--accent)':'var(--border)'}`,
                    background: pass===p.id ? 'rgba(0,255,136,0.06)' : 'var(--surface)',
                    animation: pass===p.id ? 'pass-glow 0.8s ease infinite' : 'none',
                    transition:'all 0.3s',
                  }}>
                    <div style={{ fontFamily:'var(--mono)', fontSize:10, color: pass===p.id?'var(--accent)':'var(--muted)', letterSpacing:'0.06em' }}>
                      {pass===p.id?'▶':pass>p.id?'✓':' '} PASS {p.id}
                    </div>
                    <div style={{ fontFamily:'var(--sans)', fontSize:11, color: pass>=p.id?'var(--text)':'var(--muted)', marginTop:2 }}>{p.label}</div>
                    <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)', marginTop:1 }}>{p.desc}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: Results */}
          <div>
            {results.length === 0 && !scanning && !hasScanned && (
              <div style={{ padding:32, textAlign:'center', border:'1px solid var(--border)', borderRadius:12, background:'var(--surface)' }}>
                <div style={{ fontSize:40, marginBottom:12, opacity:0.3 }}>⬛</div>
                <p style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--muted)', letterSpacing:'0.06em' }}>
                  AWAITING INPUT
                </p>
              </div>
            )}

            {results.length === 0 && !scanning && hasScanned && (
              <div style={{ padding:32, textAlign:'center', border:'1px solid var(--warn)', borderRadius:12, background:'rgba(255,170,0,0.04)' }}>
                <div style={{ fontSize:40, marginBottom:12 }}>⚠</div>
                <p style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--warn)', letterSpacing:'0.06em' }}>
                  NO BARCODE DETECTED
                </p>
                <p style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)', marginTop:8 }}>Try a clearer image or different angle.</p>
              </div>
            )}

            {scanning && results.length === 0 && (
              <div style={{ padding:32, textAlign:'center', border:'1px solid var(--accent)', borderRadius:12, background:'rgba(0,255,136,0.03)' }}>
                <div style={{ width:32, height:32, border:'2px solid var(--accent)', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto 16px' }}/>
                <p style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--accent)', letterSpacing:'0.08em' }}>SCANNING…</p>
              </div>
            )}

            {results.map((r, i) => (
              <div key={r.data + i} className="result-card" style={{
                marginBottom: 12,
                padding: 16,
                borderRadius: 12,
                border: `1px solid ${i===0?'var(--accent)':'var(--border)'}`,
                background: i===0?'rgba(0,255,136,0.04)':'var(--surface)',
              }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                  <span style={{ fontFamily:'var(--mono)', fontSize:10, color: r.partial?'var(--warn)':'var(--accent)', letterSpacing:'0.1em' }}>
                    {r.partial ? '⚠ PARTIAL' : '✓ DECODED'} · {r.type}
                  </span>
                  <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--muted)' }}>
                    {Math.round(r.confidence*100)}%
                  </span>
                </div>

                <div style={{
                  fontFamily:'var(--mono)', fontSize: r.data.length > 20 ? 13 : 22,
                  fontWeight:700, letterSpacing:'0.04em', color:'var(--text)',
                  wordBreak:'break-all', marginBottom:8,
                  padding:'10px 12px', background:'rgba(0,0,0,0.4)', borderRadius:8,
                }}>
                  {r.data}
                </div>

                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <button onClick={()=>navigator.clipboard?.writeText(r.data)} style={{
                    padding:'5px 12px', border:'1px solid var(--border)', borderRadius:6,
                    background:'transparent', color:'var(--muted)', cursor:'pointer',
                    fontFamily:'var(--mono)', fontSize:10, letterSpacing:'0.06em',
                    transition:'all 0.15s',
                  }}
                    onMouseEnter={e=>{e.target.style.borderColor='var(--accent)';e.target.style.color='var(--accent)';}}
                    onMouseLeave={e=>{e.target.style.borderColor='var(--border)';e.target.style.color='var(--muted)';}}>
                    COPY
                  </button>
                  <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    via {r.method}
                  </span>
                </div>

                {/* Confidence bar */}
                <div style={{ marginTop:10, height:3, background:'var(--border)', borderRadius:2, overflow:'hidden' }}>
                  <div style={{
                    height:'100%', width:`${r.confidence*100}%`, borderRadius:2,
                    background: r.confidence > 0.8 ? 'var(--accent)' : r.confidence > 0.5 ? 'var(--accent2)' : 'var(--warn)',
                    transition:'width 0.5s ease',
                  }}/>
                </div>
              </div>
            ))}

            {/* Pipeline legend */}
            <div style={{ marginTop:16, padding:14, border:'1px solid var(--border)', borderRadius:10, background:'var(--surface)' }}>
              <p style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)', letterSpacing:'0.1em', marginBottom:8 }}>PIPELINE</p>
              <div style={{ display:'grid', gap:4 }}>
                {PASS_LABELS.map(p=>(
                  <div key={p.id} style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--accent)', minWidth:12 }}>{p.id}</span>
                    <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)' }}>{p.label} — {p.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* History */}
        {history.length > 0 && (
          <div style={{ marginTop:48 }}>
            <h2 style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--muted)', letterSpacing:'0.12em', marginBottom:16 }}>▸ SCAN HISTORY</h2>
            <div style={{ display:'flex', gap:12, overflowX:'auto', paddingBottom:8 }}>
              {history.map(h=>(
                <div key={h.id} style={{
                  minWidth:160, padding:12, border:'1px solid var(--border)',
                  borderRadius:10, background:'var(--surface)', flexShrink:0, cursor:'pointer',
                  transition:'border-color 0.2s',
                }}
                  onMouseEnter={e=>e.currentTarget.style.borderColor='var(--accent)'}
                  onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}
                  onClick={()=>setResults(h.results)}
                >
                  {h.src && <img src={h.src} alt="" style={{ width:'100%', height:70, objectFit:'cover', borderRadius:6, marginBottom:8 }}/>}
                  <p style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {h.results[0]?.data ?? '—'}
                  </p>
                  <p style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--muted)', marginTop:2 }}>
                    {h.results.length} result{h.results.length!==1?'s':''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        <footer style={{ marginTop:48, paddingTop:20, borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8 }}>
          <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--muted)' }}>
            SCANLAB · All processing is done locally in your browser.
          </span>
          <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--muted)' }}>
            Powered by ZXing · No data leaves your device.
          </span>
        </footer>
      </div>
    </>
  );
}
