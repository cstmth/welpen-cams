/**
 * Configuration for RTSP to YouTube Stream Relay
 */

import type { Config } from "./types.js";

const config: Config = {
  // Stream definitions
  streams: [
    {
      id: "camera-1",
      name: "Camera 1",
      rtsp: "rtsp://admin:Carli2907@192.168.178.90:554/h264Preview_01_main",
      youtube: "rtmp://a.rtmp.youtube.com/live2/mvs6-7b44-4qd0-agc6-bere",
    },
    {
      id: "camera-2",
      name: "Camera 2",
      rtsp: "rtsp://admin:Carli2907@192.168.178.91:554/h264Preview_01_main",
      youtube: "rtmp://a.rtmp.youtube.com/live2/cgk4-hd82-epwm-xzja-c6qj",
    },
    {
      id: "camera-3",
      name: "Camera 3",
      rtsp: "rtsp://admin:Carli2907@192.168.178.92:554/h264Preview_01_main",
      youtube: "rtmp://a.rtmp.youtube.com/live2/5xxa-fb56-zqyk-1wus-5wym",
    },
  ],

  // Stream monitoring settings
  monitoring: {
    // Interval between frame captures for comparison (milliseconds)
    checkInterval: 10000, // 10 seconds

    // Similarity threshold to consider stream as frozen (0-1)
    // 0.999 means 99.9% similarity triggers offline detection
    similarityThreshold: 0.999,

    // Resolution for frame capture (lower = faster comparison)
    captureWidth: 320,
    captureHeight: 240,

    // Number of consecutive frozen checks before marking as offline
    consecutiveFailures: 1,
  },

  // Retry logic settings
  retry: {
    // Maximum number of retry attempts before switching to placeholder
    maxAttempts: 5,

    // Initial retry delay in milliseconds
    initialDelay: 5000, // 5 seconds

    // Maximum retry delay in milliseconds
    maxDelay: 80000, // 80 seconds

    // Multiplier for exponential backoff
    backoffMultiplier: 2,
  },

  // FFmpeg settings for live streaming
  ffmpeg: {
    live: {
      // RTSP transport protocol
      rtspTransport: "tcp",

      // Video codec (copy = no re-encoding)
      videoCodec: "copy",

      // Audio codec
      audioCodec: "aac",

      // Audio bitrate
      audioBitrate: "128k",

      // Output format
      format: "flv",

      // Additional input options
      inputOptions: ["-rtsp_transport tcp"],

      // Additional output options
      outputOptions: [
        "-c:v copy",
        "-c:a aac",
        "-b:a 128k",
        "-f flv",
        "-reconnect 1",
        "-reconnect_streamed 1",
        "-reconnect_delay_max 5",
      ],
    },

    // Settings for offline placeholder stream
    offline: {
      // Video resolution
      width: 1920,
      height: 1080,

      // Frame rate
      framerate: 30,

      // Video codec
      videoCodec: "libx264",

      // Video bitrate
      videoBitrate: "2500k",

      // Encoding preset
      preset: "veryfast",

      // Text to display
      text: "Stream ist offline",

      // Text styling
      fontSize: 60,
      fontColor: "white",
      backgroundColor: "black",

      // Output format
      format: "flv",
    },
  },

  // Logging configuration
  logging: {
    // Log level: 'error', 'warn', 'info', 'debug'
    level: "debug", // DIAGNOSTIC: Temporarily set to debug for troubleshooting

    // Console logging
    console: {
      enabled: true,
      colorize: true,
    },

    // File logging
    file: {
      enabled: true,
      directory: "./logs",

      // Combined log (all levels)
      combined: {
        filename: "combined-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "14d",
      },

      // Error log (errors only)
      error: {
        filename: "error-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxSize: "20m",
        maxFiles: "30d",
      },
    },
  },

  // Stream restart settings
  streaming: {
    // Interval for automatic stream restarts (milliseconds)
    // Set to 0 to disable automatic restarts
    // Default: 300000ms (5 minutes)
    restartInterval: 300000,
  },

  // Process management
  process: {
    // Grace period for FFmpeg process shutdown (milliseconds)
    shutdownTimeout: 5000,

    // Force kill timeout if graceful shutdown fails (milliseconds)
    forceKillTimeout: 10000,
  },
};

export default config;
