const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const os = require('os');

const app = express();
const VERSION = '2.1';

const ZIP_CODE = process.env.ZIP_CODE || '90210';
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost';
const WS4KP_PORT = process.env.WS4KP_PORT || '8080';
const STREAM_PORT = process.env.STREAM_PORT || '9798';
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`;
const PERMALINK_URL = process.env.PERMALINK_URL || null;
const FRAME_RATE = parseInt(process.env.FRAME_RATE, 10) || 10;

// Video Recording Configuration
const WRITE_VIDEO = ['true', '1', 'yes'].includes((process.env.WRITE_VIDEO || '').toLowerCase());
const WRITE_VIDEO_LENGTH = WRITE_VIDEO ? (parseInt(process.env.WRITE_VIDEO_LENGTH, 10) || 300) : 0;
const WRITE_VIDEO_FILENAME = process.env.WRITE_VIDEO_FILENAME || 'output.mp4';

const OUTPUT_DIR = path.join(__dirname, 'output');
const AUDIO_DIR = path.join(__dirname, 'music');
const LOGO_DIR = path.join(__dirname, 'logo');
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8');

const validViewModes = ['standard', 'wide', 'wide-enhanced', 'portrait-enhanced'];
const desiredViewMode = (process.env.VIEW_MODE || 'wide').toLowerCase();
const VIEW_MODE = validViewModes.includes(desiredViewMode) ? desiredViewMode : 'wide';

const VIEW_DIMENSIONS = (() => {
  switch (VIEW_MODE) {
    case 'standard': return { width: 640, height: 480 };
    case 'portrait-enhanced': return { width: 720, height: 1280 };
    case 'wide':
    case 'wide-enhanced':
    default: return { width: 1280, height: 720 };
  }
})();

[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/stream', express.static(OUTPUT_DIR));
app.use('/logo', express.static(LOGO_DIR));

// --- Shared state ---
let ffmpegCmd = null;      // the fluent-ffmpeg command instance (has .kill())
let ffmpegStream = null;   // the PassThrough pipe into ffmpeg's stdin
let browser = null;
let page = null;
let captureInterval = null;
let browserRefreshTimer = null;
let isStreamReady = false;
let isBrowserRestarting = false;  // guard: pause captures during browser restart

let recordingStartTime = null;
let videoProgressInterval = null;

const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));

function shuffleArray(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getContainerLimits() {
  let cpuQuotaPath = '/sys/fs/cgroup/cpu.max';
  let memLimitPath = '/sys/fs/cgroup/memory.max';
  let cpus = os.cpus().length;
  let memory = os.totalmem();
  try {
    const [quota, period] = fs.readFileSync(cpuQuotaPath, 'utf8').trim().split(' ');
    if (quota !== 'max') cpus = parseFloat((parseInt(quota) / parseInt(period)).toFixed(2));
  } catch { }
  try {
    const raw = fs.readFileSync(memLimitPath, 'utf8').trim();
    if (raw !== 'max') memory = parseInt(raw);
  } catch { }
  return { cpus, memoryMB: Math.round(memory / (1024 * 1024)) };
}

function createAudioInputFile() {
  const defaultMp3s = [
    '01 Weatherscan Track 26.mp3', '02 Weatherscan Track 3.mp3', '03 Tropical Breeze.mp3',
    '04 Late Nite Cafe.mp3', '05 Care Free.mp3', '06 Weatherscan Track 14.mp3', '07 Weatherscan Track 18.mp3'
  ];
  let files = [];
  try {
    files = fs.readdirSync(AUDIO_DIR).filter(file => file.toLowerCase().endsWith('.mp3'));
    if (files.length === 0) {
      console.warn('No MP3 files found in music directory; using default music list');
      files = defaultMp3s;
    }
  } catch (err) {
    console.error(`Failed to read music directory: ${err.message}`);
    console.warn('Using default music list due to error');
    files = defaultMp3s;
  }
  if (process.env.SHUFFLE_MUSIC?.toLowerCase() === 'true') {
    files = shuffleArray(files);
    console.log('Shuffled music list based on SHUFFLE_MUSIC=true');
  }
  console.log(`Loaded ${files.length} music files`);
  const audioList = files.map(file => `file '${path.join(AUDIO_DIR, file)}'`).join('\n');
  fs.writeFileSync(path.join(__dirname, 'audio_list.txt'), audioList);
}

function generateXMLTV(host) {
  const now = new Date();
  const baseUrl = `http://${host}`;
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="WS4000">
<display-name>WeatherStar 4000</display-name>
<icon src="${baseUrl}/logo/ws4000.png" />
</channel>`;
  for (let i = 0; i < 24; i++) {
    const startTime = new Date(now.getTime() + i * 3600 * 1000);
    const endTime = new Date(startTime.getTime() + 3600 * 1000);
    const start = startTime.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000';
    const end = endTime.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000';
    xml += `
<programme start="${start}" stop="${end}" channel="WS4000">
<title lang="en">Local Weather</title>
<desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>
<icon src="${baseUrl}/logo/ws4000.png" />
</programme>`;
  }
  xml += `</tv>`;
  return xml;
}

async function startBrowser() {
  if (browser) {
    console.log('🔄 Closing existing browser instance...');
    await browser.close().catch(() => { });
    browser = null;
    page = null;
    if (global.gc) global.gc();
  }

  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      `--window-size=${VIEW_DIMENSIONS.width},${VIEW_DIMENSIONS.height}`
    ],
    defaultViewport: null
  });

  page = await browser.newPage();

  if (PERMALINK_URL) {
    console.log(`Using custom permalink URL: ${PERMALINK_URL}`);
    await page.goto(PERMALINK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  } else {
    await page.goto(WS4KP_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    try {
      const zipInput = await page.waitForSelector('input[placeholder="Zip or City, State"], input', { timeout: 5000 });
      if (zipInput) {
        await zipInput.type(ZIP_CODE, { delay: 100 });
        await page.waitForSelector('#divQuery .autocomplete-suggestions .suggestion');
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('#divQuery .autocomplete-suggestions .suggestion.selected');
        const goButton = await page.$('button[type="submit"]');
        if (goButton) await goButton.click(); else await zipInput.press('Enter');
        await page.waitForSelector('div.weather-display, #weather-content', { timeout: 30000 });
      }
    } catch { }
    try {
      const widescreenCheckbox = await page.waitForSelector('#settings-wide-checkbox', { timeout: 100 });
      if (VIEW_MODE === 'wide-enhanced' || VIEW_MODE === 'portrait-enhanced') {
        console.error(`This version of ws4kp only supports VIEW_MODE 'standard' or 'wide'`);
        await browser.close();
        process.exit(1);
      }
      const widescreenChecked = await widescreenCheckbox.evaluate((el) => el.checked);
      if ((widescreenChecked && VIEW_MODE === 'standard') || (!widescreenChecked && VIEW_MODE === 'wide')) {
        await widescreenCheckbox.click();
      }
    } catch {
      try {
        const viewSelector = await page.waitForSelector('#settings-viewMode-select');
        await viewSelector.evaluate((el, vm) => {
          el.value = vm;
          el.dispatchEvent(new Event('change'));
        }, VIEW_MODE);
      } catch { }
    }
    finally {
      const kioskCheckbox = await page.waitForSelector('#settings-kiosk-checkbox');
      const kioskChecked = await kioskCheckbox.evaluate((el) => el.checked);
      if (!kioskChecked) await kioskCheckbox.click();
    }
  }

  await page.setViewport({
    width: VIEW_DIMENSIONS.width,
    height: VIEW_DIMENSIONS.height,
    deviceScaleFactor: 1
  });

  await page.evaluate((w, h) => {
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.width = `${w}px`;
    document.documentElement.style.overflow = 'hidden';
  }, VIEW_DIMENSIONS.width, VIEW_DIMENSIONS.height);
}

async function startTranscoding() {
  await startBrowser();
  createAudioInputFile();

  ffmpegStream = new PassThrough();
  const isMp4Mode = WRITE_VIDEO;
  const outputPath = isMp4Mode
    ? path.join(OUTPUT_DIR, WRITE_VIDEO_FILENAME)
    : HLS_FILE;

  if (isMp4Mode) {
    const absPath = path.resolve(outputPath);
    console.log('\n' + '='.repeat(60));
    console.log('▶ VIDEO RECORDING MODE ACTIVATED');
    console.log(`📹 Output File: ${absPath}`);
    console.log(`⏱️  Duration:   ${WRITE_VIDEO_LENGTH > 0 ? `${WRITE_VIDEO_LENGTH} seconds` : 'Infinite (Ctrl+C to stop)'}`);
    console.log('▶ Writing video to disk...');
    console.log('='.repeat(60) + '\n');
  }

  // FIX: Build the command, attach listeners, THEN call .run().
  // Previously .run() was called first and its (void) return value was used
  // for .on() — so no events ever fired.
  ffmpegCmd = ffmpeg()
    .input(ffmpegStream)
    .inputFormat('image2pipe')
    .addInputOptions(['-framerate', String(FRAME_RATE)])
    .input(path.join(__dirname, 'audio_list.txt'))
    .addInputOptions(['-f', 'concat', '-safe', '0', '-stream_loop', '-1'])
    .complexFilter([
      `[0:v]scale=${VIEW_DIMENSIONS.width}:${VIEW_DIMENSIONS.height}[v]`,
      `[1:a]volume=0.5[a]`
    ]);

  const outputOpts = [
    '-framerate', String(FRAME_RATE),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-c:a', 'aac',
    '-b:a', '128k', '-preset', 'ultrafast', '-b:v', '1000k'
  ];

  if (isMp4Mode) {
    outputOpts.push('-movflags', 'faststart');
    if (WRITE_VIDEO_LENGTH > 0) outputOpts.push('-t', String(WRITE_VIDEO_LENGTH));
  } else {
    outputOpts.push('-f', 'hls', '-hls_time', '2', '-hls_list_size', '2', '-hls_flags', 'delete_segments');
  }

  ffmpegCmd
    .outputOptions(outputOpts)
    .output(outputPath)
    .on('start', (cmdLine) => {
      console.log('▶ FFmpeg started');
      isStreamReady = true;
      recordingStartTime = Date.now();

      if (isMp4Mode && WRITE_VIDEO_LENGTH > 0) {
        videoProgressInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
          const remaining = WRITE_VIDEO_LENGTH - elapsed;
          const percent = Math.min(100, Math.max(0, (elapsed / WRITE_VIDEO_LENGTH) * 100)).toFixed(1);
          const pad = n => n.toString().padStart(2, '0');
          const eStr = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;
          const tStr = `${pad(Math.floor(WRITE_VIDEO_LENGTH / 60))}:${pad(WRITE_VIDEO_LENGTH % 60)}`;
          console.log(`▶ RECORDING: ${eStr} / ${tStr} (${percent}%) | Writing to: ${outputPath}`);
          if (remaining <= 10 && remaining > 0) {
            console.log(`⚠️  Recording will finalize in ${remaining} seconds...`);
          }
        }, 5000);

        // End the input stream when the desired duration is reached, letting
        // FFmpeg finish gracefully rather than being killed mid-write.
        setTimeout(() => {
          if (ffmpegStream && !ffmpegStream.destroyed) {
            clearInterval(videoProgressInterval);
            console.log('\n⏱️  Recording duration reached. Finalizing MP4 file...\n');
            ffmpegStream.end();
          }
        }, WRITE_VIDEO_LENGTH * 1000);
      }
    })
    .on('error', async (err) => {
      // Ignore "pipe closed" errors that come from a clean ffmpegStream.end()
      if (err.message.includes('pipe') || err.message.includes('SIGKILL')) return;
      console.error('▶ FFmpeg error:', err.message);
      await stopTranscoding();
      if (!isMp4Mode) {
        console.log('▶ Attempting HLS stream recovery in 2s...');
        setTimeout(startTranscoding, 2000);
      }
    })
    .on('end', () => {
      if (videoProgressInterval) { clearInterval(videoProgressInterval); videoProgressInterval = null; }
      isStreamReady = false;

      if (isMp4Mode) {
        const absPath = path.resolve(outputPath);
        const fileSize = fs.existsSync(absPath)
          ? `${(fs.statSync(absPath).size / (1024 * 1024)).toFixed(2)} MB`
          : '0 MB';
        console.log('✅ Recording complete.');
        console.log(`📁 Final Output: ${absPath} (${fileSize})`);
        console.log('🔌 Shutting down capture session...\n');
        stopTranscoding().then(() => process.exit(0));
      }

      ffmpegCmd = null;
      ffmpegStream = null;
    })
    .run(); // FIX: .run() is called last; listeners are on the command object, not its return value

  // --- Capture loop ---
  // FIX: Use a single flag to prevent overlapping async screenshot calls,
  // and check isBrowserRestarting to avoid firing during browser refresh.
  let capturing = false;

  captureInterval = setInterval(async () => {
    if (!ffmpegCmd || !ffmpegStream || !page || isBrowserRestarting) return;
    if (capturing) return;   // FIX: skip frame if previous screenshot is still pending
    capturing = true;

    try {
      if (page.isClosed()) {
        capturing = false;
        return;
      }

      const screenshot = await Promise.race([
        page.screenshot({ type: 'jpeg', quality: 75 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 1000))
      ]).catch(() => null);

      if (!screenshot) {
        capturing = false;
        return;
      }

      // FIX: Respect backpressure properly — check write() return value and
      // await 'drain' before continuing, instead of calling the no-op .pause()
      // on the readable side of the PassThrough.
      const ok = ffmpegStream.write(screenshot);
      if (!ok) {
        await new Promise(resolve => ffmpegStream.once('drain', resolve));
      }
    } catch (err) {
      console.warn('▶ Capture error:', err.message);
    } finally {
      capturing = false;
    }
  }, 1000 / FRAME_RATE);

  // --- Periodic browser refresh (HLS mode only) ---
  // FIX: Clear and restart captureInterval around the browser restart so the
  // loop doesn't fire against a torn-down page.
  if (!isMp4Mode) {
    browserRefreshTimer = setInterval(async () => {
      console.log('♻️  Recreating browser to prevent memory leaks...');
      isBrowserRestarting = true;

      if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
      if (page && !page.isClosed()) await page.close().catch(() => { });
      if (browser) { await browser.close().catch(() => { }); browser = null; page = null; }

      await startBrowser();

      // Restart the capture loop with the fresh page reference
      capturing = false;
      captureInterval = setInterval(async () => {
        if (!ffmpegCmd || !ffmpegStream || !page || isBrowserRestarting) return;
        if (capturing) return;
        capturing = true;
        try {
          if (page.isClosed()) { capturing = false; return; }
          const screenshot = await Promise.race([
            page.screenshot({ type: 'jpeg', quality: 75 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 1000))
          ]).catch(() => null);
          if (!screenshot) { capturing = false; return; }
          const ok = ffmpegStream.write(screenshot);
          if (!ok) await new Promise(resolve => ffmpegStream.once('drain', resolve));
        } catch (err) {
          console.warn('▶ Capture error:', err.message);
        } finally {
          capturing = false;
        }
      }, 1000 / FRAME_RATE);

      isBrowserRestarting = false;
      console.log('♻️  Browser restarted successfully.');
    }, 10 * 60 * 1000);
  }
}

async function stopTranscoding() {
  if (videoProgressInterval) { clearInterval(videoProgressInterval); videoProgressInterval = null; }
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (browserRefreshTimer) { clearInterval(browserRefreshTimer); browserRefreshTimer = null; }
  isStreamReady = false;

  if (ffmpegStream && !ffmpegStream.destroyed) {
    try { ffmpegStream.end(); } catch { }
  }

  // FIX: ffmpegCmd is the fluent-ffmpeg command object and does have .kill().
  // The old code stored the return value of .run() (which is void/undefined)
  // so .kill() was called on undefined and silently failed.
  if (ffmpegCmd) {
    try { ffmpegCmd.kill('SIGINT'); } catch { }
    ffmpegCmd = null;
  }
  ffmpegStream = null;

  if (page) { try { await page.close(); } catch { } page = null; }
  if (browser) { await browser.close().catch(() => { }); browser = null; }
}

// --- Routes ---

app.get('/playlist.m3u', (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  const baseUrl = `http://${host}`;
  const m3uContent = `#EXTM3U
#EXTINF:-1 channel-id="weatherStar4000" tvg-id="weatherStar4000" tvg-channel-no="275" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`;
  res.set('Content-Type', 'application/x-mpegURL');
  res.send(m3uContent);
});

app.get('/guide.xml', (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  res.set('Content-Type', 'application/xml');
  res.send(generateXMLTV(host));
});

app.get('/health', (req, res) => {
  res.status(isStreamReady ? 200 : 503).json({ ready: isStreamReady });
});

// --- Boot ---

const { cpus, memoryMB } = getContainerLimits();
console.log(`Version ${VERSION} | Running with ${cpus} CPU cores, ${memoryMB}MB RAM`);

app.listen(STREAM_PORT, async () => {
  console.log(`▶ Server running on port ${STREAM_PORT}`);
  await startTranscoding();
});

process.on('SIGINT', async () => {
  console.log('\n▶ SIGINT received. Stopping capture...');
  await stopTranscoding();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n▶ SIGTERM received. Stopping capture...');
  await stopTranscoding();
  process.exit(0);
});
