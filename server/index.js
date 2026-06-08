require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const rateLimit = require('express-rate-limit'); // Added for safety
const cron = require('node-cron');               // Added for auto-cleanup

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serving the static frontend assets from '../public' directory relative to /server
app.use(express.static(path.join(__dirname, '../public')));

// Ensure dynamic 'uploads/' folder structure exists inside the server folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// File upload configuration using the dynamic path
const upload = multer({
  dest: 'server/uploads/', // Local path backup fallback
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit
});

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;

// 1. Rate Limiting Setup (Protects your free credits from being spammed)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 20, // Limit each IP to 20 video uploads per window
  message: { 
    success: false, 
    error: "Too many caption requests from this IP. Please try again after 15 minutes." 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// STEP 1: Upload video to AssemblyAI
async function uploadToAssemblyAI(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const response = await axios.post('https://api.assemblyai.com/v2/upload', fileStream, {
    headers: {
      'authorization': ASSEMBLYAI_KEY,
      'content-type': 'application/octet-stream'
    }
  });
  return response.data.upload_url;
}

// STEP 2: Start transcription
async function startTranscription(audioUrl, language) {
  const langMap = {
    'hindi': 'hi',
    'english': 'en',
    'hinglish': 'hi' // AssemblyAI handles code-switching
  };

  const payload = {
    audio_url: audioUrl,
    language_code: langMap[language] || 'hi',
    word_boost: language === 'hinglish' ? [] : [],
    punctuate: true,
    format_text: true,
    speaker_labels: false,
    auto_highlights: false
  };

  const response = await axios.post('https://api.assemblyai.com/v2/transcript', payload, {
    headers: { 'authorization': ASSEMBLYAI_KEY }
  });
  return response.data.id;
}

// STEP 3: Poll for results
async function getTranscription(transcriptId) {
  while (true) {
    const response = await axios.get(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: { 'authorization': ASSEMBLYAI_KEY } }
    );

    const { status, text, words, error } = response.data;

    if (status === 'completed') {
      return { text, words };
    } else if (status === 'error') {
      throw new Error(`Transcription failed: ${error}`);
    }

    await new Promise(r => setTimeout(r, 2000)); // Poll every 2s
  }
}

// Convert words to SRT format
function wordsToSRT(words, style) {
  if (!words || words.length === 0) return '';
  
  let srt = '';
  let index = 1;
  const wordsPerCaption = style.wordsPerLine || 6;

  for (let i = 0; i < words.length; i += wordsPerCaption) {
    const chunk = words.slice(i, i + wordsPerCaption);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    const text = chunk.map(w => w.text).join(' ');

    const formatTime = (ms) => {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      const ms2 = ms % 1000;
      return `${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')},${String(ms2).padStart(3,'0')}`;
    };

    srt += `${index}\n${formatTime(start)} --> ${formatTime(end)}\n${text}\n\n`;
    index++;
  }
  return srt;
}

// Convert words to VTT format
function wordsToVTT(words, style) {
  const srt = wordsToSRT(words, style);
  return 'WEBVTT\n\n' + srt.replace(/,(\d{3})/g, '.$1');
}

// Main API endpoint with the rate limiter attached
app.post('/api/generate-captions', uploadLimiter, upload.single('video'), async (req, res) => {
  const filePath = req.file?.path;

  try {
    const { language = 'hindi', style = '{}' } = req.body;
    const styleOptions = JSON.parse(style);

    console.log(`Processing video in ${language}...`);

    if (!filePath) {
      return res.status(400).json({ success: false, error: "No video file uploaded." });
    }

    // Upload & transcribe
    const uploadUrl = await uploadToAssemblyAI(filePath);
    const transcriptId = await startTranscription(uploadUrl, language);
    const { text, words } = await getTranscription(transcriptId);

    // Generate caption files
    const srtContent = wordsToSRT(words, styleOptions);
    const vttContent = wordsToVTT(words, styleOptions);

    // Immediate cleanup after generation completes successfully
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

// 2. File Cleanup Cron Job (Runs every hour to keep memory footprint free)
cron.schedule('0 * * * *', () => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return console.error("Error reading uploads path:", err);
    files.forEach(file => {
      const filePath = path.join(uploadsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        // Delete files older than 30 minutes to safeguard disk limits
        if (Date.now() - stats.mtimeMs > 1800000) {
          fs.unlink(filePath, () => console.log(`Deleted residual file: ${file}`));
        }
      });
    });
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));