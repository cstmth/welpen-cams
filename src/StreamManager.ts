/**
 * StreamManager - Manages the complete lifecycle of a single stream
 * Handles state transitions, retry logic, and coordination between monitoring and streaming
 */

import { StreamMonitor } from "./StreamMonitor.js";
import { FFmpegManager } from "./FFmpegManager.js";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
  logStreamDebug,
} from "./logger.js";
import config from "./config.js";
import type { StreamConfig, StreamState, StreamStatus } from "./types.js";

// Stream states
export const States: Record<string, StreamState> = {
  STARTING: "STARTING" as StreamState,
  LIVE: "LIVE" as StreamState,
  CHECKING: "CHECKING" as StreamState,
  OFFLINE: "OFFLINE" as StreamState,
  RECOVERING: "RECOVERING" as StreamState,
  STOPPED: "STOPPED" as StreamState,
};

export class StreamManager {
  private id: string;
  private name: string;
  private rtspUrl: string;
  private youtubeUrl: string;

  private state: StreamState;
  private retryCount: number = 0;
  private retryTimeout: NodeJS.Timeout | null = null;

  // Automatic restart timer
  private restartTimer: NodeJS.Timeout | null = null;
  private lastRestartTime: number | null = null;

  private monitor: StreamMonitor;
  private ffmpeg: FFmpegManager;

  constructor(streamConfig: StreamConfig) {
    this.id = streamConfig.id;
    this.name = streamConfig.name;
    this.rtspUrl = streamConfig.rtsp;
    this.youtubeUrl = streamConfig.youtube;

    this.state = States.STOPPED;

    // Initialize components
    this.monitor = new StreamMonitor(this.id, this.rtspUrl);
    this.ffmpeg = new FFmpegManager(this.id);

    // Bind monitor callbacks
    this.monitor.onStreamOffline = () => this.handleStreamOffline();
    this.monitor.onStreamOnline = () => this.handleStreamOnline();
  }

  /**
   * Start the stream manager
   */
  async start(): Promise<void> {
    if (this.state !== States.STOPPED) {
      logStreamWarning(this.id, "Stream manager already running", {
        currentState: this.state,
      });
      return;
    }

    logStreamEvent(this.id, "Starting stream manager", {
      name: this.name,
    });

    this.setState(States.STARTING);
    await this.startLiveStream();
  }

  /**
   * Stop the stream manager
   */
  async stop(): Promise<void> {
    logStreamEvent(this.id, "Stopping stream manager");

    // Clear any pending retries
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    // Clear offline retry timeout
    if (this.offlineRetryTimeout) {
      clearTimeout(this.offlineRetryTimeout);
      this.offlineRetryTimeout = null;
    }

    // Clear orphaned state check
    if (this.orphanedStateCheckInterval) {
      clearInterval(this.orphanedStateCheckInterval);
      this.orphanedStateCheckInterval = null;
    }

    // Clear automatic restart timer
    this.cancelAutomaticRestart();

    // Stop monitoring
    this.monitor.stop();

    // Stop all FFmpeg processes
    await this.ffmpeg.stopAll();

    // Clean up monitor resources
    await this.monitor.cleanup();

    this.setState(States.STOPPED);
    logStreamEvent(this.id, "Stream manager stopped");
  }

  /**
   * Start live stream with retry logic
   */
  private async startLiveStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Attempting to start live stream", {
        attempt: this.retryCount + 1,
        maxAttempts: config.retry.maxAttempts,
      });

      // Stop any existing streams
      await this.ffmpeg.stopAll();

      // Start live stream
      await this.ffmpeg.startLiveStream(this.rtspUrl, this.youtubeUrl);

      // Stream started successfully
      this.retryCount = 0;
      this.lastRestartTime = Date.now();
      this.setState(States.LIVE);

      logStreamEvent(this.id, "Live stream started successfully");

      // Start monitoring
      this.monitor.start();

      // Schedule automatic restart
      this.scheduleAutomaticRestart();

      // DIAGNOSTIC: Schedule periodic check for orphaned state
      this.scheduleOrphanedStateCheck();
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start live stream",
        attempt: this.retryCount + 1,
      });

      // Retry with exponential backoff
      await this.retryConnection();
    }
  }

  /**
   * Retry connection with exponential backoff
   */
  private async retryConnection(): Promise<void> {
    this.retryCount++;

    if (this.retryCount >= config.retry.maxAttempts) {
      logStreamWarning(
        this.id,
        "Max retry attempts reached, switching to offline placeholder",
        {
          attempts: this.retryCount,
        }
      );

      // Switch to offline placeholder
      await this.startOfflineStream();
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      config.retry.initialDelay *
        Math.pow(config.retry.backoffMultiplier, this.retryCount - 1),
      config.retry.maxDelay
    );

    logStreamEvent(this.id, "Scheduling retry", {
      attempt: this.retryCount,
      delayMs: delay,
    });

    // Schedule retry
    this.retryTimeout = setTimeout(async () => {
      this.retryTimeout = null;
      await this.startLiveStream();
    }, delay);
  }

  /**
   * Start offline placeholder stream
   */
  private offlineRetryTimeout: NodeJS.Timeout | null = null;

  private async startOfflineStream(): Promise<void> {
    try {
      logStreamEvent(this.id, "Starting offline placeholder stream");

      // Stop any existing streams
      await this.ffmpeg.stopAll();

      // Start offline placeholder
      await this.ffmpeg.startOfflineStream(this.youtubeUrl);

      this.setState(States.OFFLINE);
      logStreamEvent(this.id, "Offline placeholder started successfully");

      // Continue monitoring for recovery
      if (!this.monitor["isMonitoring"]) {
        this.monitor.start();
      }
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Failed to start offline placeholder",
      });

      // Retry offline stream after a delay
      this.offlineRetryTimeout = setTimeout(() => {
        this.offlineRetryTimeout = null;
        if (this.state === States.OFFLINE || this.state === States.STARTING) {
          this.startOfflineStream();
        }
      }, 10000);
    }
  }

  /**
   * Handle stream detected as offline by monitor
   */
  private async handleStreamOffline(): Promise<void> {
    if (this.state !== States.LIVE) {
      return;
    }

    logStreamWarning(this.id, "Stream detected as offline by monitor");

    // Reset retry count for recovery attempts
    this.retryCount = 0;

    // Try to recover the stream
    await this.startLiveStream();
  }

  /**
   * Handle stream recovery detected by monitor
   */
  private async handleStreamOnline(): Promise<void> {
    if (this.state !== States.OFFLINE) {
      return;
    }

    logStreamEvent(this.id, "Stream recovery detected, switching back to live");

    this.setState(States.RECOVERING);

    // Reset retry count
    this.retryCount = 0;

    // Switch back to live stream
    await this.startLiveStream();
  }

  /**
   * Set stream state
   */
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

  /**
   * DIAGNOSTIC: Check for orphaned state (state=LIVE but no process)
   */
  private orphanedStateCheckInterval: NodeJS.Timeout | null = null;

  private scheduleOrphanedStateCheck(): void {
    // Clear any existing check
    if (this.orphanedStateCheckInterval) {
      clearInterval(this.orphanedStateCheckInterval);
    }

    // Check every 30 seconds
    this.orphanedStateCheckInterval = setInterval(() => {
      const status = this.getStatus();

      // Detect orphaned state: state is LIVE but no FFmpeg process is running
      if (
        status.state === States.LIVE &&
        !status.hasLiveProcess &&
        !status.hasOfflineProcess
      ) {
        logStreamWarning(
          this.id,
          "DIAGNOSTIC: Orphaned state detected - state is LIVE but no FFmpeg process running. This indicates the process exited without triggering recovery.",
          {
            state: status.state,
            hasLiveProcess: status.hasLiveProcess,
            hasOfflineProcess: status.hasOfflineProcess,
            retryCount: status.retryCount,
            isMonitoring: status.isMonitoring,
          }
        );

        // Trigger recovery
        logStreamEvent(
          this.id,
          "DIAGNOSTIC: Triggering recovery for orphaned state"
        );
        this.handleStreamOffline();
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Schedule automatic restart of live stream
   */
  private scheduleAutomaticRestart(): void {
    // Cancel any existing restart timer
    this.cancelAutomaticRestart();

    // Check if automatic restarts are enabled
    if (config.streaming.restartInterval <= 0) {
      return;
    }

    // Only schedule restart for live streams
    if (this.state !== States.LIVE) {
      return;
    }

    logStreamEvent(this.id, "Scheduling automatic restart", {
      intervalMs: config.streaming.restartInterval,
      intervalMinutes: config.streaming.restartInterval / 60000,
    });

    this.restartTimer = setTimeout(async () => {
      await this.performAutomaticRestart();
    }, config.streaming.restartInterval);
  }

  /**
   * Cancel scheduled automatic restart
   */
  private cancelAutomaticRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      logStreamDebug(this.id, "Automatic restart timer cancelled");
    }
  }

  /**
   * Perform automatic restart of live stream
   */
  private async performAutomaticRestart(): Promise<void> {
    // Only restart if stream is in LIVE state
    if (this.state !== States.LIVE) {
      logStreamDebug(
        this.id,
        "Skipping automatic restart - stream not in LIVE state",
        {
          currentState: this.state,
        }
      );
      return;
    }

    const timeSinceLastRestart = this.lastRestartTime
      ? Date.now() - this.lastRestartTime
      : null;

    logStreamEvent(this.id, "Performing scheduled automatic restart", {
      timeSinceLastRestartMs: timeSinceLastRestart,
      timeSinceLastRestartMinutes: timeSinceLastRestart
        ? (timeSinceLastRestart / 60000).toFixed(2)
        : "N/A",
    });

    // Record restart time
    this.lastRestartTime = Date.now();

    try {
      // Stop current stream
      await this.ffmpeg.stopLiveStream();

      // Start new stream
      await this.ffmpeg.startLiveStream(this.rtspUrl, this.youtubeUrl);

      logStreamEvent(this.id, "Automatic restart completed successfully");

      // Schedule next restart
      this.scheduleAutomaticRestart();
    } catch (error) {
      logStreamError(this.id, error as Error, {
        context: "Automatic restart failed",
      });

      // Fall back to normal retry logic
      await this.retryConnection();
    }
  }

  /**
   * Get current state
   */
  getState(): StreamState {
    return this.state;
  }

  /**
   * Get stream status information
   */
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
