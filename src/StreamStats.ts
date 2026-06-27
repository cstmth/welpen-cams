/**
 * StreamStats - Connection quality and throughput diagnostics for a single
 * FFmpeg process. Parses FFmpeg's machine-readable `-progress` output (frames,
 * dropped/duplicated frames, speed, bitrate) and counts known error patterns in
 * stderr (decode errors, RTP issues, buffer overruns) to surface a degraded
 * camera/WiFi connection.
 */

import { logStreamEvent, logStreamWarning } from "./logger.js";

interface ProgressState {
  frame: number;
  fps: number;
  bitrate: string;
  speed: number;
  dropFrames: number;
  dupFrames: number;
  outTimeUs: number;
}

// stderr patterns that indicate a degraded source connection. Global+case
// insensitive so we can count occurrences per chunk.
const STDERR_PATTERNS: { label: string; re: RegExp }[] = [
  {
    label: "decodeErrors",
    re: /error while decoding|concealing|corrupt|invalid nal|no frame!|decode_slice_header|illegal|missing picture/gi,
  },
  {
    label: "rtpPacketIssues",
    re: /missed \d+ packets|rtp: |max delay reached|jitter buffer|rtp timestamp/gi,
  },
  {
    label: "timestampIssues",
    re: /non-monoton|invalid timestamp|past duration|dts .* < .* pts|out of order/gi,
  },
  {
    label: "bufferIssues",
    re: /buffer overrun|rtbufsize|circular buffer|packet too large|underflow|overflow/gi,
  },
];

function emptyState(): ProgressState {
  return {
    frame: 0,
    fps: 0,
    bitrate: "N/A",
    speed: 0,
    dropFrames: 0,
    dupFrames: 0,
    outTimeUs: 0,
  };
}

export class StreamStats {
  private streamId: string;
  private reportIntervalMs: number;

  private current: ProgressState = emptyState();
  private lastReported: ProgressState = emptyState();

  private intervalErrors: Record<string, number> = {};
  private totalErrors: Record<string, number> = {};

  private stdoutBuffer = "";
  private reportTimer: NodeJS.Timeout | null = null;
  private lastReportTs = Date.now();
  private stopped = false;

  // Invoked once when a stall is first detected (no frames forwarded in a
  // report window), so the owner can restart the stalled stream.
  private onStall?: () => void;
  private stallSignalled = false;

  constructor(
    streamId: string,
    reportIntervalSeconds: number,
    onStall?: () => void
  ) {
    this.streamId = streamId;
    this.reportIntervalMs = reportIntervalSeconds * 1000;
    this.onStall = onStall;
  }

  start(): void {
    this.lastReportTs = Date.now();
    this.reportTimer = setInterval(() => this.report(), this.reportIntervalMs);
  }

  /** Feed a chunk of FFmpeg stdout (`-progress pipe:1` key=value lines). */
  ingestProgress(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();

      switch (key) {
        case "frame":
          this.current.frame = parseInt(value, 10) || this.current.frame;
          break;
        case "fps":
          this.current.fps = parseFloat(value) || 0;
          break;
        case "bitrate":
          this.current.bitrate = value;
          break;
        case "drop_frames":
          this.current.dropFrames = parseInt(value, 10) || 0;
          break;
        case "dup_frames":
          this.current.dupFrames = parseInt(value, 10) || 0;
          break;
        case "speed":
          this.current.speed = parseFloat(value) || this.current.speed;
          break;
        case "out_time_us":
          this.current.outTimeUs = parseInt(value, 10) || 0;
          break;
      }
    }
  }

  /** Feed a chunk of FFmpeg stderr and count known error patterns. */
  ingestStderr(output: string): void {
    for (const { label, re } of STDERR_PATTERNS) {
      const matches = output.match(re);
      if (matches && matches.length > 0) {
        this.intervalErrors[label] =
          (this.intervalErrors[label] ?? 0) + matches.length;
        this.totalErrors[label] =
          (this.totalErrors[label] ?? 0) + matches.length;
      }
    }
  }

  private report(): void {
    const now = Date.now();
    const windowSec = Math.max(1, Math.round((now - this.lastReportTs) / 1000));

    const framesDelta = this.current.frame - this.lastReported.frame;
    const dropDelta = this.current.dropFrames - this.lastReported.dropFrames;
    const dupDelta = this.current.dupFrames - this.lastReported.dupFrames;
    const errors = this.intervalErrors;
    const hasErrors = Object.keys(errors).length > 0;

    const details: Record<string, unknown> = {
      windowSec,
      framesProcessed: framesDelta,
      effectiveFps: +(framesDelta / windowSec).toFixed(1),
      speed: this.current.speed,
      bitrate: this.current.bitrate,
      droppedInWindow: dropDelta,
      duplicatedInWindow: dupDelta,
      droppedTotal: this.current.dropFrames,
    };
    if (hasErrors) details.errors = { ...errors };

    if (framesDelta <= 0) {
      logStreamWarning(
        this.streamId,
        "Connection stalled - no frames forwarded in window (camera or WiFi dropout)",
        details
      );
      if (this.onStall && !this.stallSignalled) {
        this.stallSignalled = true;
        this.onStall();
      }
    } else if (this.current.speed > 0 && this.current.speed < 0.95) {
      logStreamWarning(
        this.streamId,
        "Stream falling behind real-time - insufficient bandwidth for source bitrate",
        details
      );
    } else if (hasErrors) {
      logStreamWarning(
        this.streamId,
        "Connection degraded - decode/RTP errors detected",
        details
      );
    } else if (
      framesDelta > 0 &&
      dropDelta / framesDelta > 0.05
    ) {
      // Only warn when >5% of frames are dropped — a few drops per window is
      // normal with re-encoding, and duplicated frames are expected when the
      // output fps exceeds the source fps (e.g. combined 25fps from 10fps inputs).
      logStreamWarning(
        this.streamId,
        "Connection degraded - significant frame drops detected",
        details
      );
    } else {
      logStreamEvent(this.streamId, "Connection healthy", details);
    }

    this.lastReported = { ...this.current };
    this.intervalErrors = {};
    this.lastReportTs = now;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    if (
      this.current.frame > 0 ||
      Object.keys(this.totalErrors).length > 0
    ) {
      logStreamEvent(this.streamId, "Connection stats summary", {
        totalFrames: this.current.frame,
        totalDropped: this.current.dropFrames,
        totalDuplicated: this.current.dupFrames,
        errors: this.totalErrors,
      });
    }
  }
}
