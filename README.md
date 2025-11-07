# RTSP to YouTube Stream Relay

A robust TypeScript Node.js server that relays RTSP surveillance camera streams to YouTube Live with automatic offline detection and failover to placeholder streams.

## Features

- **Multi-Stream Support**: Simultaneously relay three RTSP camera streams to YouTube
- **Automatic Offline Detection**: Monitors stream health by comparing frames every 10 seconds
- **Smart Failover**: Automatically switches to "Stream ist offline" placeholder when cameras go offline
- **Automatic Recovery**: Seamlessly switches back to live stream when cameras come back online
- **Retry Logic**: Exponential backoff retry mechanism for connection failures
- **Memory Safe**: Proper FFmpeg process management prevents memory leaks
- **Comprehensive Logging**: Console and file logging with daily rotation
- **Graceful Shutdown**: Properly terminates all processes on exit

## How It Works

1. **Live Streaming**: FFmpeg relays RTSP streams directly to YouTube (video copy, no re-encoding)
2. **Health Monitoring**: Captures frames every 10 seconds and compares them
3. **Offline Detection**: If frames are >99.9% similar (frozen stream), triggers offline state
4. **Retry Mechanism**: Attempts to reconnect 5 times with exponential backoff (5s, 10s, 20s, 40s, 80s)
5. **Placeholder Stream**: If retries fail, switches to generated "Stream ist offline" video
6. **Auto Recovery**: Continues monitoring and automatically switches back when stream recovers

## Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **TypeScript**: Installed automatically with dependencies
- **FFmpeg**: Must be installed and available in system PATH
  - Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html)

## Installation

1. Clone or download this repository

2. Install dependencies:

```bash
npm install
```

3. Configure your streams in [`config.js`](config.js):

```javascript
streams: [
  {
    id: "camera-1",
    name: "Camera 1",
    rtsp: "rtsp://username:password@192.168.1.100:554/stream",
    youtube: "rtmp://a.rtmp.youtube.com/live2/your-stream-key",
  },
  // Add more streams...
];
```

## Configuration

All configuration is in [`src/config.ts`](src/config.ts):

### Stream Settings

- `streams`: Array of stream configurations (RTSP source and YouTube destination)

### Monitoring Settings

- `checkInterval`: Time between health checks (default: 10000ms)
- `similarityThreshold`: Frame similarity to trigger offline (default: 0.999 = 99.9%)
- `captureWidth/Height`: Resolution for frame comparison (default: 320x240)

### Retry Settings

- `maxAttempts`: Maximum retry attempts before placeholder (default: 5)
- `initialDelay`: First retry delay (default: 5000ms)
- `maxDelay`: Maximum backoff delay (default: 80000ms)
- `backoffMultiplier`: Exponential backoff multiplier (default: 2)

### FFmpeg Settings

- **Live Stream**: Video copy (no re-encoding), AAC audio at 128k
- **Offline Placeholder**: 1920x1080 @ 30fps, H.264 at 2500k

### Logging Settings

- `level`: Log level (error, warn, info, debug)
- `console`: Console logging with colors
- `file`: Daily rotating file logs (14 days combined, 30 days errors)

## Usage

### Start the Server

```bash
npm start
```

Or for development:

```bash
node server.js
```

### Stop the Server

Press `Ctrl+C` or send SIGTERM signal. The server will gracefully shut down all streams.

### Monitor Logs

Logs are written to:

- **Console**: Real-time colored output
- **Files**: `./logs/` directory
  - `combined-YYYY-MM-DD.log`: All log levels
  - `error-YYYY-MM-DD.log`: Errors only

## Project Structure

```
welpen-cams-2/
├── src/
│   ├── server.ts             # Main entry point
│   ├── config.ts             # Configuration
│   ├── types.ts              # TypeScript type definitions
│   ├── StreamManager.ts      # Stream lifecycle management
│   ├── StreamMonitor.ts      # Health monitoring & frame comparison
│   ├── FFmpegManager.ts      # FFmpeg process management
│   └── logger.ts             # Winston logging setup
├── dist/                     # Compiled JavaScript (auto-generated)
├── logs/                     # Log files (auto-created)
├── temp/                     # Temporary frame captures (auto-created)
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── ARCHITECTURE.md           # Detailed architecture documentation
└── README.md                 # This file
```

## Architecture

The system uses a modular TypeScript architecture with clear separation of concerns:

- **StreamManager**: Manages stream lifecycle and state transitions
- **StreamMonitor**: Captures and compares frames for health checks
- **FFmpegManager**: Handles FFmpeg process creation and termination
- **Logger**: Centralized logging with Winston
- **Types**: Comprehensive TypeScript type definitions for type safety

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for detailed documentation.

## Troubleshooting

### FFmpeg Not Found

```
Error: spawn ffmpeg ENOENT
```

**Solution**: Install FFmpeg and ensure it's in your system PATH.

### RTSP Connection Failed

```
Failed to start live stream: Connection refused
```

**Solutions**:

- Verify RTSP URL is correct
- Check camera is online and accessible
- Verify username/password
- Check firewall settings

### YouTube Connection Issues

```
FFmpeg: Connection to tcp://a.rtmp.youtube.com:1935 failed
```

**Solutions**:

- Verify YouTube stream key is correct
- Check YouTube Live is enabled on your account
- Ensure stream is scheduled/active in YouTube Studio
- Check internet connection and firewall

### High CPU Usage

**Causes**:

- Multiple streams encoding simultaneously
- High resolution offline placeholders

**Solutions**:

- Use video copy for live streams (already default)
- Reduce offline placeholder resolution in config
- Use faster FFmpeg preset (already using 'veryfast')

### Memory Leaks

The system is designed to prevent memory leaks:

- All FFmpeg processes are properly terminated
- Event listeners are cleaned up
- Frame buffers are released after comparison
- Temporary files are deleted

If you suspect a memory leak:

1. Check logs for unclosed processes
2. Monitor with `htop` or Task Manager
3. Restart the server if necessary

## Performance

**Typical Resource Usage** (per stream):

- **CPU**: 5-10% (live streaming), 15-20% (offline placeholder)
- **Memory**: 50-150 MB per FFmpeg process
- **Network**: 2.5-3 Mbps upload to YouTube

**Scaling**:

- Tested with 3 simultaneous streams
- Can handle more streams with adequate hardware
- Each stream runs independently

## Security Considerations

⚠️ **Important**: The configuration file contains sensitive information:

- RTSP credentials (username/password)
- YouTube stream keys

**Recommendations**:

1. Use environment variables for credentials
2. Restrict file permissions: `chmod 600 config.js`
3. Don't commit `config.js` to public repositories
4. Use `.gitignore` to exclude sensitive files

## License

ISC

## Support

For issues or questions:

1. Check the logs in `./logs/` directory
2. Review [`ARCHITECTURE.md`](ARCHITECTURE.md) for system details
3. Verify FFmpeg is working: `ffmpeg -version`
4. Test RTSP streams: `ffplay rtsp://your-camera-url`

## Changelog

### Version 1.0.0

- Initial release
- Multi-stream RTSP to YouTube relay
- Automatic offline detection and failover
- Retry logic with exponential backoff
- Automatic recovery
- Comprehensive logging
- Graceful shutdown handling
