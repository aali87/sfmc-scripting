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

/**
 * Escape a value for CSV output (RFC 4180 compliant)
 * @param {*} val - Value to escape
 * @returns {string} CSV-safe string
 */
export function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format a date string for display
 * @param {string|Date} dateStr - Date string or Date object
 * @param {string} format - Output format (default: 'YYYY-MM-DD HH:mm:ss')
 * @returns {string} Formatted date string or 'N/A' if invalid
 */
export function formatDate(dateStr, format = 'YYYY-MM-DD HH:mm:ss') {
  if (!dateStr) return 'N/A';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'N/A';

    const pad = (n) => String(n).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    return format
      .replace('YYYY', year)
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hours)
      .replace('mm', minutes)
      .replace('ss', seconds);
  } catch {
    return 'N/A';
  }
}

/**
 * Format a number with thousands separators
 * @param {number|string} num - Number to format
 * @returns {string} Formatted number or 'N/A' if invalid
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  const n = Number(num);
  if (isNaN(n)) return 'N/A';
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Escape special regex characters in a string
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for use in RegExp
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get or create a Map entry with a default value
 * @param {Map} map - Map to operate on
 * @param {*} key - Key to look up
 * @param {*} defaultValue - Default value if key doesn't exist
 * @returns {*} The value for the key
 */
export function getOrCreateMapEntry(map, key, defaultValue) {
  if (!map.has(key)) {
    map.set(key, typeof defaultValue === 'function' ? defaultValue() : defaultValue);
  }
  return map.get(key);
}

/**
 * Create a concurrency limiter for parallel async operations
 * Ensures at most `limit` operations run concurrently
 * @param {number} limit - Maximum concurrent operations
 * @returns {function} Limiter function that wraps async functions
 * @example
 * const limit = createConcurrencyLimiter(5);
 * const results = await Promise.all(items.map(item => limit(() => fetchItem(item))));
 */
export function createConcurrencyLimiter(limit) {
  let running = 0;
  const queue = [];

  const runNext = () => {
    if (queue.length === 0 || running >= limit) return;

    running++;
    const { fn, resolve, reject } = queue.shift();

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        running--;
        runNext();
      });
  };

  return (fn) => {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

export default {
  sleep,
  extractErrorMessage,
  isRetryableError,
  calculateBackoffDelay,
  escapeCSV,
  formatDate,
  formatNumber,
  escapeRegex,
  getOrCreateMapEntry,
  createConcurrencyLimiter,
  RETRY_CONFIG,
  CACHE_CONFIG
};
