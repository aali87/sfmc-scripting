/**
 * Configuration loader for SFMC DE Toolkit
 * Loads and validates environment variables with sensible defaults
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Parse comma-separated string into array, trimming whitespace
 * @param {string} value - Comma-separated string
 * @param {string[]} defaultValue - Default array if value is empty
 * @returns {string[]}
 */
function parseCommaSeparated(value, defaultValue = []) {
  if (!value || value.trim() === '') {
    return defaultValue;
  }
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * Get numeric value from environment with default
 * @param {string} value - Environment variable value
 * @param {number} defaultValue - Default if not set or invalid
 * @returns {number}
 */
function parseNumber(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Build URLs from subdomain if full URLs not provided
 * @param {string} subdomain - SFMC subdomain
 * @returns {object} URLs object
 */
function buildUrls(subdomain) {
  const base = subdomain || 'YOUR_SUBDOMAIN';
  return {
    auth: `https://${base}.auth.marketingcloudapis.com`,
    soap: `https://${base}.soap.marketingcloudapis.com/Service.asmx`,
    rest: `https://${base}.rest.marketingcloudapis.com`
  };
}

// Build URLs from subdomain or use explicit URLs
const defaultUrls = buildUrls(process.env.SFMC_SUBDOMAIN);

/**
 * Main configuration object
 * All settings are loaded from environment variables with sensible defaults
 */
const config = {
  // SFMC Authentication
  sfmc: {
    clientId: process.env.SFMC_CLIENT_ID,
    clientSecret: process.env.SFMC_CLIENT_SECRET,
    authUrl: process.env.SFMC_AUTH_URL || defaultUrls.auth,
    soapUrl: process.env.SFMC_SOAP_URL || defaultUrls.soap,
    restUrl: process.env.SFMC_REST_URL || defaultUrls.rest,
    accountId: process.env.SFMC_ACCOUNT_ID,
    subdomain: process.env.SFMC_SUBDOMAIN
  },

  // Safety Settings
  safety: {
    protectedFolderPatterns: parseCommaSeparated(
      process.env.PROTECTED_FOLDER_PATTERNS,
      ['System', 'CASL', 'Shared Data Extensions', 'SYS_', 'Platform', 'Salesforce',
       'Einstein', 'Synchronized', 'Contact Builder', 'MobileConnect', 'MobilePush',
       'GroupConnect', 'CloudPages']
    ),
    protectedDePrefixes: parseCommaSeparated(
      process.env.PROTECTED_DE_PREFIXES,
      ['SYS_', 'CASL_', 'CAD_', 'IDP_', 'US_OptOut', 'US_Bounce', 'US_Complaints',
       '_Subscribers', '_Bounce', '_Click', '_Complaint', '_Job', '_Journey',
       '_Open', '_Sent', '_Unsubscribe', '_MobileAddress', '_MobileSubscription',
       '_PushAddress', '_SMSMessageTracking', 'ent.', '_EnterpriseAttribute', 'ContactMaster']
    ),
    maxDeleteBatchSize: parseNumber(process.env.MAX_DELETE_BATCH_SIZE, 50),
    apiRateLimitDelayMs: parseNumber(process.env.API_RATE_LIMIT_DELAY_MS, 200),
    allowedBusinessUnits: parseCommaSeparated(process.env.ALLOWED_BUSINESS_UNITS, [])
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    maxSize: parseNumber(process.env.LOG_MAX_SIZE, 10 * 1024 * 1024), // 10MB
    maxFiles: parseNumber(process.env.LOG_MAX_FILES, 10)
  },

  // Webhook Configuration
  webhook: {
    url: process.env.WEBHOOK_URL || null,
    includeDetails: process.env.WEBHOOK_INCLUDE_DETAILS === 'true'
  },

  // Paths (relative to project root)
  paths: {
    root: path.resolve(__dirname, '../..'),
    logs: path.resolve(__dirname, '../../logs'),
    audit: path.resolve(__dirname, '../../audit'),
    backup: path.resolve(__dirname, '../../backup'),
    state: path.resolve(__dirname, '../../state'),
    undo: path.resolve(__dirname, '../../undo')
  },

  // Pagination settings
  pagination: {
    defaultPageSize: parseNumber(process.env.DEFAULT_PAGE_SIZE, 500),
    journeyPageSize: parseNumber(process.env.JOURNEY_PAGE_SIZE, 100),
    automationDetailsBatchSize: parseNumber(process.env.AUTOMATION_DETAILS_BATCH_SIZE, 10)
  },

  // Auth Configuration
  auth: {
    tokenExpiryBufferMinutes: parseNumber(process.env.TOKEN_EXPIRY_BUFFER_MINUTES, 5)
  },

  // UI Configuration
  ui: {
    consoleWidth: parseNumber(process.env.CONSOLE_WIDTH, 70),
    maxItemsToDisplay: parseNumber(process.env.MAX_ITEMS_TO_DISPLAY, 20)
  },

  // API Timeout Settings
  timeouts: {
    soapTimeoutMs: parseNumber(process.env.SOAP_TIMEOUT_MS, 120000),      // 2 minutes
    restTimeoutMs: parseNumber(process.env.REST_TIMEOUT_MS, 60000),       // 1 minute
    webhookTimeoutMs: parseNumber(process.env.WEBHOOK_TIMEOUT_MS, 10000)  // 10 seconds
  },

  // Concurrency Settings
  concurrency: {
    queryTextConcurrency: parseNumber(process.env.QUERY_TEXT_CONCURRENCY, 25),
    automationDetailsConcurrency: parseNumber(process.env.AUTOMATION_DETAILS_CONCURRENCY, 10)
  },

  // Version info
  version: '1.0.0'
};

/**
 * Validate that required configuration is present
 * @throws {Error} If required configuration is missing
 */
export function validateConfig() {
  const errors = [];

  if (!config.sfmc.clientId) {
    errors.push('SFMC_CLIENT_ID is required');
  }
  if (!config.sfmc.clientSecret) {
    errors.push('SFMC_CLIENT_SECRET is required');
  }
  if (!config.sfmc.accountId) {
    errors.push('SFMC_ACCOUNT_ID is required');
  }
  if (!config.sfmc.subdomain && config.sfmc.authUrl.includes('YOUR_SUBDOMAIN')) {
    errors.push('SFMC_SUBDOMAIN or explicit URLs are required');
  }

  if (errors.length > 0) {
    throw new Error(
      'Configuration validation failed:\n' +
      errors.map(e => `  - ${e}`).join('\n') +
      '\n\nPlease check your .env file.'
    );
  }

  return true;
}

/**
 * Check if a folder name matches any protected patterns
 * @param {string} folderName - Folder name to check
 * @returns {boolean} True if folder is protected
 */
export function isFolderProtected(folderName) {
  const lowerName = folderName.toLowerCase();
  return config.safety.protectedFolderPatterns.some(pattern =>
    lowerName.includes(pattern.toLowerCase())
  );
}

/**
 * Check if a DE name/key matches any protected prefixes
 * @param {string} deName - DE name or CustomerKey to check
 * @returns {boolean} True if DE is protected
 */
export function isDeProtected(deName) {
  const lowerName = deName.toLowerCase();
  return config.safety.protectedDePrefixes.some(prefix =>
    lowerName.startsWith(prefix.toLowerCase())
  );
}

/**
 * Check if a Business Unit is allowed
 * @param {string} mid - Business Unit MID to check
 * @returns {boolean} True if BU is allowed (or if no restrictions)
 */
export function isBusinessUnitAllowed(mid) {
  if (config.safety.allowedBusinessUnits.length === 0) {
    return true;
  }
  return config.safety.allowedBusinessUnits.includes(mid.toString());
}

export default config;
