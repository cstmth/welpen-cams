import type { Config } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const useLocalRelay = TRUTHY.has(
  (process.env.USE_LOCAL_RELAY ?? "").toLowerCase()
);
const relayBaseUrl = (
  process.env.LOCAL_RELAY_URL ?? "rtsp://localhost:8554"
).replace(/\/+$/, "");

// ── Stream quality ──────────────────────────────────────────────────────────
const streamQuality = (
  process.env.STREAM_QUALITY ?? "sub"
).toLowerCase() as "sub" | "main";
const streamPath = `h264Preview_01_${streamQuality}`;
const isMain = streamQuality === "main";

function cameraRtsp(id: string, envName: string): string {
  const baseUrl = requireEnv(envName).replace(/\/+$/, "");
  const fullUrl = `${baseUrl}/${streamPath}`;
  return useLocalRelay ? `${relayBaseUrl}/${id}` : fullUrl;
}

// A camera is enabled unless CAMERA_<n>_ENABLED is explicitly set to a falsy
// value. A disabled camera still streams its own YouTube endpoint but only the
// offline placeholder image — its RTSP is never connected, so CAMERA_<n>_RTSP is
// not required (CAMERA_<n>_YOUTUBE still is).
function cameraEnabled(n: number): boolean {
  const value = process.env[`CAMERA_${n}_ENABLED`];
  if (value === undefined || value === "") return true;
  return TRUTHY.has(value.toLowerCase());
}

function buildStreams(): Config["streams"] {
  const streams: Config["streams"] = [];
  for (let n = 1; n <= 4; n++) {
    const id = `camera-${n}`;
    const enabled = cameraEnabled(n);
    streams.push({
      id,
      name: `Camera ${n}`,
      rtsp: enabled ? cameraRtsp(id, `CAMERA_${n}_RTSP`) : "",
      youtube: requireEnv(`CAMERA_${n}_YOUTUBE`),
      enabled,
    });
  }
  return streams;
}

// ── Video encoder ───────────────────────────────────────────────────────────
// "libx264"             — CPU, works everywhere (default)
// "h264_qsv"            — Intel Quick Sync (DS224+, NAS with Intel iGPU)
// "h264_videotoolbox"   — macOS hardware encoder
const videoEncoder = (process.env.VIDEO_ENCODER ?? "libx264").toLowerCase();

function videoEncodeOpts(bitrate: string, bufsize: string): string[] {
  const opts = [
    "-c:v",
    videoEncoder,
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    bitrate,
    "-maxrate",
    bitrate,
    "-minrate",
    bitrate,
    "-bufsize",
    bufsize,
  ];

  if (videoEncoder === "libx264") {
    opts.push("-preset", "veryfast", "-tune", "zerolatency");
  } else if (videoEncoder === "h264_qsv") {
    opts.push("-preset", "veryfast");
  } else if (videoEncoder === "h264_videotoolbox") {
    opts.push("-realtime", "true");
  }

  return opts;
}

// ── Quality-dependent presets ───────────────────────────────────────────────
const liveVideoBitrate = isMain ? "4000k" : "1500k";
const liveBufsize = isMain ? "8000k" : "3000k";
const combinedTileWidth = isMain ? 1440 : 960;
const combinedTileHeight = isMain ? 808 : 540;
const combinedVideoBitrate = isMain ? "6000k" : "3000k";
const combinedBufsize = isMain ? "12000k" : "6000k";
const combinedFramerate = 10;

const rtspInputOptions = [
  "-rtsp_transport",
  "tcp",
  "-rtsp_flags",
  "prefer_tcp",
  "-analyzeduration",
  "10000000",
  "-probesize",
  "10000000",
  "-fflags",
  "+genpts+discardcorrupt",
  "-use_wallclock_as_timestamps",
  "1",
  "-rtbufsize",
  "16M",
];

const combinedInputOptions = [
  "-thread_queue_size",
  "512",
  "-rtsp_transport",
  "tcp",
  "-rtsp_flags",
  "prefer_tcp",
  "-analyzeduration",
  "10000000",
  "-probesize",
  "10000000",
  "-fflags",
  "+genpts+discardcorrupt",
  "-rtbufsize",
  "16M",
];

const flvOutputOptions = [
  "-f",
  "flv",
  "-flvflags",
  "no_duration_filesize",
  "-rtmp_live",
  "live",
];

const combinedYoutube = process.env.COMBINED_YOUTUBE;

const config: Config = {
  streams: buildStreams(),

  combined: combinedYoutube
    ? {
        id: "combined",
        name: "Combined View",
        youtube: combinedYoutube,
        imagePath: process.env.COMBINED_IMAGE_PATH,
        tileWidth: combinedTileWidth,
        tileHeight: combinedTileHeight,
        framerate: combinedFramerate,
        inputOptions: combinedInputOptions,
        outputOptions: [
          "-af",
          "volume=0.001",
          ...videoEncodeOpts(combinedVideoBitrate, combinedBufsize),
          "-r",
          String(combinedFramerate),
          "-g",
          String(combinedFramerate * 2),
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "44100",
          "-ac",
          "2",
          ...flvOutputOptions,
        ],
      }
    : null,

  monitoring: {
    checkInterval: 120000,
    similarityThreshold: 0.999,
    captureWidth: 320,
    captureHeight: 240,
    consecutiveFailures: 2,
  },

  retry: {
    maxAttempts: 5,
    initialDelay: 5000,
    maxDelay: 80000,
    backoffMultiplier: 2,
  },

  ffmpeg: {
    live: {
      inputOptions: rtspInputOptions,
      outputOptions: [
        ...videoEncodeOpts(liveVideoBitrate, liveBufsize),
        "-force_key_frames",
        "expr:gte(t,n_forced*2)",
        "-af",
        "aresample=async=1:first_pts=0,volume=0.001",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-max_muxing_queue_size",
        "1024",
        ...flvOutputOptions,
      ],
    },

    offline: {
      imagePath: process.env.OFFLINE_IMAGE_PATH ?? "./assets/offline.png",
      framerate: 30,
      inputOptions: ["-re", "-loop", "1"],
      outputOptions: [
        "-af",
        "volume=0.001",
        ...videoEncodeOpts("2500k", "5000k"),
        "-g",
        "60",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        ...flvOutputOptions,
      ],
    },
  },

  logging: {
    level: (process.env.LOG_LEVEL ?? "info") as string,
    console: {
      enabled: true,
      colorize: true,
    },
    file: {
      enabled: true,
      directory: "./logs",
      combined: {
        filename: "combined-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "14d",
      },
      error: {
        filename: "error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "30d",
      },
    },
  },

  streaming: {
    reconnectDelay: 5000,
  },

  diagnostics: {
    statsEnabled: true,
    statsPeriod: 5,
    reportInterval: 30,
    restartOnStall: true,
  },

  process: {
    shutdownTimeout: 5000,
    forceKillTimeout: 10000,
  },
};

export default config;
