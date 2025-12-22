/**
 * Cache Management Module
 * Stores folder structure and other metadata locally to reduce API calls
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.resolve(__dirname, '../../cache');

// Default cache expiry: 24 hours (in milliseconds)
const DEFAULT_CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
 * Write data to cache
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @param {object} data - Data to cache
 * @param {object} extraMetadata - Additional metadata to store
 * @returns {Promise<void>}
 */
export async function writeCache(cacheType, accountId, data, extraMetadata = {}) {
  await ensureCacheDir();
  const filePath = getCacheFilePath(cacheType, accountId);

  const cache = {
    metadata: {
      cachedAt: new Date().toISOString(),
      accountId,
      cacheType,
      ...extraMetadata
    },
    data
  };

  await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Clear specific cache
 * @param {string} cacheType - Type of cache
 * @param {string} accountId - SFMC Account ID
 * @returns {Promise<boolean>} True if cache was cleared
 */
export async function clearCache(cacheType, accountId) {
  const filePath = getCacheFilePath(cacheType, accountId);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    return false;
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
