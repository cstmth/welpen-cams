# RTSP to YouTube Stream Relay

Relays RTSP surveillance camera streams to YouTube Live via Docker. Monitors stream health, automatically switches to an offline placeholder when cameras drop, and recovers when they come back. Runs on a Synology DS224+ or any Docker host with an Intel iGPU.

## Features

- **4 individual camera streams** re-encoded with forced 2-second keyframes
- **Combined 2x2 grid stream** (optional)
- **Automatic offline detection** via real-time FFmpeg progress monitoring + frame comparison
- **Offline placeholder** using a custom PNG image
- **Auto-recovery** when cameras come back online
- **Retry with exponential backoff**
- **Intel Quick Sync** hardware encoding support (h264_qsv)
- **Local ingest relay** (MediaMTX) — each camera pulled once, all consumers read from loopback

## Quick Start

```bash
git clone <repo-url> welpen-2
cd welpen-2

cp .env.example .env
nano .env                        # Fill in camera URLs + YouTube stream keys

# Place your offline placeholder image
# assets/offline.png             (required)
# assets/tile.png                (optional, only for <4 cameras in combined)

docker compose up -d --build     # Build image + start
docker compose logs -f           # View logs
```

## Commands

```bash
docker compose up -d --build     # Build + start
docker compose down              # Stop
docker compose restart           # Restart
docker compose logs -f           # Follow logs
docker compose exec welpen-relay bash          # Shell into container
docker compose exec welpen-relay vainfo        # Verify QSV GPU access
```

## Configuration

Everything is configured via `.env`:

### Cameras

Cameras are defined as `CAMERA_<n>_*` numbered contiguously from 1 (`CAMERA_1_*`,
`CAMERA_2_*`, …). There is **no fixed camera count** — add a fifth by setting
`CAMERA_5_*`, a sixth with `CAMERA_6_*`, and so on. `CAMERA_<n>_YOUTUBE` is what
marks a camera as present; discovery stops at the first `n` with no
`CAMERA_<n>_YOUTUBE`.

| Variable | Required | Description |
|---|---|---|
| `CAMERA_<n>_RTSP` | Yes (if enabled) | Base URL without stream path, e.g. `rtsp://user:pass@192.168.1.100:554` |
| `CAMERA_<n>_YOUTUBE` | Yes | YouTube RTMP URL — also marks the camera as present |
| `CAMERA_<n>_ENABLED` | No | `false` streams only the offline placeholder and drops the camera from the grid; RTSP not required. Defaults to `true`. |
| `COMBINED_YOUTUBE` | No | YouTube RTMP URL for the 2x2 grid stream. Remove to disable. |

The combined grid is a fixed 2x2 layout, so it only ever composites the **first
four** cameras. Every configured camera still streams its own individual YouTube
endpoint; cameras 5+ simply don't appear in the overview.

### Encoding

| Variable | Default | Description |
|---|---|---|
| `STREAM_QUALITY` | `sub` | `sub` (~896x512, low bandwidth) or `main` (~2880x1616, needs Ethernet) |
| `VIDEO_ENCODER` | `libx264` | `libx264` (CPU) or `h264_qsv` (Intel Quick Sync hardware encoding) |
| `LOG_LEVEL` | `info` | Console log level. File logs always capture `debug`. |

### Stream Quality

| | `sub` (default) | `main` |
|---|---|---|
| Resolution | ~896x512 | ~2880x1616 |
| Source fps | 10 | 20 |
| WiFi bandwidth / camera | ~0.5 Mbit/s | ~4-8 Mbit/s |
| Individual bitrate | 1,500 kbps | 4,000 kbps |
| Combined output | 1920x1080 @ 10fps, 3 Mbps | 2880x1616 @ 10fps, 6 Mbps |
| CPU load (libx264) | Low | High |

**Use `sub` over WiFi.** `main` requires Ethernet-connected cameras.

### Video Encoder

| Encoder | CPU usage | Notes |
|---|---|---|
| `libx264` | High | Works everywhere |
| `h264_qsv` | Very low | Requires Intel iGPU + `/dev/dri` (DS224+ has this) |

Hardware encoding reduces CPU from ~40% to ~5-10%. The `docker-compose.yml` passes `/dev/dri` through automatically. Verify with `docker compose exec welpen-relay vainfo`.

## How It Works

### Architecture

```
                WiFi (1x per camera)        loopback (local)
Camera 1..4  ────────────────────►  MediaMTX  ──────────────►  FFmpeg encoders
                                                                ├── Camera 1 → YouTube
                                                                ├── Camera 2 → YouTube
                                                                ├── Camera 3 → YouTube
                                                                ├── Camera 4 → YouTube
                                                                └── Combined  → YouTube
```

Each camera is pulled **once** by the bundled MediaMTX relay. All FFmpeg encoders read from loopback — no duplicate WiFi load.

### Health Monitoring

1. **StreamStats** (primary): Parses FFmpeg `-progress` output every 30 seconds. Detects stalls (no frames forwarded) and triggers automatic restart.
2. **StreamMonitor** (secondary): Captures and compares frames every 2 minutes. Catches frozen streams where FFmpeg still forwards identical frames.
3. **Orphaned state check**: Detects when state=LIVE but the FFmpeg process has silently exited.

### Failover

1. Stream fails → retry with exponential backoff (5s, 10s, 20s, 40s, 80s)
2. 5 retries exhausted → switch to offline placeholder PNG
3. Continue monitoring → auto-switch back to live when camera recovers

### RTSP Robustness

- TCP transport with `prefer_tcp`
- `+genpts+discardcorrupt` for broken timestamps/corrupt packets
- `use_wallclock_as_timestamps` for stable timing
- 16 MB receive buffer
- `analyzeduration`/`probesize` 10s for cameras with unusual H264 packetization

### YouTube Compliance

- Forced keyframe every 2 seconds (`force_key_frames`)
- Audio resampled from camera's 16 kHz mono to 44.1 kHz stereo AAC
- Audio nearly silent (`volume=0.001`, -60 dB)
- 5-second reconnect delay to avoid YouTube's duplicate-ingestion error

## Project Structure

```
src/
  server.ts               Entry point, signal handling, lifecycle
  config.ts               All configuration, reads from .env
  types.ts                TypeScript interfaces and enums
  StreamManager.ts        Single-camera stream lifecycle and state machine
  StreamMonitor.ts        Frame capture and comparison for offline detection
  StreamStats.ts          Connection quality diagnostics and stall detection
  CombinedStreamManager.ts  Combined 2x2 grid stream lifecycle
  FFmpegManager.ts        FFmpeg process spawning, shutdown, and cleanup
  logger.ts               Winston logging setup with daily rotation
mediamtx/
  mediamtx.template.yml   MediaMTX config template (no credentials)
  start-with-relay.sh     Starts MediaMTX + Node server together
  render-mediamtx.mjs     Substitutes env vars into the template
assets/
  offline.png             Offline placeholder image (user-provided)
  tile.png                Optional 4th-quadrant image (user-provided)
Dockerfile                Multi-stage build (Node + FFmpeg + QSV + MediaMTX)
docker-compose.yml        One-command deploy with GPU passthrough
.env                      Stream credentials (not committed)
.env.example              Template for .env
```

## Troubleshooting

**Container exits immediately** -- Check `docker compose logs`. Usually a missing `.env` variable.

**RTSP connection refused** -- Verify camera IPs are reachable from the Docker host. Test with `docker compose exec welpen-relay ffmpeg -rtsp_transport tcp -i "rtsp://..." -t 5 -f null -`.

**YouTube not going live** -- Verify stream keys in `.env`. Ensure live streaming is enabled on the YouTube channel.

**Stream frozen / smeary** -- Weak camera WiFi. Check logs for `Connection stalled` or `Connection degraded`. Use `STREAM_QUALITY=sub`. Consider wiring cameras via Ethernet.

**High CPU** -- Set `VIDEO_ENCODER=h264_qsv` for hardware encoding. Verify QSV works: `docker compose exec welpen-relay vainfo`.

**QSV not working** -- Check `/dev/dri` exists on the host (`ls /dev/dri/`). On Synology, the Intel i915 driver must be loaded in the DSM kernel.

**Duplicate ingestion warning on YouTube** -- A previous stream session hasn't expired yet. The server waits 5 seconds before reconnecting; if the warning persists, increase `reconnectDelay` in `src/config.ts`.

## License

ISC
