/**
 * Cache Management Module
 * Stores folder structure and other metadata locally to reduce API calls
 *
 * Supports parallel process execution with:
 * - Atomic writes (write to temp file, then rename)
 * - File locking to prevent concurrent writes
 * - Graceful handling of lock contention
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sleep, CACHE_CONFIG } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.resolve(__dirname, '../../cache');

// Use shared constants from utils
const {
  DEFAULT_EXPIRY_MS: DEFAULT_CACHE_EXPIRY_MS,
  LOCK_TIMEOUT_MS,
  LOCK_RETRY_DELAY_MS,
  LOCK_MAX_RETRIES
} = CACHE_CONFIG;

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    // Directory may already exist
  }
}

/**
 * Get lock file path for a cache file
 * @param {string} cacheFilePath - Path to cache file
 * @returns {string} Path to lock file
 */
function getLockFilePath(cacheFilePath) {
  return `${cacheFilePath}.lock`;
}

/**
 * Acquire a lock for writing to a cache file
 * Uses exclusive file creation to ensure only one process can hold the lock
 * @param {string} cacheFilePath - Path to cache file
 * @returns {Promise<boolean>} True if lock acquired
 */
async function acquireLock(cacheFilePath) {
  const lockPath = getLockFilePath(cacheFilePath);

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      // Try to create lock file exclusively (fails if exists)
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown'
      });

      await fs.writeFile(lockPath, lockData, { flag: 'wx' });
      return true; // Lock acquired
    } catch (error) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if it's stale
        try {
          const lockContent = await fs.readFile(lockPath, 'utf-8');
          const lockInfo = JSON.parse(lockContent);
          const lockAge = Date.now() - lockInfo.timestamp;

          if (lockAge > LOCK_TIMEOUT_MS) {
            // Lock is stale, remove it and retry
            try {
              await fs.unlink(lockPath);
              continue; // Retry immediately
            } catch (e) {
              // Another process may have removed it
            }
          }
        } catch (e) {
          // Lock file may have been removed, retry
        }

        // Wait before retrying
        await sleep(LOCK_RETRY_DELAY_MS);
      } else {
        // Unexpected error
        throw error;
      }
    }
  }

  return false; // Could not acquire lock
}

/**
 * Release a lock
 * @param {string} cacheFilePath - Path to cache file
 */
async function releaseLock(cacheFilePath) {
  const lockPath = getLockFilePath(cacheFilePath);
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    // Lock may already be released
  }
}

/**
 * Get cache file path for a specific cache type and account
 * @param {string} cacheType - Type of cache (e.g., 'folders', 'dataextensions')
 * @param {string} accountId - SFMC Account ID (MID)
 * @returns {string} Full path to cache file
 */
function getCacheFilePath(cacheType, accountId) {
  return path.join(CACHE_DIR, `${cacheType}-${accountId}.json`);
}

/**
 * Read cache from file
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @param {object} options - Options
 * @param {number} options.maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @param {boolean} options.ignoreExpiry - Ignore expiry and return cache anyway
 * @returns {Promise<object|null>} Cached data or null if not found/expired
 */
export async function readCache(cacheType, accountId, options = {}) {
  const { maxAgeMs = DEFAULT_CACHE_EXPIRY_MS, ignoreExpiry = false } = options;
  const filePath = getCacheFilePath(cacheType, accountId);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const cache = JSON.parse(content);

    // Check if cache has required metadata
    if (!cache.metadata || !cache.metadata.cachedAt) {
      return null;
    }

    // Check expiry (unless ignored)
    if (!ignoreExpiry) {
      const age = Date.now() - new Date(cache.metadata.cachedAt).getTime();
      if (age > maxAgeMs) {
        return null; // Cache expired
      }
    }

    return cache;
  } catch (error) {
    // File doesn't exist or is invalid
    return null;
  }
}

/**
 * Write data to cache with atomic write and file locking
 * Uses write-to-temp-then-rename pattern to prevent corruption
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @param {object} data - Data to cache
 * @param {object} extraMetadata - Additional metadata to store
 * @returns {Promise<boolean>} True if write succeeded, false if lock couldn't be acquired
 */
export async function writeCache(cacheType, accountId, data, extraMetadata = {}) {
  await ensureCacheDir();
  const filePath = getCacheFilePath(cacheType, accountId);
  const tempPath = `${filePath}.${process.pid}.tmp`;

  // Try to acquire lock
  const lockAcquired = await acquireLock(filePath);
  if (!lockAcquired) {
    // Another process is writing, skip this write
    // The other process's cache will be used
    return false;
  }

  try {
    const cache = {
      metadata: {
        cachedAt: new Date().toISOString(),
        accountId,
        cacheType,
        pid: process.pid,
        ...extraMetadata
      },
      data
    };

    // Write to temp file first
    await fs.writeFile(tempPath, JSON.stringify(cache, null, 2), 'utf-8');

    // Atomic rename (this is atomic on most filesystems)
    await fs.rename(tempPath, filePath);

    return true;
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch (e) {
      // Temp file may not exist
    }
    throw error;
  } finally {
    // Always release lock
    await releaseLock(filePath);
  }
}

/**
 * Clear specific cache (with locking)
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @returns {Promise<boolean>} True if cache was cleared
 */
export async function clearCache(cacheType, accountId) {
  const filePath = getCacheFilePath(cacheType, accountId);

  // Try to acquire lock (but don't fail if we can't)
  const lockAcquired = await acquireLock(filePath);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    return false;
  } finally {
    if (lockAcquired) {
      await releaseLock(filePath);
    }
  }
}

/**
 * Clear all caches for an account
 * @param {string} accountId - SFMC Account ID
 * @returns {Promise<number>} Number of cache files cleared
 */
export async function clearAllCaches(accountId) {
  await ensureCacheDir();
  let cleared = 0;

  try {
    const files = await fs.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith(`-${accountId}.json`)) {
        await fs.unlink(path.join(CACHE_DIR, file));
        cleared++;
      }
    }
  } catch (error) {
    // Directory may not exist
  }

  return cleared;
}

/**
 * Get cache info (age, size, etc.)
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @returns {Promise<object|null>} Cache info or null if not found
 */
export async function getCacheInfo(cacheType, accountId) {
  const filePath = getCacheFilePath(cacheType, accountId);

  try {
    const stats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    const cache = JSON.parse(content);

    const cachedAt = new Date(cache.metadata?.cachedAt);
    const ageMs = Date.now() - cachedAt.getTime();
    const ageMinutes = Math.floor(ageMs / 60000);
    const ageHours = Math.floor(ageMinutes / 60);

    let ageString;
    if (ageHours > 0) {
      ageString = `${ageHours}h ${ageMinutes % 60}m ago`;
    } else {
      ageString = `${ageMinutes}m ago`;
    }

    // Count items in cache
    let itemCount = 0;
    if (cache.data) {
      if (Array.isArray(cache.data)) {
        itemCount = cache.data.length;
      } else if (typeof cache.data === 'object') {
        itemCount = Object.keys(cache.data).length;
      }
    }

    return {
      exists: true,
      filePath,
      fileSize: stats.size,
      cachedAt: cache.metadata?.cachedAt,
      ageMs,
      ageString,
      itemCount,
      metadata: cache.metadata
    };
  } catch (error) {
    return {
      exists: false,
      filePath
    };
  }
}

/**
 * List all caches
 * @returns {Promise<Array>} List of cache info objects
 */
export async function listAllCaches() {
  await ensureCacheDir();
  const caches = [];

  try {
    const files = await fs.readdir(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(CACHE_DIR, file);
        try {
          const stats = await fs.stat(filePath);
          const content = await fs.readFile(filePath, 'utf-8');
          const cache = JSON.parse(content);

          caches.push({
            file,
            filePath,
            fileSize: stats.size,
            cacheType: cache.metadata?.cacheType,
            accountId: cache.metadata?.accountId,
            cachedAt: cache.metadata?.cachedAt
          });
        } catch (e) {
          // Skip invalid files
        }
      }
    }
  } catch (error) {
    // Directory may not exist
  }

  return caches;
}

export default {
  readCache,
  writeCache,
  clearCache,
  clearAllCaches,
  getCacheInfo,
  listAllCaches,
  DEFAULT_CACHE_EXPIRY_MS
};
