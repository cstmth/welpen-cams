/**
 * Type definitions for the RTSP to YouTube Stream Relay
 */

export interface StreamConfig {
  id: string;
  name: string;
  rtsp: string;
  youtube: string;
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
  rtspTransport: string;
  videoCodec: string;
  audioCodec: string;
  audioBitrate: string;
  format: string;
  inputOptions: string[];
  outputOptions: string[];
}

export interface FFmpegOfflineConfig {
  width: number;
  height: number;
  framerate: number;
  videoCodec: string;
  videoBitrate: string;
  preset: string;
  text: string;
  fontSize: number;
  fontColor: string;
  backgroundColor: string;
  format: string;
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

export interface Config {
  streams: StreamConfig[];
  monitoring: MonitoringConfig;
  retry: RetryConfig;
  ffmpeg: FFmpegConfig;
  logging: LoggingConfig;
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

export interface FrameComparisonResult {
  similarity: number;
  isFrozen: boolean;
}
