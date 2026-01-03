/**
 * Shared Utility Functions
 * Common helpers used across multiple modules
 */

/**
 * Sleep helper for rate limiting and retries
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract meaningful error message from axios error
 * @param {Error} error - Axios error object
 * @returns {string} Human-readable error message
 */
export function extractErrorMessage(error) {
  if (error.response) {
    const data = error.response.data;
    if (data) {
      if (typeof data === 'string') {
        return data;
      }
      if (data.error_description) {
        return data.error_description;
      }
      if (data.error) {
        return typeof data.error === 'string'
          ? data.error
          : `${data.error}: ${data.error_description || 'No details provided'}`;
      }
      if (data.message) {
        return data.message;
      }
      if (data.errors && Array.isArray(data.errors)) {
        return data.errors.map(e => e.message || e).join('; ');
      }
      return JSON.stringify(data);
    }
    return `HTTP ${error.response.status}: ${error.response.statusText}`;
  }

  if (error.request) {
    if (error.code === 'ECONNREFUSED') {
      return 'Connection refused. Check SFMC URL configuration.';
    }
    if (error.code === 'ENOTFOUND') {
      return 'Host not found. Check SFMC subdomain configuration.';
    }
    if (error.code === 'ETIMEDOUT') {
      return 'Request timed out. Check network connectivity.';
    }
    return `Network error: ${error.code || 'No response from server'}`;
  }

  return error.message || 'Unknown error';
}

/**
 * Retry configuration constants
 */
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000
};

/**
 * Cache configuration constants
 */
export const CACHE_CONFIG = {
  DEFAULT_EXPIRY_MS: 24 * 60 * 60 * 1000, // 24 hours
  LOCK_TIMEOUT_MS: 30 * 1000, // 30 seconds
  LOCK_RETRY_DELAY_MS: 100,
  LOCK_MAX_RETRIES: 50
};

/**
 * Check if an error is retryable
 * @param {Error} error - Error object
 * @returns {boolean} True if the error is retryable
 */
export function isRetryableError(error) {
  return (
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    (error.response && error.response.status === 503) ||
    (error.response && error.response.status === 429)
  );
}

/**
 * Calculate exponential backoff delay
 * @param {number} retryCount - Current retry attempt (0-based)
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoffDelay(retryCount, baseDelay = RETRY_CONFIG.RETRY_DELAY_MS) {
  return baseDelay * Math.pow(2, retryCount);
}

export default {
  sleep,
  extractErrorMessage,
  isRetryableError,
  calculateBackoffDelay,
  RETRY_CONFIG,
  CACHE_CONFIG
};
