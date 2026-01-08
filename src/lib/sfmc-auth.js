/**
 * SFMC OAuth 2.0 Authentication Module
 * Handles token acquisition, caching, and refresh
 * Supports multi-BU (Business Unit) token management
 */

import axios from 'axios';
import config from '../config/index.js';
import { extractErrorMessage } from './utils.js';

// Token cache per accountId (supports multi-BU)
const tokenCacheByAccount = new Map();

// Buffer time before expiry to refresh (from config, default 5 minutes)
const EXPIRY_BUFFER_MS = config.auth.tokenExpiryBufferMinutes * 60 * 1000;

/**
 * Get or create token cache entry for an account
 * @param {string} accountId - Business Unit account ID
 * @returns {object} Token cache entry
 */
function getTokenEntry(accountId) {
  if (!tokenCacheByAccount.has(accountId)) {
    tokenCacheByAccount.set(accountId, {
      accessToken: null,
      tokenType: null,
      expiresAt: null,
      restInstanceUrl: null,
      soapInstanceUrl: null
    });
  }
  return tokenCacheByAccount.get(accountId);
}

/**
 * Get the effective account ID (provided or from config)
 * @param {string|null} accountId - Optional account ID override
 * @returns {string} Effective account ID
 */
function getEffectiveAccountId(accountId) {
  return accountId || config.sfmc.accountId;
}

/**
 * Get an access token, using cache if valid
 * @param {object} logger - Logger instance (optional)
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {Promise<object>} Token info including accessToken, restInstanceUrl, soapInstanceUrl
 */
export async function getAccessToken(logger = null, accountId = null) {
  const effectiveAccountId = getEffectiveAccountId(accountId);
  const tokenCache = getTokenEntry(effectiveAccountId);

  // Check if we have a valid cached token
  if (tokenCache.accessToken && tokenCache.expiresAt) {
    const now = Date.now();
    if (now < tokenCache.expiresAt - EXPIRY_BUFFER_MS) {
      if (logger) {
        logger.debug(`Using cached access token for BU ${effectiveAccountId}`);
      }
      return {
        accessToken: tokenCache.accessToken,
        tokenType: tokenCache.tokenType,
        restInstanceUrl: tokenCache.restInstanceUrl,
        soapInstanceUrl: tokenCache.soapInstanceUrl
      };
    }
  }

  // Need to fetch a new token
  if (logger) {
    logger.debug(`Fetching new access token from SFMC for BU ${effectiveAccountId}`);
  }

  // Remove trailing slash from authUrl to avoid double slashes
  const authBase = config.sfmc.authUrl.replace(/\/$/, '');
  const tokenUrl = `${authBase}/v2/token`;

  try {
    const response = await axios.post(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: config.sfmc.clientId,
      client_secret: config.sfmc.clientSecret,
      account_id: effectiveAccountId
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const data = response.data;

    // Calculate expiry time
    const expiresIn = data.expires_in || 1200; // Default 20 minutes
    const expiresAt = Date.now() + (expiresIn * 1000);

    // Update cache for this account
    const updatedCache = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt,
      restInstanceUrl: data.rest_instance_url || config.sfmc.restUrl,
      soapInstanceUrl: data.soap_instance_url || config.sfmc.soapUrl
    };
    tokenCacheByAccount.set(effectiveAccountId, updatedCache);

    if (logger) {
      logger.debug(`Token acquired for BU ${effectiveAccountId}, expires in ${expiresIn} seconds`);
    }

    return {
      accessToken: updatedCache.accessToken,
      tokenType: updatedCache.tokenType,
      restInstanceUrl: updatedCache.restInstanceUrl,
      soapInstanceUrl: updatedCache.soapInstanceUrl
    };

  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    if (logger) {
      logger.error(`Authentication failed for BU ${effectiveAccountId}: ${errorMessage}`);
    }
    throw new Error(`SFMC Authentication failed for BU ${effectiveAccountId}: ${errorMessage}`);
  }
}

/**
 * Force token refresh (useful after permission changes)
 * @param {object} logger - Logger instance (optional)
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {Promise<object>} New token info
 */
export async function refreshToken(logger = null, accountId = null) {
  const effectiveAccountId = getEffectiveAccountId(accountId);

  // Clear cache for this account to force refresh
  tokenCacheByAccount.set(effectiveAccountId, {
    accessToken: null,
    tokenType: null,
    expiresAt: null,
    restInstanceUrl: null,
    soapInstanceUrl: null
  });

  return getAccessToken(logger, effectiveAccountId);
}

/**
 * Clear the token cache (for logout/cleanup)
 * @param {string} accountId - Business Unit account ID (optional, clears all if not provided)
 */
export function clearTokenCache(accountId = null) {
  if (accountId) {
    // Clear specific account
    tokenCacheByAccount.delete(accountId);
  } else {
    // Clear all accounts
    tokenCacheByAccount.clear();
  }
}

/**
 * Check if we have a valid token without making an API call
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {boolean} True if token exists and is not expired
 */
export function hasValidToken(accountId = null) {
  const effectiveAccountId = getEffectiveAccountId(accountId);
  const tokenCache = tokenCacheByAccount.get(effectiveAccountId);

  if (!tokenCache || !tokenCache.accessToken || !tokenCache.expiresAt) {
    return false;
  }
  return Date.now() < tokenCache.expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Get token expiry information
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {object|null} Expiry info or null if no token
 */
export function getTokenExpiry(accountId = null) {
  const effectiveAccountId = getEffectiveAccountId(accountId);
  const tokenCache = tokenCacheByAccount.get(effectiveAccountId);

  if (!tokenCache || tokenCache.expiresAt == null || typeof tokenCache.expiresAt !== 'number' || !Number.isFinite(tokenCache.expiresAt)) {
    return null;
  }

  const now = Date.now();
  const remainingMs = tokenCache.expiresAt - now;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

  return {
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    remainingSeconds,
    remainingFormatted: `${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s`,
    isExpired: remainingMs <= 0,
    needsRefresh: remainingMs <= EXPIRY_BUFFER_MS
  };
}

/**
 * Test authentication by fetching a token
 * @param {object} logger - Logger instance (optional)
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {Promise<object>} Connection info
 */
export async function testConnection(logger = null, accountId = null) {
  const effectiveAccountId = getEffectiveAccountId(accountId);

  try {
    const tokenInfo = await getAccessToken(logger, effectiveAccountId);

    return {
      success: true,
      accountId: effectiveAccountId,
      restUrl: tokenInfo.restInstanceUrl,
      soapUrl: tokenInfo.soapInstanceUrl,
      tokenExpiry: getTokenExpiry(effectiveAccountId)
    };

  } catch (error) {
    return {
      success: false,
      accountId: effectiveAccountId,
      error: error.message
    };
  }
}

export default {
  getAccessToken,
  refreshToken,
  clearTokenCache,
  hasValidToken,
  getTokenExpiry,
  testConnection
};
