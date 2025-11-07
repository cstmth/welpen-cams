/**
 * StreamMonitor - Monitors RTSP stream health by capturing and comparing frames
 * Detects frozen/offline streams by comparing frames captured at intervals
 */

import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
  logStreamDebug,
} from "./logger.js";
import config from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const unlinkAsync = promisify(fs.unlink);

export class StreamMonitor {
  private streamId: string;
  private rtspUrl: string;
  private isMonitoring: boolean = false;
  private monitorInterval: NodeJS.Timeout | null = null;
  private previousFrame: Buffer | null = null;
  private consecutiveFailures: number = 0;
  private tempDir: string;

  public onStreamOffline: (() => void) | null = null;
  public onStreamOnline: (() => void) | null = null;

  constructor(streamId: string, rtspUrl: string) {
    this.streamId = streamId;
    this.rtspUrl = rtspUrl;
    this.tempDir = path.join(__dirname, "..", "temp");

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Clean up any leftover temp files from previous runs
    this.cleanupTempFiles().catch((error) => {
      logStreamWarning(
        this.streamId,
        "Failed to cleanup temp files on startup",
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    });
  }

  /**
   * Clean up temporary files for this stream
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.tempDir);
      const streamFiles = files.filter((f) => f.startsWith(this.streamId));

      if (streamFiles.length > 0) {
        logStreamDebug(this.streamId, "Cleaning up temp files", {
          count: streamFiles.length,
        });

        await Promise.all(
          streamFiles.map((f) =>
            unlinkAsync(path.join(this.tempDir, f)).catch(() => {})
          )
        );
      }
    } catch (error) {
      // Ignore cleanup errors - directory might not exist yet
    }
  }

  /**
   * Start monitoring the stream
   */
  start(): void {
    if (this.isMonitoring) {
      logStreamWarning(this.streamId, "Monitor already running");
      return;
    }

    this.isMonitoring = true;
    this.consecutiveFailures = 0;
    logStreamEvent(this.streamId, "Stream monitor started", {
      checkInterval: config.monitoring.checkInterval,
    });

    // Start monitoring loop
    this.scheduleNextCheck();
  }

  /**
   * Stop monitoring the stream
   */
  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.monitorInterval) {
      clearTimeout(this.monitorInterval);
      this.monitorInterval = null;
    }

    // Clean up previous frame
    if (this.previousFrame) {
      this.previousFrame = null;
    }

    logStreamEvent(this.streamId, "Stream monitor stopped");
  }

  /**
   * Schedule the next health check
   */
  private scheduleNextCheck(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.monitorInterval = setTimeout(async () => {
      await this.performHealthCheck();
      this.scheduleNextCheck();
    }, config.monitoring.checkInterval);
  }

  /**
   * Perform a health check by capturing and comparing frames
   */
  private async performHealthCheck(): Promise<void> {
    try {
      logStreamDebug(this.streamId, "Performing health check");

      // Capture current frame
      const currentFrame = await this.captureFrame();

      if (!currentFrame) {
        logStreamWarning(this.streamId, "Failed to capture frame");
        this.handleCheckFailure();
        return;
      }

      // If this is the first frame, store it and continue
      if (!this.previousFrame) {
        this.previousFrame = currentFrame;
        logStreamDebug(this.streamId, "First frame captured, baseline set");
        return;
      }

      // Compare frames
      const similarity = await this.compareFrames(
        this.previousFrame,
        currentFrame
      );

      logStreamDebug(this.streamId, "Frame comparison complete", {
        similarity: similarity.toFixed(4),
        threshold: config.monitoring.similarityThreshold,
      });

      // Check if frames are too similar (stream is frozen)
      if (similarity >= config.monitoring.similarityThreshold) {
        this.handleCheckFailure();
      } else {
        this.handleCheckSuccess();
      }

      // Update previous frame
      this.previousFrame = currentFrame;
    } catch (error) {
      logStreamError(this.streamId, error as Error, {
        context: "Health check error",
      });
      this.handleCheckFailure();
    }
  }

  /**
   * Capture a single frame from the RTSP stream
   */
  private captureFrame(): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const outputPath = path.join(
        this.tempDir,
        `${this.streamId}-${Date.now()}.jpg`
      );

      let captureTimeout: NodeJS.Timeout | null = null;
      let isResolved = false;

      // Wrapper to ensure we only resolve once and cleanup timeout
      const resolveOnce = (result: Buffer | null) => {
        if (isResolved) return;
        isResolved = true;
        if (captureTimeout) {
          clearTimeout(captureTimeout);
          captureTimeout = null;
        }
        resolve(result);
      };

      const command = ffmpeg(this.rtspUrl)
        .inputOptions(["-rtsp_transport tcp", "-timeout 5000000"])
        .outputOptions([
          "-vframes 1",
          `-s ${config.monitoring.captureWidth}x${config.monitoring.captureHeight}`,
          "-f image2",
        ])
        .output(outputPath)
        .on("end", async () => {
          if (captureTimeout) {
            clearTimeout(captureTimeout);
            captureTimeout = null;
          }
          try {
            // Read the captured frame
            const frameBuffer = await fs.promises.readFile(outputPath);

            // Clean up the temporary file
            await unlinkAsync(outputPath).catch(() => {});

            resolveOnce(frameBuffer);
          } catch (error) {
            logStreamError(this.streamId, error as Error, {
              context: "Error reading captured frame",
            });
            resolveOnce(null);
          }
        })
        .on("error", (error: Error) => {
          if (captureTimeout) {
            clearTimeout(captureTimeout);
            captureTimeout = null;
          }
          logStreamDebug(this.streamId, "Frame capture failed", {
            error: error.message,
          });

          // Clean up on error
          unlinkAsync(outputPath).catch(() => {});
          resolveOnce(null);
        });

      // Set a timeout for the capture
      captureTimeout = setTimeout(() => {
        captureTimeout = null;
        command.kill("SIGKILL");
        unlinkAsync(outputPath).catch(() => {});
        resolveOnce(null);
      }, 10000); // 10 second timeout

      command.run();
    });
  }

  /**
   * Compare two frames and return similarity score (0-1)
   */
  private async compareFrames(frame1: Buffer, frame2: Buffer): Promise<number> {
    try {
      // Convert both frames to raw pixel data
      const [pixels1, pixels2] = await Promise.all([
        sharp(frame1).raw().toBuffer({ resolveWithObject: true }),
        sharp(frame2).raw().toBuffer({ resolveWithObject: true }),
      ]);

      // Ensure frames have the same dimensions
      if (
        pixels1.info.width !== pixels2.info.width ||
        pixels1.info.height !== pixels2.info.height
      ) {
        logStreamWarning(this.streamId, "Frame dimension mismatch");
        return 0;
      }

      // Calculate pixel-by-pixel difference
      const data1 = pixels1.data;
      const data2 = pixels2.data;
      const totalPixels = data1.length;
      let matchingPixels = 0;

      // Compare pixels with a small tolerance for compression artifacts
      const tolerance = 5; // Allow 5 units of difference per channel

      for (let i = 0; i < totalPixels; i++) {
        if (Math.abs(data1[i] - data2[i]) <= tolerance) {
          matchingPixels++;
        }
      }

      const similarity = matchingPixels / totalPixels;
      return similarity;
    } catch (error) {
      logStreamError(this.streamId, error as Error, {
        context: "Frame comparison error",
      });
      return 0;
    }
  }

  /**
   * Handle successful health check
   */
  private handleCheckSuccess(): void {
    if (this.consecutiveFailures > 0) {
      logStreamEvent(this.streamId, "Stream recovered", {
        previousFailures: this.consecutiveFailures,
      });

      if (this.onStreamOnline) {
        this.onStreamOnline();
      }
    }

    this.consecutiveFailures = 0;
  }

  /**
   * Handle failed health check
   */
  private handleCheckFailure(): void {
    this.consecutiveFailures++;

    logStreamWarning(this.streamId, "Health check failed", {
      consecutiveFailures: this.consecutiveFailures,
      threshold: config.monitoring.consecutiveFailures,
    });

    // Trigger offline callback if threshold reached
    if (this.consecutiveFailures >= config.monitoring.consecutiveFailures) {
      if (this.onStreamOffline) {
        this.onStreamOffline();
      }
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    this.stop();

    // Clean up temp directory
    try {
      const files = await fs.promises.readdir(this.tempDir);
      const streamFiles = files.filter((f) => f.startsWith(this.streamId));

      await Promise.all(
        streamFiles.map((f) =>
          unlinkAsync(path.join(this.tempDir, f)).catch(() => {})
        )
      );
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}
