/**
 * Logger configuration using Winston
 * Provides both console and file logging with rotation
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";
// import { fileURLToPath } from "url";
import config from "./config.js";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// Ensure logs directory exists
const logsDir = config.logging.file.directory;
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }

    return msg;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports array
const transports: winston.transport[] = [];

// Console transport
if (config.logging.console.enabled) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: config.logging.level,
    })
  );
}

// File transports
if (config.logging.file.enabled) {
  // Combined log (all levels)
  transports.push(
    new DailyRotateFile({
      filename: path.join(logsDir, config.logging.file.combined.filename),
      datePattern: config.logging.file.combined.datePattern,
      maxSize: config.logging.file.combined.maxSize,
      maxFiles: config.logging.file.combined.maxFiles,
      format: fileFormat,
      level: config.logging.level,
    })
  );

  // Error log (errors only)
  transports.push(
    new DailyRotateFile({
      filename: path.join(logsDir, config.logging.file.error.filename),
      datePattern: config.logging.file.error.datePattern,
      maxSize: config.logging.file.error.maxSize,
      maxFiles: config.logging.file.error.maxFiles,
      format: fileFormat,
      level: "error",
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  transports,
  exitOnError: false,
});

// Helper methods for structured logging
export const logStreamEvent = (
  streamId: string,
  event: string,
  details: Record<string, any> = {}
): void => {
  logger.info(`[${streamId}] ${event}`, details);
};

export const logStreamError = (
  streamId: string,
  error: string | Error,
  details: Record<string, any> = {}
): void => {
  const errorMessage = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  logger.error(`[${streamId}] ${errorMessage}`, {
    ...details,
    stack,
  });
};

export const logStreamWarning = (
  streamId: string,
  warning: string,
  details: Record<string, any> = {}
): void => {
  logger.warn(`[${streamId}] ${warning}`, details);
};

export const logStreamDebug = (
  streamId: string,
  message: string,
  details: Record<string, any> = {}
): void => {
  logger.debug(`[${streamId}] ${message}`, details);
};

// Log startup information
logger.info("Logger initialized", {
  level: config.logging.level,
  consoleEnabled: config.logging.console.enabled,
  fileEnabled: config.logging.file.enabled,
  logsDirectory: logsDir,
});

export default logger;
