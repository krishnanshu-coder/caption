require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: "Too many requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

async function uploadToAssemblyAI(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const response = await axios.post('https://api.assemblyai.com/v2/upload', fileStream, {
    headers: { 'authorization': ASSEMBLYAI_KEY, 'content-type': 'application/octet-stream' }
  });
  return response.data.upload_url;
}

async function startTranscription(audioUrl, language) {
  const langMap = { 'hindi': 'hi', 'english': 'en', 'hinglish': 'hi' };
  const payload = {
    audio_url: audioUrl,
    language_code: langMap[language] || 'hi',
    punctuate: true,
    format_text: true,
  };
  const response = await axios.post('https://api.assemblyai.com/v2/transcript', payload, {
    headers: { 'authorization': ASSEMBLYAI_KEY }
  });
  return response.data.id;
}

async function getTranscription(transcriptId) {
  while (true) {
    const response = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'authorization': ASSEMBLYAI_KEY }
    });
    const { status, text, words, error } = response.data;
    if (status === 'completed') return { text, words };
    if (status === 'error') throw new Error(`Transcription failed: ${error}`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

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

app.post('/api/generate-captions', uploadLimiter, upload.single('video'), async (req, res) => {
  const videoPath = req.file?.path;
  if (!videoPath) return res.status(400).json({ success: false, error: "No video file uploaded." });

  const srtPath = path.join(uploadsDir, `${req.file.filename}.srt`);
  const outputVideoName = `captioned-${req.file.filename}`;
  const outputVideoPath = path.join(uploadsDir, outputVideoName);

  try {
    const { language = 'hindi', style = '{}' } = req.body;
    const styleOptions = JSON.parse(style);

    console.log(`Starting transcription pipeline...`);
    const uploadUrl = await uploadToAssemblyAI(videoPath);
    const transcriptId = await startTranscription(uploadUrl, language);
    const { text, words } = await getTranscription(transcriptId);

    const srtContent = wordsToSRT(words, styleOptions);
    fs.writeFileSync(srtPath, srtContent);

    console.log(`Hardburning subtitles via FFmpeg...`);
    
    ffmpeg(videoPath)
      .outputOptions(`-vf subtitles=${srtPath}`)
      .save(outputVideoPath)
      .on('end', () => {
        console.log('FFmpeg processing complete!');

        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);

        res.json({
          success: true,
          text,
          srt: srtContent,
          videoUrl: `/uploads/${outputVideoName}`,
          wordCount: words?.length || 0,
          language
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg Error:', err.message);
        throw err;
      });

  } catch (error) {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    if (fs.existsSync(outputVideoPath)) fs.unlinkSync(outputVideoPath);
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use('/uploads', express.static(uploadsDir));

cron.schedule('0 * * * *', () => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(uploadsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (Date.now() - stats.mtimeMs > 1800000) {
          fs.unlink(filePath, () => console.log(`Cleared cached file asset: ${file}`));
        }
      });
    });
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
