/**
 * SFMC OAuth 2.0 Authentication Module
 * Handles token acquisition, caching, and refresh
 */

import axios from 'axios';
import config from '../config/index.js';
import { extractErrorMessage } from './utils.js';

// Token cache
let tokenCache = {
  accessToken: null,
  tokenType: null,
  expiresAt: null,
  restInstanceUrl: null,
  soapInstanceUrl: null
};

// Buffer time before expiry to refresh (5 minutes)
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Get an access token, using cache if valid
 * @param {object} logger - Logger instance (optional)
 * @returns {Promise<object>} Token info including accessToken, restInstanceUrl, soapInstanceUrl
 */
export async function getAccessToken(logger = null) {
  // Check if we have a valid cached token
  if (tokenCache.accessToken && tokenCache.expiresAt) {
    const now = Date.now();
    if (now < tokenCache.expiresAt - EXPIRY_BUFFER_MS) {
      if (logger) {
        logger.debug('Using cached access token');
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
    logger.debug('Fetching new access token from SFMC');
  }

  // Remove trailing slash from authUrl to avoid double slashes
  const authBase = config.sfmc.authUrl.replace(/\/$/, '');
  const tokenUrl = `${authBase}/v2/token`;

  try {
    const response = await axios.post(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: config.sfmc.clientId,
      client_secret: config.sfmc.clientSecret,
      account_id: config.sfmc.accountId
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

    // Update cache
    tokenCache = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresAt,
      restInstanceUrl: data.rest_instance_url || config.sfmc.restUrl,
      soapInstanceUrl: data.soap_instance_url || config.sfmc.soapUrl
    };

    if (logger) {
      logger.debug(`Token acquired, expires in ${expiresIn} seconds`);
    }

    return {
      accessToken: tokenCache.accessToken,
      tokenType: tokenCache.tokenType,
      restInstanceUrl: tokenCache.restInstanceUrl,
      soapInstanceUrl: tokenCache.soapInstanceUrl
    };

  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    if (logger) {
      logger.error(`Authentication failed: ${errorMessage}`);
    }
    throw new Error(`SFMC Authentication failed: ${errorMessage}`);
  }
}

/**
 * Force token refresh (useful after permission changes)
 * @param {object} logger - Logger instance (optional)
 * @returns {Promise<object>} New token info
 */
export async function refreshToken(logger = null) {
  // Clear cache to force refresh
  tokenCache = {
    accessToken: null,
    tokenType: null,
    expiresAt: null,
    restInstanceUrl: null,
    soapInstanceUrl: null
  };

  return getAccessToken(logger);
}

/**
 * Clear the token cache (for logout/cleanup)
 */
export function clearTokenCache() {
  tokenCache = {
    accessToken: null,
    tokenType: null,
    expiresAt: null,
    restInstanceUrl: null,
    soapInstanceUrl: null
  };
}

/**
 * Check if we have a valid token without making an API call
 * @returns {boolean} True if token exists and is not expired
 */
export function hasValidToken() {
  if (!tokenCache.accessToken || !tokenCache.expiresAt) {
    return false;
  }
  return Date.now() < tokenCache.expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Get token expiry information
 * @returns {object|null} Expiry info or null if no token
 */
export function getTokenExpiry() {
  if (!tokenCache.expiresAt) {
    return null;
  }

  const now = Date.now();
  const remainingMs = tokenCache.expiresAt - now;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));

  return {
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    remainingSeconds,
    isExpired: remainingMs <= 0,
    needsRefresh: remainingMs <= EXPIRY_BUFFER_MS
  };
}

/**
 * Test authentication by fetching a token
 * @param {object} logger - Logger instance (optional)
 * @returns {Promise<object>} Connection info
 */
export async function testConnection(logger = null) {
  try {
    const tokenInfo = await getAccessToken(logger);

    return {
      success: true,
      accountId: config.sfmc.accountId,
      restUrl: tokenInfo.restInstanceUrl,
      soapUrl: tokenInfo.soapInstanceUrl,
      tokenExpiry: getTokenExpiry()
    };

  } catch (error) {
    return {
      success: false,
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
