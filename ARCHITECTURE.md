# RTSP to YouTube Stream Relay - Architecture Documentation

## System Overview

This Node.js application relays three RTSP surveillance camera streams to YouTube Live using FFmpeg, with automatic offline detection and failover to a placeholder stream.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Main Server Process                       │
│                          (server.js)                             │
└────────────┬────────────┬────────────┬─────────────────────────┘
             │            │            │
    ┌────────▼───┐ ┌─────▼──────┐ ┌──▼─────────┐
    │ Stream     │ │ Stream     │ │ Stream     │
    │ Manager 1  │ │ Manager 2  │ │ Manager 3  │
    └────────┬───┘ └─────┬──────┘ └──┬─────────┘
             │            │            │
    ┌────────▼────────────▼────────────▼─────────┐
    │         Stream Monitor & Comparator         │
    │         (Frame Capture & Analysis)          │
    └────────┬────────────────────────┬───────────┘
             │                        │
    ┌────────▼────────┐      ┌───────▼──────────┐
    │ FFmpeg Live     │      │ FFmpeg Offline   │
    │ Stream Process  │      │ Placeholder      │
    └────────┬────────┘      └───────┬──────────┘
             │                        │
    ┌────────▼────────────────────────▼───────────┐
    │           YouTube RTMP Endpoints             │
    └──────────────────────────────────────────────┘
```

## Component Details

### 1. Main Server ([`server.js`](server.js))

- Entry point for the application
- Initializes three StreamManager instances (one per camera)
- Handles graceful shutdown (SIGINT, SIGTERM)
- Ensures all child processes are properly terminated

### 2. Configuration ([`config.js`](config.js))

- Stream definitions (RTSP sources and YouTube targets)
- System parameters:
  - Frame check interval: 10 seconds
  - Retry attempts: 5
  - Retry delays: exponential backoff (5s, 10s, 20s, 40s, 80s)
  - Frame comparison threshold: 99.9% similarity
- Logging configuration

### 3. StreamManager ([`src/StreamManager.js`](src/StreamManager.js))

**State Machine:**

- `STARTING`: Initial state, attempting first connection
- `LIVE`: Stream is active and healthy
- `CHECKING`: Performing health check
- `OFFLINE`: Stream detected as offline, showing placeholder
- `RECOVERING`: Attempting to restore live stream
- `STOPPED`: Gracefully shut down

**Responsibilities:**

- Manage FFmpeg process lifecycle
- Coordinate with StreamMonitor for health checks
- Handle state transitions
- Implement retry logic with exponential backoff
- Automatic recovery when stream becomes available

### 4. StreamMonitor ([`src/StreamMonitor.js`](src/StreamMonitor.js))

**Frame Capture:**

- Uses FFmpeg to extract single frames at 10-second intervals
- Captures at reduced resolution (320x240) for efficiency
- Stores frames temporarily for comparison

**Comparison Algorithm:**

1. Capture frame at time T
2. Wait 10 seconds
3. Capture frame at time T+10
4. Perform pixel-by-pixel comparison
5. Calculate similarity percentage
6. If similarity > 99.9% → stream is frozen/offline

**Why This Works:**

- Surveillance cameras have digital clocks that update every second
- Even static scenes will show clock changes
- High similarity threshold (99.9%) indicates frozen stream

### 5. FFmpegManager ([`src/FFmpegManager.js`](src/FFmpegManager.js))

**Live Stream Process:**

```bash
ffmpeg -rtsp_transport tcp \
       -i <rtsp_url> \
       -c:v copy \
       -c:a aac -b:a 128k \
       -f flv <youtube_rtmp_url>
```

- Uses TCP for reliable RTSP transport
- Copies video codec (no re-encoding for efficiency)
- Transcodes audio to AAC for YouTube compatibility

**Offline Placeholder Process:**

```bash
ffmpeg -f lavfi \
       -i color=c=black:s=1920x1080:r=30 \
       -vf "drawtext=text='Stream ist offline':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
       -c:v libx264 -preset veryfast -b:v 2500k \
       -c:a anullsrc \
       -f flv <youtube_rtmp_url>
```

- Generates black background at 1920x1080, 30fps
- Overlays centered white text "Stream ist offline"
- Encodes with H.264 at 2500kbps
- Includes silent audio track

### 6. Logger ([`src/logger.js`](src/logger.js))

**Winston-based logging with:**

- Console transport (colored, human-readable)
- File transport with daily rotation
- Separate error log file
- Log levels: error, warn, info, debug
- Timestamp and metadata support

## Data Flow

### Normal Operation (Stream Online)

1. StreamManager starts FFmpeg live stream process
2. StreamMonitor captures frames every 10 seconds
3. Frames are compared for changes
4. If changes detected → stream is healthy
5. Continue monitoring

### Offline Detection & Recovery

1. StreamMonitor detects frozen frames (>99.9% similarity)
2. StreamManager enters OFFLINE state
3. Retry logic attempts reconnection (5 attempts with backoff)
4. If all retries fail → start offline placeholder FFmpeg
5. Continue monitoring RTSP source in background
6. When stream recovers → automatically switch back to live

### Graceful Shutdown

1. SIGINT/SIGTERM signal received
2. Stop all StreamMonitor intervals
3. Terminate all FFmpeg processes (SIGTERM, then SIGKILL if needed)
4. Close log file handles
5. Exit process

## Memory Management

**Preventing Memory Leaks:**

- All FFmpeg child processes tracked and properly terminated
- Event listeners removed when no longer needed
- Frame buffers cleared after comparison
- Timeouts cleared on state changes
- Intervals cleared on shutdown

**Resource Cleanup:**

- FFmpeg processes killed on errors
- Temporary frame files deleted after use
- Log file rotation prevents disk space issues
- Process monitoring for hung FFmpeg instances

## Error Handling

**RTSP Connection Failures:**

- Retry with exponential backoff
- Log each attempt
- Switch to placeholder after max retries

**FFmpeg Process Crashes:**

- Detect via exit event
- Log error with exit code
- Restart appropriate process based on state

**YouTube Connection Issues:**

- FFmpeg handles reconnection internally
- Monitor process health
- Log warnings for connection problems

**Frame Capture Failures:**

- Log warning but continue monitoring
- Don't trigger false offline detection
- Retry on next interval

## Performance Characteristics

**CPU Usage:**

- Live streaming: ~5-10% per stream (video copy, no re-encoding)
- Offline placeholder: ~15-20% per stream (H.264 encoding)
- Frame capture: Minimal, brief spikes every 10 seconds

**Memory Usage:**

- Base application: ~50-100 MB
- Per FFmpeg process: ~50-150 MB
- Frame buffers: ~1-2 MB per comparison

**Network Bandwidth:**

- Upstream to YouTube: ~2.5-3 Mbps per stream
- RTSP download: ~2-4 Mbps per stream
- Frame capture: Negligible

## Configuration Parameters

| Parameter                | Default | Description                           |
| ------------------------ | ------- | ------------------------------------- |
| Frame check interval     | 10s     | Time between health checks            |
| Comparison threshold     | 99.9%   | Similarity % to trigger offline       |
| Max retry attempts       | 5       | Connection retries before placeholder |
| Initial retry delay      | 5s      | First retry wait time                 |
| Max retry delay          | 80s     | Maximum backoff delay                 |
| Frame capture resolution | 320x240 | Resolution for comparison             |
| Placeholder bitrate      | 2500k   | Video bitrate for offline stream      |
| Audio bitrate            | 128k    | Audio bitrate for live stream         |

## Security Considerations

- RTSP credentials embedded in URLs (consider environment variables)
- YouTube stream keys in configuration (consider secrets management)
- No authentication on the Node.js server itself
- Logs may contain sensitive URLs (ensure proper file permissions)

## Future Enhancements

- HTTP API for status monitoring
- Metrics collection (uptime, offline events)
- Email/SMS notifications for offline events
- Web dashboard for real-time monitoring
- Dynamic stream configuration without restart
- Health check endpoint for external monitoring
