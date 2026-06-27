export interface StreamConfig {
  id: string;
  name: string;
  rtsp: string;
  youtube: string;
}

export interface CombinedStreamConfig {
  id: string;
  name: string;
  youtube: string;
  imagePath?: string;
  tileWidth: number;
  tileHeight: number;
  // Constant frame rate each input is normalized to before stacking. Match the
  // camera source fps to avoid duplicate/drop churn in the composite.
  framerate: number;
  inputOptions: string[];
  outputOptions: string[];
}

export interface MonitoringConfig {
  checkInterval: number;
  similarityThreshold: number;
  captureWidth: number;
  captureHeight: number;
  consecutiveFailures: number;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface FFmpegLiveConfig {
  inputOptions: string[];
  outputOptions: string[];
}

export interface FFmpegOfflineConfig {
  imagePath: string;
  framerate: number;
  inputOptions: string[];
  outputOptions: string[];
}

export interface FFmpegConfig {
  live: FFmpegLiveConfig;
  offline: FFmpegOfflineConfig;
}

export interface LogFileConfig {
  filename: string;
  datePattern: string;
  maxSize: string;
  maxFiles: string;
}

export interface LoggingConfig {
  level: string;
  console: {
    enabled: boolean;
    colorize: boolean;
  };
  file: {
    enabled: boolean;
    directory: string;
    combined: LogFileConfig;
    error: LogFileConfig;
  };
}

export interface ProcessConfig {
  shutdownTimeout: number;
  forceKillTimeout: number;
}

export interface StreamingConfig {
  // Delay before reconnecting to the same YouTube URL, so YouTube releases the
  // previous ingestion and does not report a duplicate stream (milliseconds)
  reconnectDelay: number;
}

export interface DiagnosticsConfig {
  // Parse FFmpeg -progress output and log per-stream connection/throughput stats
  statsEnabled: boolean;
  // How often FFmpeg emits a progress snapshot (seconds)
  statsPeriod: number;
  // How often an aggregated connection-quality summary is logged (seconds)
  reportInterval: number;
  // Restart the stream when a stall is detected (no frames forwarded within a
  // report window). Requires statsEnabled.
  restartOnStall: boolean;
}

export interface Config {
  streams: StreamConfig[];
  combined: CombinedStreamConfig | null;
  monitoring: MonitoringConfig;
  retry: RetryConfig;
  ffmpeg: FFmpegConfig;
  logging: LoggingConfig;
  streaming: StreamingConfig;
  diagnostics: DiagnosticsConfig;
  process: ProcessConfig;
}

export enum StreamState {
  STARTING = "STARTING",
  LIVE = "LIVE",
  CHECKING = "CHECKING",
  OFFLINE = "OFFLINE",
  RECOVERING = "RECOVERING",
  STOPPED = "STOPPED",
}

export interface StreamStatus {
  id: string;
  name: string;
  state: StreamState;
  retryCount: number;
  isMonitoring: boolean;
  hasLiveProcess: boolean;
  hasOfflineProcess: boolean;
}

