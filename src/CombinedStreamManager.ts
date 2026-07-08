import { FFmpegManager } from "./FFmpegManager.js";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
} from "./logger.js";
import config from "./config.js";
import { StreamState } from "./types.js";
import type { CombinedStreamConfig, StreamStatus } from "./types.js";
import type { StreamManager } from "./StreamManager.js";

const RECOVERY_INTERVAL = 60000;
const PROCESS_CHECK_INTERVAL = 10000;

export class CombinedStreamManager {
  private id: string;
  private name: string;
  private youtubeUrl: string;
  private imagePath: string | undefined;
  private streamManagers: StreamManager[];
  private streamConfig: CombinedStreamConfig;

  private state: StreamState = StreamState.STOPPED;
  private retryCount: number = 0;
  private retryTimeout: NodeJS.Timeout | null = null;
  private offlineRetryTimeout: NodeJS.Timeout | null = null;
  private processCheckInterval: NodeJS.Timeout | null = null;
  private forcedRestartInterval: NodeJS.Timeout | null = null;

  // Consecutive stall/freeze-triggered restarts (distinct from retryCount,
  // which tracks connection failures - a stall/freeze restart always
  // "succeeds" at the FFmpeg level, so retryCount alone never reflects a
  // combined stream that keeps coming back live but broken).
  private problemRestartCount: number = 0;
  private problemCooldownTimeout: NodeJS.Timeout | null = null;

  private ffmpeg: FFmpegManager;

  constructor(combinedConfig: CombinedStreamConfig, streamManagers: StreamManager[]) {
    this.id = combinedConfig.id;
    this.name = combinedConfig.name;
    this.youtubeUrl = combinedConfig.youtube;
    this.imagePath = combinedConfig.imagePath;
    this.streamManagers = streamManagers;
    this.streamConfig = combinedConfig;
    this.ffmpeg = new FFmpegManager(this.id);

    // Restart the combined stream if its FFmpeg process stalls or a tile
    // freezes.
    this.ffmpeg.onLiveStall = () =>
      this.handleStreamProblem("Combined stream stalled (no frames forwarded)");
    this.ffmpeg.onFreezeDetected = (cameraId) =>
      this.handleStreamProblem(`Frozen tile detected for ${cameraId} in combined stream`);
  }

  async start(): Promise<void> {
    if (this.state !== StreamState.STOPPED) {
      logStreamWarning(this.id, "Combined stream manager already running", {
        currentState: this.state,
      });
      return;
    }

    logStreamEvent(this.id, "Starting combined stream manager", {
      name: this.name,
      cameras: this.streamManagers.length,
    });

    this.setState(StreamState.STARTING);
    await this.startCombinedStream();
  }

  async stop(): Promise<void> {
    logStreamEvent(this.id, "Stopping combined stream manager");

    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    if (this.offlineRetryTimeout) {
      clearTimeout(this.offlineRetryTimeout);
      this.offlineRetryTimeout = null;
    }

    if (this.processCheckInterval) {
      clearInterval(this.processCheckInterval);
      this.processCheckInterval = null;
    }
    if (this.forcedRestartInterval) {
      clearInterval(this.forcedRestartInterval);
      this.forcedRestartInterval = null;
    }
    if (this.problemCooldownTimeout) {
      clearTimeout(this.problemCooldownTimeout);
      this.problemCooldownTimeout = null;
    }
    this.problemRestartCount = 0;

    await this.ffmpeg.stopAll();

    this.setState(StreamState.STOPPED);
    logStreamEvent(this.id, "Combined stream manager stopped");
  }

  private async startCombinedStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Attempting to start combined stream", {
        attempt: this.retryCount + 1,
        maxAttempts: config.retry.maxAttempts,
      });

      await this.ffmpeg.stopAll();

      const liveManagers = this.streamManagers.filter(
        (manager) => manager.getStatus().state === StreamState.LIVE
      );

      if (liveManagers.length === 0) {
        logStreamWarning(this.id, "No live cameras available for combined stream. Switching to offline placeholder.");
        // Use a timeout to avoid synchronous loop if called from startOfflineStream or similar
        setTimeout(() => this.startOfflineStream(), 100);
        return;
      }

      const inputs = liveManagers.map((manager) => {
        const url = manager["rtspUrl"] || "";
        return {
          id: manager.getStatus().id,
          url,
          isOffline: false
        };
      });

      await this.ffmpeg.startCombinedStream(
        inputs,
        this.imagePath,
        this.youtubeUrl,
        this.streamConfig
      );

      this.retryCount = 0;
      this.setState(StreamState.LIVE);

      logStreamEvent(this.id, "Combined stream started successfully");

      this.scheduleProcessCheck();
      this.scheduleForcedRestart();
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start combined stream",
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
      await this.startCombinedStream();
    }, delay);
  }

  private async startOfflineStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Starting offline placeholder for combined stream");

      await this.ffmpeg.stopAll();
      await this.ffmpeg.startOfflineStream(this.youtubeUrl);

      this.setState(StreamState.OFFLINE);
      logStreamEvent(this.id, "Offline placeholder started, scheduling recovery");

      this.scheduleRecoveryCheck();
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start offline placeholder",
      });

      this.offlineRetryTimeout = setTimeout(() => {
        this.offlineRetryTimeout = null;
        if (this.state === StreamState.OFFLINE || this.state === StreamState.STARTING) {
          this.startOfflineStream();
        }
      }, 10000);
    }
  }

  // Bare restart, no problem-counting - used for routine layout rebuilds
  // (handleCameraStateChange) where nothing is actually broken.
  private async restartCombined(): Promise<void> {
    this.setState(StreamState.STARTING);
    this.retryCount = 0;
    await this.startCombinedStream();
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

    logStreamWarning(this.id, `${reason} - restarting`, {
      problemRestartCount: this.problemRestartCount,
    });
    await this.restartCombined();

    // Only count restarts that recur in quick succession as "consecutive" -
    // once the stream has run this long without another stall/freeze,
    // treat it as recovered and give it a fresh budget.
    this.problemCooldownTimeout = setTimeout(() => {
      this.problemCooldownTimeout = null;
      this.problemRestartCount = 0;
    }, config.diagnostics.freezeDetectDuration * 2 * 1000);
  }

  private scheduleProcessCheck(): void {
    if (this.processCheckInterval) {
      clearInterval(this.processCheckInterval);
    }

    this.processCheckInterval = setInterval(() => {
      if (this.state === StreamState.LIVE && !this.ffmpeg.isRunning()) {
        logStreamWarning(
          this.id,
          "Combined stream process died, attempting restart"
        );
        this.retryCount = 0;
        this.startCombinedStream();
      }
    }, PROCESS_CHECK_INTERVAL);
  }

  // Blunt mitigation for a tile that freezes without ever tripping
  // stall/freeze detection: unconditionally restart on a fixed cadence
  // regardless of any health signal. Opt-in via
  // COMBINED_RESTART_INTERVAL_MINUTES; disabled (undefined) by default.
  private scheduleForcedRestart(): void {
    if (this.forcedRestartInterval) {
      clearInterval(this.forcedRestartInterval);
      this.forcedRestartInterval = null;
    }

    const minutes = this.streamConfig.restartIntervalMinutes;
    if (!minutes) return;

    this.forcedRestartInterval = setInterval(() => {
      if (this.state !== StreamState.LIVE) return;
      logStreamEvent(
        this.id,
        `Scheduled restart (COMBINED_RESTART_INTERVAL_MINUTES=${minutes})`
      );
      this.restartCombined();
    }, minutes * 60 * 1000);
  }

  private scheduleRecoveryCheck(): void {
    if (this.processCheckInterval) {
      clearInterval(this.processCheckInterval);
    }

    this.processCheckInterval = setInterval(async () => {
      if (this.state !== StreamState.OFFLINE) return;

      logStreamEvent(this.id, "Attempting combined stream recovery");
      this.retryCount = 0;
      await this.startCombinedStream();
    }, RECOVERY_INTERVAL);
  }

  handleCameraStateChange(cameraId: string, oldState: StreamState, newState: StreamState): void {
    if (this.state !== StreamState.LIVE) return;

    // Restart layout if a camera becomes LIVE or stops being LIVE
    const wasLive = oldState === StreamState.LIVE;
    const isLive = newState === StreamState.LIVE;

    if (wasLive !== isLive) {
      logStreamEvent(this.id, `Camera ${cameraId} state changed to ${newState}, restarting combined stream to update layout`);
      this.restartCombined();
    }
  }

  private setState(newState: StreamState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      logStreamEvent(this.id, "State changed", {
        from: oldState,
        to: newState,
      });
    }
  }

  getStatus(): StreamStatus {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      retryCount: this.retryCount,
      isMonitoring: this.processCheckInterval !== null,
      hasLiveProcess: this.ffmpeg["liveProcess"] !== null,
      hasOfflineProcess: this.ffmpeg["offlineProcess"] !== null,
    };
  }
}
