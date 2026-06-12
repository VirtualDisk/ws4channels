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

// HLS watchdog: how stale the newest segment may get before we treat the
// stream as frozen and trigger recovery.
const SEGMENT_STALE_SECONDS = parseInt(process.env.SEGMENT_STALE_SECONDS, 10) || 15;

// JPEG quality for captured frames (1-100). Lower = faster/smaller.
const SCREENSHOT_QUALITY = parseInt(process.env.SCREENSHOT_QUALITY, 10) || 75;

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
let cdpClient = null;      // CDP session driving Page.startScreencast
let browserRefreshTimer = null;
let isStreamReady = false;
let isBrowserRestarting = false;  // guard: pause captures during browser restart

let recordingStartTime = null;
let videoProgressInterval = null;
let segmentWatchdog = null;
let lastSegmentVerified = null;

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

// Probe a finished recording and throw if it shows the failure modes we just
// fixed: a video stream shorter than the audio/target (the "freeze halfway"
// bug) or a non-yuv420p pixel format that players/uploaders reject.
function verifyRecording(filePath, targetSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const video = data.streams.find(s => s.codec_type === 'video');
      const audio = data.streams.find(s => s.codec_type === 'audio');
      if (!video) return reject(new Error('no video stream in output'));
      if (!audio) return reject(new Error('no audio stream in output'));

      if (video.pix_fmt !== 'yuv420p') {
        return reject(new Error(`video pix_fmt is "${video.pix_fmt}", expected yuv420p (won't upload/play on many platforms)`));
      }

      const vDur = parseFloat(video.duration ?? data.format.duration);
      const aDur = parseFloat(audio.duration ?? data.format.duration);

      // Video and audio must end at roughly the same time — a large gap means
      // the picture froze while audio kept playing.
      if (Number.isFinite(vDur) && Number.isFinite(aDur) && Math.abs(vDur - aDur) > 2) {
        return reject(new Error(`video/audio duration mismatch: video ${vDur.toFixed(1)}s vs audio ${aDur.toFixed(1)}s (picture likely freezes)`));
      }

      // If a target length was requested, the file should be close to it.
      if (targetSeconds > 0 && Number.isFinite(vDur)) {
        const tolerance = Math.max(2, targetSeconds * 0.05);
        if (Math.abs(vDur - targetSeconds) > tolerance) {
          return reject(new Error(`recording is ${vDur.toFixed(1)}s, expected ~${targetSeconds}s (±${tolerance.toFixed(1)}s)`));
        }
      }

      resolve({ vDur, aDur, pix_fmt: video.pix_fmt });
    });
  });
}

// Newest-first list of HLS segment files, resilient to segments being deleted
// by -hls_flags delete_segments mid-scan.
function listSegments() {
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => {
      try {
        const p = path.join(OUTPUT_DIR, f);
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// Lightweight content check for a single HLS segment.
function probeSegment(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const video = data.streams.find(s => s.codec_type === 'video');
      const audio = data.streams.find(s => s.codec_type === 'audio');
      if (!video) return reject(new Error('segment has no video stream'));
      if (!audio) return reject(new Error('segment has no audio stream'));
      if (video.pix_fmt !== 'yuv420p') {
        return reject(new Error(`segment pix_fmt is "${video.pix_fmt}", expected yuv420p`));
      }
      resolve({ pix_fmt: video.pix_fmt });
    });
  });
}

// Periodically inspect HLS output while streaming: detect a frozen stream
// (segments stop advancing) and validate the format of fresh segments.
function startSegmentWatchdog() {
  let recovering = false;
  const checkMs = Math.max(5000, (SEGMENT_STALE_SECONDS * 1000) / 2);

  segmentWatchdog = setInterval(async () => {
    if (!isStreamReady || isBrowserRestarting || recovering) return;

    let segs;
    try { segs = listSegments(); } catch { return; }
    if (segs.length === 0) return; // nothing written yet

    const newest = segs[0];
    const ageSec = (Date.now() - newest.mtime) / 1000;

    // Freeze: ffmpeg is alive (no 'error' event) but no fresh segments.
    if (ageSec > SEGMENT_STALE_SECONDS) {
      console.error(`❌ HLS watchdog: newest segment is ${ageSec.toFixed(1)}s old (> ${SEGMENT_STALE_SECONDS}s) — stream appears frozen.`);
      recovering = true;
      console.log('▶ Restarting transcoding to recover stalled stream...');
      await stopTranscoding();            // clears this watchdog timer
      setTimeout(startTranscoding, 2000);
      return;
    }

    // Validate the last *complete* segment (skip index 0, still being written).
    const target = segs[1] || newest;
    if (lastSegmentVerified === target.path) return; // already checked this one
    try {
      const info = await probeSegment(target.path);
      lastSegmentVerified = target.path;
      console.log(`🔎 HLS watchdog: ${path.basename(target.path)} ok (pix_fmt ${info.pix_fmt}, fresh ${ageSec.toFixed(1)}s ago)`);
    } catch (err) {
      console.error('❌ HLS watchdog: segment validation failed:', err.message);
    }
  }, checkMs);

  console.log(`🛡️  HLS segment watchdog active (stale threshold ${SEGMENT_STALE_SECONDS}s, checking every ${(checkMs / 1000).toFixed(0)}s)`);
}

// Capture frames via CDP screencast: Chrome pushes JPEG frames as it composites
// them, which is far cheaper and higher-throughput than polling page.screenshot()
// (each screenshot is a blocking CDP round-trip, so the old loop capped out at a
// handful of fps regardless of FRAME_RATE). Frames are written straight into the
// FFmpeg image2pipe; the ack is deferred until the pipe drains so Chrome paces
// itself to the encoder instead of buffering unboundedly.
async function startScreencast() {
  await stopScreencast();
  const client = await page.createCDPSession();
  cdpClient = client;

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    try {
      if (ffmpegStream && !ffmpegStream.destroyed && !isBrowserRestarting) {
        const ok = ffmpegStream.write(Buffer.from(data, 'base64'));
        if (!ok) await new Promise(resolve => ffmpegStream.once('drain', resolve));
      }
    } catch (err) {
      console.warn('▶ Capture error:', err.message);
    } finally {
      // Always ack (even when skipping) or Chrome stops sending frames.
      client.send('Page.screencastFrameAck', { sessionId }).catch(() => { });
    }
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: SCREENSHOT_QUALITY,
    maxWidth: VIEW_DIMENSIONS.width,
    maxHeight: VIEW_DIMENSIONS.height,
    everyNthFrame: 1
  });
  console.log('🎥 Screencast capture started');
}

async function stopScreencast() {
  if (!cdpClient) return;
  try { await cdpClient.send('Page.stopScreencast'); } catch { }
  try { await cdpClient.detach(); } catch { }
  cdpClient = null;
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
    // Stamp each piped frame with its real arrival time instead of assuming a
    // perfect cadence. The screencast delivers frames at a variable rate (the
    // page only repaints when content changes), so trusting a fixed framerate
    // would make the video stream end early while audio runs on — the picture
    // appears to "freeze" partway through. Wallclock timestamps drive the real
    // timing; -framerate is just a nominal fallback for the image2pipe demuxer.
    .addInputOptions(['-use_wallclock_as_timestamps', '1', '-framerate', String(FRAME_RATE)])
    .input(path.join(__dirname, 'audio_list.txt'))
    .addInputOptions(['-f', 'concat', '-safe', '0', '-stream_loop', '-1'])
    .complexFilter([
      `[0:v]scale=${VIEW_DIMENSIONS.width}:${VIEW_DIMENSIONS.height}[v]`,
      `[1:a]volume=0.5[a]`
    ]);

  const outputOpts = [
    // Passthrough (VFR) the wallclock-timed frames: encode only what the
    // capture loop actually produced, stamped at real arrival time. This keeps
    // video length matched to real elapsed time / audio (no mid-way freeze)
    // WITHOUT CFR frame-duplication, which would inflate encoder load to the
    // full FRAME_RATE even when capture runs slower.
    '-vsync', 'vfr',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-c:a', 'aac',
    // JPEG frames encode as full-range yuvj420p, which many players and upload
    // pipelines reject; force standard yuv420p for broad compatibility.
    '-pix_fmt', 'yuv420p',
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
    .on('end', async () => {
      if (videoProgressInterval) { clearInterval(videoProgressInterval); videoProgressInterval = null; }
      isStreamReady = false;

      if (isMp4Mode) {
        const absPath = path.resolve(outputPath);
        const fileSize = fs.existsSync(absPath)
          ? `${(fs.statSync(absPath).size / (1024 * 1024)).toFixed(2)} MB`
          : '0 MB';

        // Fail loudly on a broken file instead of reporting success.
        try {
          const info = await verifyRecording(absPath, WRITE_VIDEO_LENGTH);
          console.log('✅ Recording complete and verified.');
          console.log(`📁 Final Output: ${absPath} (${fileSize})`);
          console.log(`🔎 Verified: video ${info.vDur.toFixed(1)}s / audio ${info.aDur.toFixed(1)}s / pix_fmt ${info.pix_fmt}`);
          console.log('🔌 Shutting down capture session...\n');
          await stopTranscoding();
          process.exit(0);
        } catch (verifyErr) {
          console.error('❌ Recording verification FAILED:', verifyErr.message);
          console.error(`📁 Bad output left at: ${absPath} (${fileSize}) for inspection`);
          await stopTranscoding();
          process.exit(1);
        }
      }

      ffmpegCmd = null;
      ffmpegStream = null;
    })
    .run(); // FIX: .run() is called last; listeners are on the command object, not its return value

  // --- Capture via CDP screencast (replaces the old screenshot polling loop) ---
  await startScreencast();

  // --- Periodic browser refresh (HLS mode only) ---
  if (!isMp4Mode) {
    lastSegmentVerified = null;
    startSegmentWatchdog();

    browserRefreshTimer = setInterval(async () => {
      console.log('♻️  Recreating browser to prevent memory leaks...');
      isBrowserRestarting = true;

      await stopScreencast();
      if (page && !page.isClosed()) await page.close().catch(() => { });
      if (browser) { await browser.close().catch(() => { }); browser = null; page = null; }

      await startBrowser();
      await startScreencast();  // re-attach to the fresh page

      isBrowserRestarting = false;
      console.log('♻️  Browser restarted successfully.');
    }, 10 * 60 * 1000);
  }
}

async function stopTranscoding() {
  if (videoProgressInterval) { clearInterval(videoProgressInterval); videoProgressInterval = null; }
  if (segmentWatchdog) { clearInterval(segmentWatchdog); segmentWatchdog = null; }
  if (browserRefreshTimer) { clearInterval(browserRefreshTimer); browserRefreshTimer = null; }
  await stopScreencast();
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
