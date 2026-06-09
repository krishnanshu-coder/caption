require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve frontend from ../public
app.use(express.static(path.join(__dirname, '../public')));

// Uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config — video only, 200MB max, NO ffmpeg needed
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4','video/quicktime','video/x-msvideo','video/x-matroska','video/webm','audio/mpeg','audio/wav','audio/mp4'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video/audio files are allowed'));
    }
  }
});

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;

// Validate API key on startup
if (!ASSEMBLYAI_KEY) {
  console.error('ERROR: ASSEMBLYAI_API_KEY is not set in environment variables!');
}

// Rate limiter
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// STEP 1: Upload raw video/audio to AssemblyAI — no ffmpeg needed
async function uploadToAssemblyAI(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const fileStat = fs.statSync(filePath);

  const response = await axios.post('https://api.assemblyai.com/v2/upload', fileStream, {
    headers: {
      'authorization': ASSEMBLYAI_KEY,
      'content-type': 'application/octet-stream',
      'content-length': fileStat.size
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000 // 2 min upload timeout
  });
  return response.data.upload_url;
}

// STEP 2: Start transcription
async function startTranscription(audioUrl, language) {
  const langMap = {
    'hindi': 'hi',
    'english': 'en',
    'hinglish': 'hi'
  };

  const payload = {
    audio_url: audioUrl,
    language_code: langMap[language] || 'en',
    punctuate: true,
    format_text: true,
    speaker_labels: false,
    auto_highlights: false,
    // word-level timestamps for SRT/VTT generation
    word_boost: []
  };

  const response = await axios.post('https://api.assemblyai.com/v2/transcript', payload, {
    headers: { 'authorization': ASSEMBLYAI_KEY },
    timeout: 30000
  });
  return response.data.id;
}

// STEP 3: Poll for results (with a max wait of 10 minutes)
async function getTranscription(transcriptId) {
  const maxAttempts = 150; // 150 * 2s = 5 minutes max
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { 
        headers: { 'authorization': ASSEMBLYAI_KEY },
        timeout: 10000
      }
    );

    const { status, text, words, error } = response.data;

    if (status === 'completed') return { text, words };
    if (status === 'error') throw new Error(`AssemblyAI error: ${error}`);

    attempts++;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Transcription timed out after 5 minutes.');
}

// Words → SRT
function wordsToSRT(words, style) {
  if (!words || words.length === 0) return '';
  let srt = '';
  let index = 1;
  const wordsPerCaption = parseInt(style.wordsPerLine) || 6;

  const formatTime = (ms) => {
    const totalMs = Math.round(ms);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms2 = totalMs % 1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms2).padStart(3,'0')}`;
  };

  for (let i = 0; i < words.length; i += wordsPerCaption) {
    const chunk = words.slice(i, i + wordsPerCaption);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    const text = chunk.map(w => w.text).join(' ');
    srt += `${index}\n${formatTime(start)} --> ${formatTime(end)}\n${text}\n\n`;
    index++;
  }
  return srt;
}

// Words → VTT
function wordsToVTT(words, style) {
  const srt = wordsToSRT(words, style);
  return 'WEBVTT\n\n' + srt.replace(/,(\d{3})/g, '.$1');
}

// ── MAIN ENDPOINT ──────────────────────────────────────────
app.post('/api/generate-captions', uploadLimiter, upload.single('video'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!ASSEMBLYAI_KEY) {
      return res.status(500).json({ success: false, error: 'Server config error: API key missing.' });
    }
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'No video file uploaded.' });
    }

    const { language = 'english', style = '{}' } = req.body;
    let styleOptions = {};
    try { styleOptions = JSON.parse(style); } catch(e) { styleOptions = {}; }

    console.log(`[${new Date().toISOString()}] Processing ${req.file.originalname} | lang: ${language}`);

    const uploadUrl = await uploadToAssemblyAI(filePath);
    console.log('Uploaded to AssemblyAI');

    const transcriptId = await startTranscription(uploadUrl, language);
    console.log('Transcription started:', transcriptId);

    const { text, words } = await getTranscription(transcriptId);
    console.log('Transcription complete. Words:', words?.length);

    const srtContent = wordsToSRT(words, styleOptions);
    const vttContent = wordsToVTT(words, styleOptions);

    // Cleanup uploaded file immediately
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({
      success: true,
      text,
      srt: srtContent,
      vtt: vttContent,
      wordCount: words?.length || 0,
      language
    });

  } catch (error) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint — Railway uses this to verify the app is alive
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Hourly cleanup of any stuck files
cron.schedule('0 * * * *', () => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const fp = path.join(uploadsDir, file);
      fs.stat(fp, (err, stats) => {
        if (!err && Date.now() - stats.mtimeMs > 1800000) {
          fs.unlink(fp, () => console.log('Cleaned up:', file));
        }
      });
    });
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
