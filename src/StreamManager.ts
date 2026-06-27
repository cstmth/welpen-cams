import { StreamMonitor } from "./StreamMonitor.js";
import { FFmpegManager } from "./FFmpegManager.js";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
} from "./logger.js";
import config from "./config.js";
import { StreamState } from "./types.js";
import type { StreamConfig, StreamStatus } from "./types.js";

export class StreamManager {
  private id: string;
  private name: string;
  private rtspUrl: string;
  private youtubeUrl: string;

  private state: StreamState = StreamState.STOPPED;
  private retryCount: number = 0;
  private retryTimeout: NodeJS.Timeout | null = null;
  private offlineRetryTimeout: NodeJS.Timeout | null = null;
  private orphanedStateCheckInterval: NodeJS.Timeout | null = null;
  private hasConnected: boolean = false;

  public onStateChange: ((oldState: StreamState, newState: StreamState) => void) | null = null;

  private monitor: StreamMonitor;
  private ffmpeg: FFmpegManager;

  constructor(streamConfig: StreamConfig) {
    this.id = streamConfig.id;
    this.name = streamConfig.name;
    this.rtspUrl = streamConfig.rtsp;
    this.youtubeUrl = streamConfig.youtube;

    this.monitor = new StreamMonitor(this.id, this.rtspUrl);
    this.ffmpeg = new FFmpegManager(this.id);

    this.monitor.onStreamOffline = () => this.handleStreamOffline();
    this.monitor.onStreamOnline = () => this.handleStreamOnline();
    this.ffmpeg.onLiveStall = () => this.handleStreamStall();
  }

  async start(): Promise<void> {
    if (this.state !== StreamState.STOPPED) {
      logStreamWarning(this.id, "Stream manager already running", {
        currentState: this.state,
      });
      return;
    }

    logStreamEvent(this.id, "Starting stream manager", { name: this.name });
    this.setState(StreamState.STARTING);
    await this.startLiveStream();
  }

  async stop(): Promise<void> {
    logStreamEvent(this.id, "Stopping stream manager");

    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    if (this.offlineRetryTimeout) {
      clearTimeout(this.offlineRetryTimeout);
      this.offlineRetryTimeout = null;
    }
    if (this.orphanedStateCheckInterval) {
      clearInterval(this.orphanedStateCheckInterval);
      this.orphanedStateCheckInterval = null;
    }

    this.monitor.stop();
    await this.ffmpeg.stopAll();
    await this.monitor.cleanup();

    this.setState(StreamState.STOPPED);
    logStreamEvent(this.id, "Stream manager stopped");
  }

  private async startLiveStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Attempting to start live stream", {
        attempt: this.retryCount + 1,
        maxAttempts: config.retry.maxAttempts,
      });

      await this.ffmpeg.stopAll();

      if (this.hasConnected) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.streaming.reconnectDelay)
        );
        if (this.state === StreamState.STOPPED) return;
      }

      await this.ffmpeg.startLiveStream(this.rtspUrl, this.youtubeUrl);

      this.retryCount = 0;
      this.hasConnected = true;
      this.setState(StreamState.LIVE);

      logStreamEvent(this.id, "Live stream started successfully");
      this.monitor.start();
      this.scheduleOrphanedStateCheck();
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start live stream",
        attempt: this.retryCount + 1,
      });
      await this.retryConnection();
    }
  }

  private async retryConnection(): Promise<void> {
    if (this.state === StreamState.STOPPED) return;

    this.retryCount++;

    if (this.retryCount >= config.retry.maxAttempts) {
      logStreamWarning(
        this.id,
        "Max retry attempts reached, switching to offline placeholder",
        { attempts: this.retryCount }
      );
      await this.startOfflineStream();
      return;
    }

    const delay = Math.min(
      config.retry.initialDelay *
        Math.pow(config.retry.backoffMultiplier, this.retryCount - 1),
      config.retry.maxDelay
    );

    logStreamEvent(this.id, "Scheduling retry", {
      attempt: this.retryCount,
      delayMs: delay,
    });

    this.retryTimeout = setTimeout(async () => {
      this.retryTimeout = null;
      await this.startLiveStream();
    }, delay);
  }

  private async startOfflineStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Starting offline placeholder stream");

      await this.ffmpeg.stopAll();
      await this.ffmpeg.startOfflineStream(this.youtubeUrl);

      this.setState(StreamState.OFFLINE);
      logStreamEvent(this.id, "Offline placeholder started successfully");

      if (!this.monitor["isMonitoring"]) {
        this.monitor.start();
      }
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start offline placeholder",
      });

      this.offlineRetryTimeout = setTimeout(() => {
        this.offlineRetryTimeout = null;
        if (
          this.state === StreamState.OFFLINE ||
          this.state === StreamState.STARTING
        ) {
          this.startOfflineStream();
        }
      }, 10000);
    }
  }

  private async handleStreamOffline(): Promise<void> {
    if (this.state !== StreamState.LIVE) return;

    logStreamWarning(this.id, "Stream detected as offline by monitor");
    this.retryCount = 0;
    await this.startLiveStream();
  }

  private async handleStreamStall(): Promise<void> {
    if (this.state !== StreamState.LIVE) return;

    logStreamWarning(
      this.id,
      "Stream stalled (no frames forwarded) - restarting stream"
    );
    this.setState(StreamState.STARTING);
    this.retryCount = 0;
    await this.startLiveStream();
  }

  private async handleStreamOnline(): Promise<void> {
    if (this.state !== StreamState.OFFLINE) return;

    logStreamEvent(this.id, "Stream recovery detected, switching back to live");
    this.setState(StreamState.RECOVERING);
    this.retryCount = 0;
    await this.startLiveStream();
  }

  private setState(newState: StreamState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      logStreamEvent(this.id, "State changed", { from: oldState, to: newState });
      if (this.onStateChange) {
        this.onStateChange(oldState, newState);
      }
    }
  }

  private scheduleOrphanedStateCheck(): void {
    if (this.orphanedStateCheckInterval) {
      clearInterval(this.orphanedStateCheckInterval);
    }

    this.orphanedStateCheckInterval = setInterval(() => {
      const status = this.getStatus();
      if (
        status.state === StreamState.LIVE &&
        !status.hasLiveProcess &&
        !status.hasOfflineProcess
      ) {
        logStreamWarning(
          this.id,
          "Orphaned state detected - state is LIVE but no FFmpeg process running",
          {
            state: status.state,
            hasLiveProcess: status.hasLiveProcess,
            hasOfflineProcess: status.hasOfflineProcess,
          }
        );
        this.handleStreamOffline();
      }
    }, 30000);
  }

  getStatus(): StreamStatus {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      retryCount: this.retryCount,
      isMonitoring: this.monitor["isMonitoring"],
      hasLiveProcess: this.ffmpeg["liveProcess"] !== null,
      hasOfflineProcess: this.ffmpeg["offlineProcess"] !== null,
    };
  }
}
