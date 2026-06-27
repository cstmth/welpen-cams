# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY tsconfig.json ./
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Enable non-free repos for Intel media driver, then install FFmpeg + QSV deps.
RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' \
      /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      intel-media-va-driver-non-free \
      libmfx1 \
      mesa-va-drivers \
      vainfo \
      bash \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# MediaMTX — download the latest release for the container arch.
ARG MEDIAMTX_VERSION=1.12.2
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  MTXARCH="amd64" ;; \
      aarch64) MTXARCH="arm64v8" ;; \
      armv7l)  MTXARCH="armv7" ;; \
      *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${MTXARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin mediamtx && \
    chmod +x /usr/local/bin/mediamtx

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled JS from build stage
COPY --from=build /app/dist/ dist/

# MediaMTX config + start script
COPY mediamtx/ mediamtx/

# Assets (offline placeholder, tile image)
COPY assets/ assets/

# Ensure start script is executable
RUN chmod +x mediamtx/start-with-relay.sh

# Health check: the server logs "All streams initialized" on successful start.
# If all FFmpeg processes die, the stall detector restarts them, so a simple
# process check is sufficient.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD pgrep -f "node dist/server.js" > /dev/null || exit 1

# Default: start MediaMTX relay + Node server together.
# Override VIDEO_ENCODER=h264_qsv in your .env / docker-compose for HW accel.
CMD ["./mediamtx/start-with-relay.sh"]
