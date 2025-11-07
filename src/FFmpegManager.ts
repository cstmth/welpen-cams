/**
 * FFmpegManager - Manages FFmpeg processes for live streaming and offline placeholders
 * Handles process lifecycle, cleanup, and proper termination
 */

import { spawn, ChildProcess } from "child_process";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
  logStreamDebug,
} from "./logger.js";
import config from "./config.js";

export class FFmpegManager {
  private streamId: string;
  private liveProcess: ChildProcess | null = null;
  private offlineProcess: ChildProcess | null = null;
  private isShuttingDown: boolean = false;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  /**
   * Start live stream from RTSP to YouTube
   */
  startLiveStream(rtspUrl: string, youtubeUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.liveProcess) {
        logStreamWarning(this.streamId, "Live stream already running");
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Starting live stream", {
        rtsp: this.maskUrl(rtspUrl),
        youtube: this.maskUrl(youtubeUrl),
      });

      const args = [
        "-rtsp_transport",
        "tcp",
        "-i",
        rtspUrl,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        config.ffmpeg.live.audioBitrate,
        "-f",
        "flv",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        youtubeUrl,
      ];

      this.liveProcess = spawn("ffmpeg", args);

      let hasStarted = false;
      let startupTimeout: NodeJS.Timeout | null = null;

      // Cleanup function to remove all listeners and clear timeout
      const cleanup = () => {
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = null;
        }
        if (this.liveProcess) {
          this.liveProcess.stdout?.removeAllListeners();
          this.liveProcess.stderr?.removeAllListeners();
          this.liveProcess.removeAllListeners();
        }
      };

      this.liveProcess.stdout?.on("data", (data: Buffer) => {
        logStreamDebug(
          this.streamId,
          `FFmpeg stdout: ${data.toString().trim()}`
        );
      });

      this.liveProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();

        // Check for successful stream start
        if (
          !hasStarted &&
          (output.includes("Stream mapping:") || output.includes("frame="))
        ) {
          hasStarted = true;
          logStreamEvent(this.streamId, "Live stream started successfully");
          if (startupTimeout) {
            clearTimeout(startupTimeout);
            startupTimeout = null;
          }
          resolve();
        }

        // Log errors and warnings
        if (output.includes("error") || output.includes("Error")) {
          logStreamWarning(this.streamId, `FFmpeg: ${output.trim()}`);
        }
      });

      this.liveProcess.on("error", (error: Error) => {
        logStreamError(this.streamId, error, {
          context: "Live stream process error",
        });

        if (!hasStarted) {
          cleanup();
          reject(error);
        }
      });

      this.liveProcess.on(
        "exit",
        (code: number | null, signal: string | null) => {
          logStreamEvent(this.streamId, "Live stream process exited", {
            code,
            signal,
          });

          cleanup();
          this.liveProcess = null;

          if (!hasStarted && !this.isShuttingDown) {
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        }
      );

      // Timeout for startup
      startupTimeout = setTimeout(() => {
        if (!hasStarted) {
          logStreamWarning(this.streamId, "Live stream startup timeout");
          cleanup();
          this.stopLiveStream();
          reject(new Error("Stream startup timeout"));
        }
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Stop live stream process
   */
  stopLiveStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.liveProcess) {
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Stopping live stream");

      const process = this.liveProcess;
      this.liveProcess = null;

      // Try graceful shutdown first
      process.kill("SIGTERM");

      // Force kill after timeout
      const forceKillTimeout = setTimeout(() => {
        if (process.killed === false) {
          logStreamWarning(this.streamId, "Force killing live stream process");
          process.kill("SIGKILL");
        }
      }, config.process.shutdownTimeout);

      process.on("exit", () => {
        clearTimeout(forceKillTimeout);
        logStreamEvent(this.streamId, "Live stream stopped");
        resolve();
      });
    });
  }

  /**
   * Start offline placeholder stream to YouTube
   */
  startOfflineStream(youtubeUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.offlineProcess) {
        logStreamWarning(this.streamId, "Offline stream already running");
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Starting offline placeholder stream", {
        youtube: this.maskUrl(youtubeUrl),
      });

      const { offline } = config.ffmpeg;

      // Build drawtext filter
      const textFilter =
        `drawtext=text='${offline.text}':` +
        `fontsize=${offline.fontSize}:` +
        `fontcolor=${offline.fontColor}:` +
        `x=(w-text_w)/2:` +
        `y=(h-text_h)/2`;

      const args = [
        "-f",
        "lavfi",
        "-i",
        `color=c=${offline.backgroundColor}:s=${offline.width}x${offline.height}:r=${offline.framerate}`,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-vf",
        textFilter,
        "-c:v",
        offline.videoCodec,
        "-preset",
        offline.preset,
        "-b:v",
        offline.videoBitrate,
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        offline.format,
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        youtubeUrl,
      ];

      this.offlineProcess = spawn("ffmpeg", args);

      let hasStarted = false;
      let startupTimeout: NodeJS.Timeout | null = null;

      // Cleanup function to remove all listeners and clear timeout
      const cleanup = () => {
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = null;
        }
        if (this.offlineProcess) {
          this.offlineProcess.stdout?.removeAllListeners();
          this.offlineProcess.stderr?.removeAllListeners();
          this.offlineProcess.removeAllListeners();
        }
      };

      this.offlineProcess.stdout?.on("data", (data: Buffer) => {
        logStreamDebug(
          this.streamId,
          `FFmpeg offline stdout: ${data.toString().trim()}`
        );
      });

      this.offlineProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();

        // Check for successful stream start
        if (
          !hasStarted &&
          (output.includes("Stream mapping:") || output.includes("frame="))
        ) {
          hasStarted = true;
          logStreamEvent(
            this.streamId,
            "Offline placeholder started successfully"
          );
          if (startupTimeout) {
            clearTimeout(startupTimeout);
            startupTimeout = null;
          }
          resolve();
        }

        // Log errors and warnings
        if (output.includes("error") || output.includes("Error")) {
          logStreamWarning(this.streamId, `FFmpeg offline: ${output.trim()}`);
        }
      });

      this.offlineProcess.on("error", (error: Error) => {
        logStreamError(this.streamId, error, {
          context: "Offline stream process error",
        });

        if (!hasStarted) {
          cleanup();
          reject(error);
        }
      });

      this.offlineProcess.on(
        "exit",
        (code: number | null, signal: string | null) => {
          logStreamEvent(this.streamId, "Offline stream process exited", {
            code,
            signal,
          });

          cleanup();
          this.offlineProcess = null;

          if (!hasStarted && !this.isShuttingDown) {
            reject(new Error(`FFmpeg offline exited with code ${code}`));
          }
        }
      );

      // Timeout for startup
      startupTimeout = setTimeout(() => {
        if (!hasStarted) {
          logStreamWarning(this.streamId, "Offline stream startup timeout");
          cleanup();
          this.stopOfflineStream();
          reject(new Error("Offline stream startup timeout"));
        }
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Stop offline placeholder stream
   */
  stopOfflineStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.offlineProcess) {
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Stopping offline placeholder stream");

      const process = this.offlineProcess;
      this.offlineProcess = null;

      // Try graceful shutdown first
      process.kill("SIGTERM");

      // Force kill after timeout
      const forceKillTimeout = setTimeout(() => {
        if (process.killed === false) {
          logStreamWarning(
            this.streamId,
            "Force killing offline stream process"
          );
          process.kill("SIGKILL");
        }
      }, config.process.shutdownTimeout);

      process.on("exit", () => {
        clearTimeout(forceKillTimeout);
        logStreamEvent(this.streamId, "Offline stream stopped");
        resolve();
      });
    });
  }

  /**
   * Stop all FFmpeg processes
   */
  async stopAll(): Promise<void> {
    this.isShuttingDown = true;
    await Promise.all([this.stopLiveStream(), this.stopOfflineStream()]);
  }

  /**
   * Check if any process is running
   */
  isRunning(): boolean {
    return this.liveProcess !== null || this.offlineProcess !== null;
  }

  /**
   * Mask sensitive parts of URLs for logging
   */
  private maskUrl(url: string): string {
    // Mask password in RTSP URLs
    let masked = url.replace(/:([^@:]+)@/, ":****@");

    // Mask stream key in YouTube URLs
    masked = masked.replace(/\/live2\/([^/]+)$/, "/live2/****");

    return masked;
  }
}
