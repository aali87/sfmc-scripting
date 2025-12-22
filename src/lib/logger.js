/**
 * Winston-based logging utility for SFMC DE Toolkit
 * Provides console and file logging with proper formatting
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import dayjs from 'dayjs';
import config from '../config/index.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Ensure logs directory exists
if (!fs.existsSync(config.paths.logs)) {
  fs.mkdirSync(config.paths.logs, { recursive: true });
}

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  const ts = dayjs(timestamp).format('HH:mm:ss.SSS');
  const msg = stack || message;
  return `${ts} [${level}] ${msg}`;
});

// Custom format for file output (more detailed)
const fileFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  const ts = dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss.SSS');
  let msg = `${ts} [${level.toUpperCase()}] ${stack || message}`;

  // Include metadata if present (excluding standard fields)
  const metaKeys = Object.keys(metadata);
  if (metaKeys.length > 0) {
    const metaStr = JSON.stringify(metadata);
    if (metaStr !== '{}') {
      msg += ` ${metaStr}`;
    }
  }

  return msg;
});

/**
 * Create a logger instance for a specific script/operation
 * @param {string} scriptName - Name of the script (used in log filename)
 * @returns {winston.Logger}
 */
export function createLogger(scriptName) {
  const logTimestamp = dayjs().format('YYYYMMDD-HHmmss');
  const logFilename = `${scriptName}-${logTimestamp}.log`;
  const logPath = path.join(config.paths.logs, logFilename);

  const logger = winston.createLogger({
    level: config.logging.level,
    format: combine(
      timestamp(),
      errors({ stack: true })
    ),
    defaultMeta: { script: scriptName },
    transports: [
      // Console transport with colors
      new winston.transports.Console({
        format: combine(
          colorize({ all: true }),
          timestamp(),
          consoleFormat
        ),
        level: config.logging.level === 'debug' ? 'debug' : 'info'
      }),
      // File transport (all levels including debug)
      new winston.transports.File({
        filename: logPath,
        format: combine(
          timestamp(),
          fileFormat
        ),
        level: 'debug', // Always log debug to file
        maxsize: config.logging.maxSize,
        maxFiles: config.logging.maxFiles
      })
    ]
  });

  // Store log file path for reference
  logger.logFilePath = logPath;

  // Add convenience method for logging API requests (debug level)
  logger.api = (method, endpoint, details = {}) => {
    logger.debug(`API ${method} ${endpoint}`, details);
  };

  // Add convenience method for logging operation progress
  logger.progress = (current, total, message) => {
    logger.info(`[${current}/${total}] ${message}`);
  };

  // Add convenience method for section headers
  logger.section = (title) => {
    logger.info('');
    logger.info('='.repeat(60));
    logger.info(title);
    logger.info('='.repeat(60));
  };

  return logger;
}

/**
 * Create an audit logger that writes structured JSON for compliance
 * @param {string} operationType - Type of operation (audit, delete-des, delete-folders)
 * @returns {object} Audit logger with add and save methods
 */
export function createAuditLogger(operationType) {
  const auditTimestamp = dayjs().format('YYYYMMDD-HHmmss');
  const operationId = `${operationType}-${auditTimestamp}`;
  const auditFilename = `${operationId}.json`;
  const auditPath = path.join(config.paths.audit, auditFilename);

  // Ensure audit directory exists
  if (!fs.existsSync(config.paths.audit)) {
    fs.mkdirSync(config.paths.audit, { recursive: true });
  }

  const auditData = {
    operationId,
    operationType,
    startedAt: new Date().toISOString(),
    completedAt: null,
    businessUnit: config.sfmc.accountId,
    options: {},
    preExecutionState: {},
    results: {
      successful: [],
      failed: [],
      skipped: []
    },
    duration: null,
    exitCode: null
  };

  return {
    operationId,
    auditPath,

    /**
     * Set operation options
     * @param {object} options - Command line options used
     */
    setOptions(options) {
      auditData.options = { ...options };
      // Remove sensitive data
      delete auditData.options.clientId;
      delete auditData.options.clientSecret;
    },

    /**
     * Set pre-execution state
     * @param {object} state - State before operation
     */
    setPreExecutionState(state) {
      auditData.preExecutionState = { ...state };
    },

    /**
     * Record a successful operation
     * @param {object} item - Item that was successfully processed
     */
    addSuccess(item) {
      auditData.results.successful.push({
        ...item,
        processedAt: new Date().toISOString()
      });
    },

    /**
     * Record a failed operation
     * @param {object} item - Item that failed
     * @param {string} error - Error message
     */
    addFailure(item, error) {
      auditData.results.failed.push({
        ...item,
        error,
        failedAt: new Date().toISOString()
      });
    },

    /**
     * Record a skipped item
     * @param {object} item - Item that was skipped
     * @param {string} reason - Reason for skipping
     */
    addSkipped(item, reason) {
      auditData.results.skipped.push({
        ...item,
        reason,
        skippedAt: new Date().toISOString()
      });
    },

    /**
     * Set additional metadata
     * @param {string} key - Metadata key
     * @param {any} value - Metadata value
     */
    setMetadata(key, value) {
      auditData[key] = value;
    },

    /**
     * Save the audit log to file
     * @param {number} exitCode - Script exit code
     * @returns {string} Path to saved audit file
     */
    save(exitCode = 0) {
      auditData.completedAt = new Date().toISOString();
      auditData.exitCode = exitCode;

      const startTime = new Date(auditData.startedAt).getTime();
      const endTime = new Date(auditData.completedAt).getTime();
      const durationMs = endTime - startTime;
      auditData.duration = `${Math.round(durationMs / 1000)} seconds`;

      fs.writeFileSync(auditPath, JSON.stringify(auditData, null, 2));
      return auditPath;
    },

    /**
     * Get current audit data (for previews/summaries)
     * @returns {object} Current audit data
     */
    getData() {
      return { ...auditData };
    }
  };
}

/**
 * Create a state persistence helper for resumable operations
 * @param {string} operationId - Unique operation identifier
 * @returns {object} State manager with save/load methods
 */
export function createStateManager(operationId) {
  const statePath = path.join(config.paths.state, `${operationId}.json`);

  // Ensure state directory exists
  if (!fs.existsSync(config.paths.state)) {
    fs.mkdirSync(config.paths.state, { recursive: true });
  }

  return {
    operationId,
    statePath,

    /**
     * Save current operation state
     * @param {object} state - State to persist
     */
    save(state) {
      const stateData = {
        operationId,
        savedAt: new Date().toISOString(),
        ...state
      };
      fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
    },

    /**
     * Load previously saved state
     * @returns {object|null} Saved state or null if not found
     */
    load() {
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, 'utf8');
        return JSON.parse(data);
      }
      return null;
    },

    /**
     * Check if state file exists
     * @returns {boolean}
     */
    exists() {
      return fs.existsSync(statePath);
    },

    /**
     * Delete state file (after successful completion)
     */
    clear() {
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
    }
  };
}

export default { createLogger, createAuditLogger, createStateManager };
