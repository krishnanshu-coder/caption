require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const rateLimit = require('express-rate-limit');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
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

// ─── HEALTH CHECK (Railway needs this) ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── JOB STORE (in-memory — for async job pattern) ───────────────────────────
// WHY: Railway & browsers both timeout long HTTP requests (~60-90 s).
// A 5-minute transcription WILL get a 502 if we hold the connection open.
// Fix: POST returns a job_id immediately. Frontend polls GET /api/status/:id.
const jobs = {};   // { [id]: { status, result, error } }

// STEP 1 – Accept upload, start job, return immediately
app.post('/api/generate-captions', limiter, upload.single('video'), (req, res) => {
  if (!AKEY) return res.status(500).json({ success: false, error: 'ASSEMBLYAI_API_KEY not set on server.' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No video file received.' });

  const jobId    = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const filePath = req.file.path;
  const language = req.body.language || 'english';
  const wpl      = req.body.wordsPerLine || 6;

  // Store pending job
  jobs[jobId] = { status: 'processing', result: null, error: null };

  // Run async — do NOT await
  (async () => {
    try {
      console.log(`[${jobId}] Uploading ${req.file.originalname}...`);
      const uploadUrl = await uploadToAssemblyAI(filePath);

      console.log(`[${jobId}] Starting transcription (${language})...`);
      const transcriptId = await startTranscription(uploadUrl, language);

      console.log(`[${jobId}] Polling...`);
      const { text, words } = await pollTranscription(transcriptId);

      jobs[jobId] = {
        status: 'done',
        result: {
          text,
          srt:       wordsToSRT(words, wpl),
          vtt:       wordsToVTT(words, wpl),
          wordCount: words ? words.length : 0,
          language
        },
        error: null
      };
      console.log(`[${jobId}] Done. ${words ? words.length : 0} words.`);
    } catch (err) {
      jobs[jobId] = { status: 'error', result: null, error: err.message };
      console.error(`[${jobId}] Error:`, err.message);
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // Auto-clean job from memory after 30 min
      setTimeout(() => delete jobs[jobId], 30 * 60 * 1000);
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`CaptionAI server on port ${PORT}`));
