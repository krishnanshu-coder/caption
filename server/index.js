require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const axios     = require('axios');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');

// NEW: Required for FFmpeg
const { exec }  = require('child_process');
const util      = require('util');
const execPromise = util.promisify(exec);

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
// REQUIRED on Railway: sits behind a reverse proxy, must trust forwarded headers
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Serve the HTML/CSS/JS frontend from /public next to /server
app.use(express.static(path.join(__dirname, '../public')));

// ─── Upload folder ────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename:    (_req, file,  cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 }   // 200 MB
});

// ─── AssemblyAI key ───────────────────────────────────────────────────────────
const AKEY = process.env.ASSEMBLYAI_API_KEY;

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests. Please wait 15 minutes.' }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function uploadToAssemblyAI(filePath) {
  const stream = fs.createReadStream(filePath);
  const stat   = fs.statSync(filePath);
  const res    = await axios.post('https://api.assemblyai.com/v2/upload', stream, {
    headers: {
      'authorization':  AKEY,
      'content-type':   'application/octet-stream',
      'content-length': stat.size
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 180000   // 3-min upload timeout
  });
  return res.data.upload_url;
}

async function startTranscription(audioUrl, language) {
  const langMap = { hindi: 'hi', english: 'en', hinglish: 'hi' };
  const res = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url:     audioUrl,
    language_code: langMap[language] || 'en',
    punctuate:     true,
    format_text:   true,
    speaker_labels: false
  }, {
    headers: { 'authorization': AKEY },
    timeout: 15000
  });
  return res.data.id;
}

async function pollTranscription(id) {
  // Poll up to 10 minutes (300 × 2 s)
  for (let i = 0; i < 300; i++) {
    const res = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${id}`,
      { headers: { 'authorization': AKEY }, timeout: 10000 }
    );
    const { status, text, words, error } = res.data;
    if (status === 'completed') return { text, words };
    if (status === 'error')     throw new Error('AssemblyAI: ' + error);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Transcription timed out (>10 min).');
}

function wordsToSRT(words, wpl) {
  if (!words || !words.length) return '';
  const n = parseInt(wpl) || 6;
  const pad = (v, l) => String(v).padStart(l, '0');
  const ts  = ms => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000)  / 1000);
    const f = ms % 1000;
    return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(f,3)}`;
  };
  let out = '', idx = 1;
  for (let i = 0; i < words.length; i += n) {
    const chunk = words.slice(i, i + n);
    out += `${idx}\n${ts(chunk[0].start)} --> ${ts(chunk[chunk.length-1].end)}\n${chunk.map(w=>w.text).join(' ')}\n\n`;
    idx++;
  }
  return out;
}

function wordsToVTT(words, wpl) {
  return 'WEBVTT\n\n' + wordsToSRT(words, wpl).replace(/,(\d{3})/g, '.$1');
}

// NEW: Function to burn subtitles using FFmpeg
async function burnSubtitles(videoPath, srtContent, outPath, reqColor, reqFont, reqFontSize) {
  const srtPath = videoPath + '.srt';
  fs.writeFileSync(srtPath, srtContent);

  // Convert HTML Hex Color (#FFFFFF) to FFmpeg ASS format (&H00FFFFFF)
  const hex = (reqColor || '#FFFFFF').replace('#', '');
  const r = hex.substring(0, 2), g = hex.substring(2, 4), b = hex.substring(4, 6);
  const assColor = `&H00${b}${g}${r}`;

  // FFmpeg requires exact absolute paths for subtitle filters
  const safeSrtPath = path.resolve(srtPath).replace(/\\/g, '/').replace(/:/g, '\\:');

  const font = reqFont || 'Arial';
  const fontSize = reqFontSize || 22;
  const style = `Fontname=${font},Fontsize=${fontSize},PrimaryColour=${assColor},BackColour=&H80000000,BorderStyle=4,Backing=1,Outline=0,Shadow=0,Alignment=2`;

  // CRITICAL FIX: '-loglevel error' prevents FFmpeg from spamming logs and crashing Node
  const cmd = `ffmpeg -y -i "${videoPath}" -vf "subtitles=${safeSrtPath}:force_style='${style}'" -preset ultrafast -crf 28 -c:a copy -loglevel error "${outPath}"`;

  // CRITICAL FIX: Increased Node's buffer limit to 50MB just to be safe
  await execPromise(cmd, { maxBuffer: 1024 * 1024 * 50 });
  fs.unlinkSync(srtPath);
}

// ─── HEALTH CHECK (Railway needs this) ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── JOB STORE (in-memory — for async job pattern) ───────────────────────────
const jobs = {};   // { [id]: { status, result, error, outPath } }

// STEP 1 – Accept upload, start job, return immediately
app.post('/api/generate-captions', limiter, upload.single('video'), (req, res) => {
  if (!AKEY) return res.status(500).json({ success: false, error: 'ASSEMBLYAI_API_KEY not set on server.' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No video file received.' });

  const jobId    = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const filePath = req.file.path;
  const language = req.body.language || 'english';
  const wpl      = req.body.wordsPerLine || 6;

  // Store pending job tracking new outPath variable
  jobs[jobId] = { status: 'processing', result: null, error: null, outPath: null };

  // Run async — do NOT await
  (async () => {
    try {
      console.log(`[${jobId}] Uploading ${req.file.originalname}...`);
      const uploadUrl = await uploadToAssemblyAI(filePath);

      console.log(`[${jobId}] Starting transcription (${language})...`);
      const transcriptId = await startTranscription(uploadUrl, language);

      console.log(`[${jobId}] Polling...`);
      const { text, words } = await pollTranscription(transcriptId);

      const srtText = wordsToSRT(words, wpl);
      const outPath = filePath + '_captioned.mp4';

      // NEW PHASE: Burning the subtitles into the MP4
      jobs[jobId].status = 'rendering';
      console.log(`[${jobId}] Rendering MP4 with FFmpeg...`);
      
      await burnSubtitles(
        filePath, 
        srtText, 
        outPath, 
        req.body.color, 
        req.body.font, 
        req.body.fontSize
      );

      jobs[jobId] = {
        status: 'done',
        outPath: outPath,
        result: {
          text,
          srt:       srtText,
          vtt:       wordsToVTT(words, wpl),
          wordCount: words ? words.length : 0,
          language,
          videoUrl:  `/api/download-video/${jobId}` // Gives frontend a download link
        },
        error: null
      };
      console.log(`[${jobId}] Done!`);
    } catch (err) {
      jobs[jobId] = { status: 'error', result: null, error: err.message };
      console.error(`[${jobId}] Error:`, err.message);
    } finally {
      // Delete the original uploaded file
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      
      // Auto-clean job from memory AND delete the rendered MP4 after 30 min
      setTimeout(() => {
        if (jobs[jobId] && jobs[jobId].outPath && fs.existsSync(jobs[jobId].outPath)) {
          fs.unlinkSync(jobs[jobId].outPath);
        }
        delete jobs[jobId];
      }, 30 * 60 * 1000);
    }
  })();

  // Return job ID immediately — no waiting
  res.json({ success: true, jobId });
});

// STEP 2 – Frontend polls this every 3 s
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job not found.' });
  res.json({ success: true, ...job });
});

// NEW: Endpoint to download the final MP4
app.get('/api/download-video/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.outPath || !fs.existsSync(job.outPath)) {
    return res.status(404).send('Video not found or expired.');
  }
  res.download(job.outPath, 'CaptionAI_Export.mp4');
});

// ─── Hourly cleanup of stuck upload files ─────────────────────────────────────
cron.schedule('0 * * * *', () => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return;
    files.forEach(f => {
      const fp = path.join(uploadsDir, f);
      fs.stat(fp, (e, s) => {
        if (!e && Date.now() - s.mtimeMs > 1800000) fs.unlink(fp, () => {});
      });
    });
  });
});

// ─── SPA Fallback (Prevents 404 errors on the website) ────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
// CRITICAL FIX: You MUST include '0.0.0.0' for Railway Docker deployments
app.listen(PORT, '0.0.0.0', () => console.log(`CaptionAI server on port ${PORT}`));
