/**
 * RTSP to YouTube Stream Relay Server
 * Main entry point - manages multiple stream instances with automatic failover
 */

import { StreamManager } from "./StreamManager.js";
import logger from "./logger.js";
import config from "./config.js";

// Store stream managers
const streamManagers: StreamManager[] = [];

// Track shutdown state
let isShuttingDown = false;

// Store status interval for cleanup
let statusInterval: NodeJS.Timeout | null = null;

/**
 * Initialize and start all streams
 */
async function startServer(): Promise<void> {
  logger.info("=".repeat(60));
  logger.info("RTSP to YouTube Stream Relay Server");
  logger.info("=".repeat(60));

  logger.info("Initializing stream managers", {
    streamCount: config.streams.length,
  });

  // Create stream managers for each configured stream
  for (const streamConfig of config.streams) {
    const manager = new StreamManager(streamConfig);
    streamManagers.push(manager);

    logger.info(`Initialized stream manager: ${streamConfig.name}`, {
      id: streamConfig.id,
    });
  }

  // Start all streams
  logger.info("Starting all streams...");

  const startPromises = streamManagers.map(async (manager) => {
    try {
      await manager.start();
    } catch (error) {
      logger.error(`Failed to start stream ${manager["id"]}`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  });

  await Promise.all(startPromises);

  logger.info("All streams initialized");
  logger.info("=".repeat(60));

  // Log status every 5 minutes
  statusInterval = setInterval(() => {
    logStatus();
  }, 5 * 60 * 1000);
}

/**
 * Log current status of all streams
 */
function logStatus(): void {
  logger.info("Stream Status Report", {
    streams: streamManagers.map((m) => m.getStatus()),
  });
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress, forcing exit...");
    process.exit(1);
    return;
  }

  isShuttingDown = true;

  logger.info("=".repeat(60));
  logger.info(`Received ${signal}, initiating graceful shutdown...`);
  logger.info("=".repeat(60));

  try {
    // Clear status interval
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }

    // Stop all stream managers
    logger.info("Stopping all stream managers...");

    const stopPromises = streamManagers.map(async (manager) => {
      try {
        await manager.stop();
        logger.info(`Stopped stream manager: ${manager["id"]}`);
      } catch (error) {
        logger.error(`Error stopping stream ${manager["id"]}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Wait for all streams to stop with timeout
    await Promise.race([
      Promise.all(stopPromises),
      new Promise((resolve) =>
        setTimeout(resolve, config.process.forceKillTimeout)
      ),
    ]);

    logger.info("All streams stopped successfully");
    logger.info("Shutdown complete");

    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions
 */
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });

  // Attempt graceful shutdown
  shutdown("UNCAUGHT_EXCEPTION");
});

/**
 * Handle unhandled promise rejections
 */
process.on(
  "unhandledRejection",
  (reason: unknown, promise: Promise<unknown>) => {
    logger.error("Unhandled Promise Rejection", {
      reason: reason,
      promise: promise,
    });

    // Attempt graceful shutdown
    shutdown("UNHANDLED_REJECTION");
  }
);

/**
 * Handle SIGINT (Ctrl+C)
 */
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

/**
 * Handle SIGTERM (kill command)
 */
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

/**
 * Start the server
 */
startServer().catch((error: Error) => {
  logger.error("Failed to start server", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
