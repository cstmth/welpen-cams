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
  private enabled: boolean;

  private state: StreamState = StreamState.STOPPED;
  private retryCount: number = 0;
  private retryTimeout: NodeJS.Timeout | null = null;
  private offlineRetryTimeout: NodeJS.Timeout | null = null;
  private orphanedStateCheckInterval: NodeJS.Timeout | null = null;
  private hasConnected: boolean = false;

  // Consecutive stall/freeze-triggered restarts (distinct from retryCount,
  // which tracks connection failures - a stall/freeze restart always
  // "succeeds" at the FFmpeg level, so retryCount alone never reflects a
  // camera that keeps coming back live but broken).
  private problemRestartCount: number = 0;
  private problemCooldownTimeout: NodeJS.Timeout | null = null;

  public onStateChange: ((oldState: StreamState, newState: StreamState) => void) | null = null;

  private monitor: StreamMonitor;
  private ffmpeg: FFmpegManager;

  constructor(streamConfig: StreamConfig) {
    this.id = streamConfig.id;
    this.name = streamConfig.name;
    this.rtspUrl = streamConfig.rtsp;
    this.youtubeUrl = streamConfig.youtube;
    this.enabled = streamConfig.enabled;

    this.monitor = new StreamMonitor(this.id, this.rtspUrl);
    this.ffmpeg = new FFmpegManager(this.id);

    this.monitor.onStreamOffline = () => this.handleStreamOffline();
    this.monitor.onStreamOnline = () => this.handleStreamOnline();
    this.ffmpeg.onLiveStall = () =>
      this.handleStreamProblem("Stream stalled (no frames forwarded)");
    this.ffmpeg.onFreezeDetected = () =>
      this.handleStreamProblem("Frozen frame detected (freezedetect)");
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

    if (!this.enabled) {
      logStreamEvent(
        this.id,
        "Camera disabled - streaming offline placeholder only (RTSP not connected, excluded from combined)"
      );
      await this.startOfflineStream();
      return;
    }

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
    if (this.problemCooldownTimeout) {
      clearTimeout(this.problemCooldownTimeout);
      this.problemCooldownTimeout = null;
    }
    this.problemRestartCount = 0;

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

      // A disabled camera must never recover to live, so don't monitor its RTSP.
      if (this.enabled && !this.monitor["isMonitoring"]) {
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

  // Shared handler for both FFmpegManager.onLiveStall and onFreezeDetected -
  // both mean "the process is running but the picture isn't healthy," so
  // they get the same restart-with-eventual-offline-fallback treatment.
  private async handleStreamProblem(reason: string): Promise<void> {
    if (this.state !== StreamState.LIVE) return;

    if (this.problemCooldownTimeout) {
      clearTimeout(this.problemCooldownTimeout);
      this.problemCooldownTimeout = null;
    }
    this.problemRestartCount++;

    if (this.problemRestartCount >= config.retry.maxAttempts) {
      logStreamWarning(
        this.id,
        `${reason} - too many consecutive restarts, switching to offline placeholder`,
        { problemRestartCount: this.problemRestartCount }
      );
      this.problemRestartCount = 0;
      await this.startOfflineStream();
      return;
    }

    logStreamWarning(this.id, `${reason} - restarting stream`, {
      problemRestartCount: this.problemRestartCount,
    });
    this.setState(StreamState.STARTING);
    this.retryCount = 0;
    await this.startLiveStream();

    // Only count restarts that recur in quick succession as "consecutive" -
    // once the stream has run this long without another stall/freeze,
    // treat it as recovered and give it a fresh budget.
    this.problemCooldownTimeout = setTimeout(() => {
      this.problemCooldownTimeout = null;
      this.problemRestartCount = 0;
    }, config.diagnostics.freezeDetectDuration * 2 * 1000);
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
