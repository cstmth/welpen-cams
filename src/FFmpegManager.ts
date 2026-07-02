import { spawn, ChildProcess } from "child_process";
import {
  logStreamEvent,
  logStreamWarning,
  logStreamError,
  logStreamDebug,
} from "./logger.js";
import config from "./config.js";
import { StreamStats } from "./StreamStats.js";
import type { CombinedStreamConfig } from "./types.js";

export class FFmpegManager {
  private streamId: string;
  private liveProcess: ChildProcess | null = null;
  private offlineProcess: ChildProcess | null = null;
  private isShuttingDown: boolean = false;

  // Invoked when the running live/combined process stalls (frames stop
  // flowing). The owning manager wires this to a restart.
  public onLiveStall: (() => void) | null = null;

  // Invoked when freezedetect confirms a visually frozen picture (see
  // freezeDetectMap in spawnLiveProcess for how cameraId is resolved for the
  // combined stream's per-tile filters). The owning manager wires this to a
  // restart.
  public onFreezeDetected: ((cameraId: string) => void) | null = null;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

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

      const { live } = config.ffmpeg;
      const { freezeDetectEnabled, freezeDetectDuration } = config.diagnostics;
      const args = [
        ...live.inputOptions,
        "-i",
        rtspUrl,
        ...(freezeDetectEnabled
          ? ["-vf", `freezedetect=d=${freezeDetectDuration}`]
          : []),
        ...live.outputOptions,
        youtubeUrl,
      ];

      // A bare "-vf freezedetect=..." with no other filters is always the
      // sole (and therefore index-0) filter in FFmpeg's graph.
      const freezeDetectMap = freezeDetectEnabled
        ? new Map([[0, this.streamId]])
        : undefined;

      this.spawnLiveProcess(args, resolve, reject, freezeDetectMap);
    });
  }

  startCombinedStream(
    inputs: { id: string; url: string; isOffline: boolean }[],
    imagePath: string | undefined,
    youtubeUrl: string,
    streamConfig: CombinedStreamConfig
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.liveProcess) {
        logStreamWarning(this.streamId, "Live stream already running");
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Starting combined stream", {
        youtube: this.maskUrl(youtubeUrl),
        cameras: inputs.length,
      });

      const { tileWidth, tileHeight, framerate, inputOptions, outputOptions } =
        streamConfig;
      const args: string[] = [];

      for (const input of inputs) {
        if (input.isOffline) {
          args.push(
            "-f", "lavfi",
            "-i", `color=c=black:s=${tileWidth}x${tileHeight}:r=${framerate}`
          );
        } else {
          args.push(...inputOptions, "-i", input.url);
        }
      }

      const useImage = imagePath && inputs.length < 4;
      if (useImage) {
        args.push("-loop", "1", "-i", imagePath);
      }

      const totalVideoInputs = useImage
        ? inputs.length + 1
        : inputs.length;

      args.push(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100"
      );

      // Normalize each input to a constant fps first, so the 4 tiles stay frame
      // synchronized for hstack/vstack (independent live inputs otherwise drift
      // and cause drop/duplicate churn in the composite).
      // We use RTCTIME - RTCSTART to assign wallclock timestamps, which instantly
      // fast-forwards and drops any backlog built up during FFmpeg's sequential input startup.
      //
      // Optionally appends freezedetect per input so a camera whose tile stays
      // visually static (source stuck, or duplicate-frame churn from the fps
      // normalization above) gets caught even though the shared process's
      // overall frame count keeps advancing normally. FFmpeg numbers each
      // freezedetect instance by its position among *all* filters in the graph,
      // in declaration order (verified against a real FFmpeg run) - an internal,
      // undocumented numbering convention, not a stable part of FFmpeg's CLI
      // contract. filterIndex is derived from each chain's actual stage array
      // below (stages.length), not a hand-counted literal, so editing a filter
      // chain can't silently desync the count; the one dependency we can't
      // remove this way is FFmpeg's own numbering scheme staying consistent
      // across versions/builds (see the stderr parsing in spawnLiveProcess).
      const { freezeDetectEnabled, freezeDetectDuration } = config.diagnostics;
      const freezeIndexToCamera = new Map<number, string>();
      let filterIndex = 0;
      const freezeStage = (cameraId: string | undefined): string => {
        if (!freezeDetectEnabled || !cameraId) return "";
        freezeIndexToCamera.set(filterIndex, cameraId);
        filterIndex += 1;
        return `,freezedetect=d=${freezeDetectDuration}`;
      };

      const scaleFilter = (i: number) => {
        const stages = [
          `setpts='(RTCTIME - RTCSTART) / (TB * 1000000)'`,
          `fps=${framerate}`,
          `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease`,
          `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2`,
          `setsar=1`,
        ];
        filterIndex += stages.length;
        const freeze = freezeStage(inputs[i]?.id);
        return `[${i}:v]${stages.join(",")}${freeze}[v${i}]`;
      };

      const filterParts = [];

      if (totalVideoInputs === 1) {
        const stages = [
          `fps=${framerate}`,
          `scale=${tileWidth * 2}:${tileHeight * 2}:force_original_aspect_ratio=decrease`,
          `pad=${tileWidth * 2}:${tileHeight * 2}:(ow-iw)/2:(oh-ih)/2`,
          `setsar=1`,
        ];
        filterIndex += stages.length;
        const freeze = freezeStage(inputs[0]?.id);
        filterParts.push(`[0:v]${stages.join(",")}${freeze}[out]`);
      } else if (totalVideoInputs === 2) {
        filterParts.push(scaleFilter(0), scaleFilter(1));
        filterParts.push(`[v0][v1]hstack=inputs=2[row]`);
        filterParts.push(`[row]pad=${tileWidth * 2}:${tileHeight * 2}:0:(oh-ih)/2[out]`);
      } else if (totalVideoInputs === 3) {
        filterParts.push(scaleFilter(0), scaleFilter(1), scaleFilter(2));
        filterParts.push(`color=c=black:s=${tileWidth}x${tileHeight}:r=${framerate}[v3]`);
        filterParts.push(
          "[v0][v1]hstack=inputs=2[top]",
          "[v2][v3]hstack=inputs=2[bottom]",
          "[top][bottom]vstack=inputs=2[out]"
        );
      } else if (totalVideoInputs >= 4) {
        for (let i = 0; i < 4; i++) {
          filterParts.push(scaleFilter(i));
        }
        filterParts.push(
          "[v0][v1]hstack=inputs=2[top]",
          "[v2][v3]hstack=inputs=2[bottom]",
          "[top][bottom]vstack=inputs=2[out]"
        );
      }

      const audioIndex = totalVideoInputs;
      args.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[out]",
        "-map",
        `${audioIndex}:a`,
        ...outputOptions,
        youtubeUrl
      );

      this.spawnLiveProcess(
        args,
        resolve,
        reject,
        freezeIndexToCamera.size > 0 ? freezeIndexToCamera : undefined
      );
    });
  }

  private spawnLiveProcess(
    args: string[],
    resolve: () => void,
    reject: (error: Error) => void,
    freezeDetectMap?: Map<number, string>
  ): void {
    const diag = config.diagnostics;
    const prefixArgs = ["-hide_banner"];
    let stats: StreamStats | null = null;
    if (diag.statsEnabled) {
      prefixArgs.push(
        "-nostats",
        "-stats_period",
        String(diag.statsPeriod),
        "-progress",
        "pipe:1"
      );
      const onStall = diag.restartOnStall
        ? () => this.onLiveStall?.()
        : undefined;
      stats = new StreamStats(this.streamId, diag.reportInterval, onStall);
      stats.start();
    }

    this.liveProcess = spawn("ffmpeg", [...prefixArgs, ...args]);

    let hasStarted = false;
    let settled = false;
    let startupTimeout: NodeJS.Timeout | null = null;
    let lastStderrOutput = "";
    let freezeStderrBuffer = "";

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      hasStarted = true;
      if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
      resolve();
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
      reject(error);
    };

    this.liveProcess.stdout?.on("data", (data: Buffer) => {
      if (stats) {
        stats.ingestProgress(data.toString());
      } else {
        logStreamDebug(
          this.streamId,
          `FFmpeg stdout: ${this.redactOutput(data.toString().trim())}`
        );
      }
    });

    this.liveProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      lastStderrOutput = output;
      stats?.ingestStderr(output);

      if (freezeDetectMap) {
        // stderr "data" chunks don't respect line boundaries, so a single log
        // line (and thus the regex below) can be split across two events -
        // buffer and only match complete lines, same as ingestProgress does
        // for stdout.
        freezeStderrBuffer += output;
        const lines = freezeStderrBuffer.split("\n");
        freezeStderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = line.match(
            /Parsed_freezedetect_(\d+)[^\]]*\]\s*lavfi\.freezedetect\.freeze_start/
          );
          const cameraId = match && freezeDetectMap.get(Number(match[1]));
          if (cameraId) {
            logStreamWarning(this.streamId, "Freeze detected", { cameraId });
            this.onFreezeDetected?.(cameraId);
          }
        }
      }

      if (!hasStarted) {
        logStreamDebug(
          this.streamId,
          `FFmpeg stderr during startup: ${this.redactOutput(output.trim())}`
        );
      }

      if (
        !hasStarted &&
        (output.includes("Stream mapping:") || output.includes("frame="))
      ) {
        logStreamEvent(this.streamId, "Live stream started successfully");
        settleResolve();
      }

      if (output.includes("error") || output.includes("Error")) {
        logStreamWarning(
          this.streamId,
          `FFmpeg: ${this.redactOutput(output.trim())}`
        );
      }
    });

    this.liveProcess.on("error", (error: Error) => {
      logStreamError(this.streamId, error, {
        context: "Live stream process error",
      });
      stats?.stop();
      settleReject(error);
    });

    this.liveProcess.on(
      "exit",
      (code: number | null, signal: string | null) => {
        logStreamEvent(this.streamId, "Live stream process exited", {
          code,
          signal,
          hasStarted,
          isShuttingDown: this.isShuttingDown,
          lastStderr: this.redactOutput(lastStderrOutput.trim().slice(-500)),
        });

        stats?.stop();
        this.liveProcess = null;
        settleReject(new Error(`FFmpeg exited with code ${code}`));
      }
    );

    startupTimeout = setTimeout(() => {
      startupTimeout = null;
      logStreamWarning(this.streamId, "Live stream startup timeout");
      this.stopLiveStream();
      settleReject(new Error("Stream startup timeout"));
    }, 30000);
  }

  stopLiveStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.liveProcess) {
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Stopping live stream");

      const proc = this.liveProcess;
      this.liveProcess = null;

      if (proc.exitCode !== null) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceKillTimeout);
        resolve();
      };

      proc.kill("SIGTERM");

      const forceKillTimeout = setTimeout(() => {
        logStreamWarning(this.streamId, "Force killing live stream process");
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        done();
      }, config.process.shutdownTimeout);

      proc.once("exit", () => {
        logStreamEvent(this.streamId, "Live stream stopped");
        done();
      });
    });
  }

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

      const args = [
        ...offline.inputOptions,
        "-framerate",
        String(offline.framerate),
        "-i",
        offline.imagePath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        ...offline.outputOptions,
        youtubeUrl,
      ];

      this.offlineProcess = spawn("ffmpeg", ["-hide_banner", ...args]);

      let hasStarted = false;
      let settled = false;
      let startupTimeout: NodeJS.Timeout | null = null;

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        hasStarted = true;
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = null;
        }
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = null;
        }
        reject(error);
      };

      this.offlineProcess.stdout?.on("data", (data: Buffer) => {
        logStreamDebug(
          this.streamId,
          `FFmpeg offline stdout: ${this.redactOutput(data.toString().trim())}`
        );
      });

      this.offlineProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();

        if (
          !hasStarted &&
          (output.includes("Stream mapping:") || output.includes("frame="))
        ) {
          logStreamEvent(
            this.streamId,
            "Offline placeholder started successfully"
          );
          settleResolve();
        }

        if (output.includes("error") || output.includes("Error")) {
          logStreamWarning(
            this.streamId,
            `FFmpeg offline: ${this.redactOutput(output.trim())}`
          );
        }
      });

      this.offlineProcess.on("error", (error: Error) => {
        logStreamError(this.streamId, error, {
          context: "Offline stream process error",
        });
        settleReject(error);
      });

      this.offlineProcess.on(
        "exit",
        (code: number | null, signal: string | null) => {
          logStreamEvent(this.streamId, "Offline stream process exited", {
            code,
            signal,
          });

          this.offlineProcess = null;
          settleReject(new Error(`FFmpeg offline exited with code ${code}`));
        }
      );

      startupTimeout = setTimeout(() => {
        startupTimeout = null;
        logStreamWarning(this.streamId, "Offline stream startup timeout");
        this.stopOfflineStream();
        settleReject(new Error("Offline stream startup timeout"));
      }, 30000);
    });
  }

  stopOfflineStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.offlineProcess) {
        resolve();
        return;
      }

      logStreamEvent(this.streamId, "Stopping offline placeholder stream");

      const proc = this.offlineProcess;
      this.offlineProcess = null;

      if (proc.exitCode !== null) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceKillTimeout);
        resolve();
      };

      proc.kill("SIGTERM");

      const forceKillTimeout = setTimeout(() => {
        logStreamWarning(
          this.streamId,
          "Force killing offline stream process"
        );
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        done();
      }, config.process.shutdownTimeout);

      proc.once("exit", () => {
        logStreamEvent(this.streamId, "Offline stream stopped");
        done();
      });
    });
  }

  async stopAll(): Promise<void> {
    this.isShuttingDown = true;
    await Promise.all([this.stopLiveStream(), this.stopOfflineStream()]);
    this.isShuttingDown = false;
  }

  isRunning(): boolean {
    return this.liveProcess !== null || this.offlineProcess !== null;
  }

  private redactOutput(output: string): string {
    return output
      .replace(/rtsp:\/\/[^\s@]*@/g, "rtsp://****:****@")
      .replace(/\/live2\/[^\s"')]+/g, "/live2/****");
  }

  private maskUrl(url: string): string {
    let masked = url.replace(/:([^@:]+)@/, ":****@");
    masked = masked.replace(/\/live2\/([^/]+)$/, "/live2/****");
    return masked;
  }
}
