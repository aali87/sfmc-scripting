/**
 * Bulk Data Loader
 *
 * Efficiently loads all SFMC metadata upfront for dependency analysis.
 * This avoids making repeated API calls during analysis.
 *
 * Data loaded:
 * - Automations (with full details including lastRunTime)
 * - Filter Activities
 * - Query Activities (from SOAP)
 * - Import Activities (from SOAP)
 * - Journeys
 * - Data Extracts
 *
 * Uses file-based caching (24 hours) with in-memory cache per account.
 */

import {
  getAutomations,
  getAutomationDetails,
  getFilterActivities,
  getJourneys,
  getDataExtracts
} from './sfmc-rest.js';
import {
  retrieveQueryDefinitions,
  retrieveQueryTexts,
  retrieveImportDefinitions,
  retrieveTriggeredSendDefinitions,
  retrieveDataExtensions
} from './sfmc-soap.js';
import { readCache, writeCache, clearCache, getCacheInfo } from './cache.js';
import config from '../config/index.js';
import { CACHE_CONFIG } from './utils.js';

// Cache type identifier
const BULK_DATA_CACHE_TYPE = 'bulk-data';

// Use shared cache expiry constant
const DEFAULT_CACHE_EXPIRY_MS = CACHE_CONFIG.DEFAULT_EXPIRY_MS;

// Required fields that must be present in cached data
// If any are missing, the cache is considered invalid and will be refreshed
const REQUIRED_CACHE_FIELDS = [
  'automations',
  'filterActivities',
  'queryActivities',
  'importActivities',
  'triggeredSends',
  'journeys',
  'dataExtracts',
  'dataExtensions'
];

// In-memory cache per account for current session (faster than file reads)
const memoryCacheByAccount = new Map();

/**
 * Validate that cached data has all required fields
 * @param {object} cachedData - Data from cache
 * @returns {object} { isValid: boolean, missingFields: string[] }
 */
function validateCachedData(cachedData) {
  if (!cachedData) {
    return { isValid: false, missingFields: REQUIRED_CACHE_FIELDS };
  }

  const missingFields = REQUIRED_CACHE_FIELDS.filter(field => {
    // Field must exist and be an array
    return !Array.isArray(cachedData[field]);
  });

  return {
    isValid: missingFields.length === 0,
    missingFields
  };
}

/**
 * Get or create memory cache entry for an account
 * @param {string} accountId - Business Unit account ID
 * @returns {object} Memory cache entry
 */
function getMemoryCacheEntry(accountId) {
  if (!memoryCacheByAccount.has(accountId)) {
    memoryCacheByAccount.set(accountId, {
      data: null,
      loadedAt: null
    });
  }
  return memoryCacheByAccount.get(accountId);
}

/**
 * Clear both in-memory and file-based bulk data cache
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 */
export async function clearBulkDataCache(logger = null, accountId = null) {
  const effectiveAccountId = accountId || config.sfmc.accountId;

  // Clear memory cache for this account
  memoryCacheByAccount.set(effectiveAccountId, { data: null, loadedAt: null });

  const cleared = await clearCache(BULK_DATA_CACHE_TYPE, effectiveAccountId);
  if (logger) {
    logger.info(`Bulk data cache cleared for BU ${effectiveAccountId}`);
  }
  return cleared;
}

/**
 * Get cache status information
 * @param {string} accountId - Business Unit account ID (optional, defaults to config)
 * @returns {Promise<object>} Cache info
 */
export async function getBulkDataCacheStatus(accountId = null) {
  const effectiveAccountId = accountId || config.sfmc.accountId;
  return getCacheInfo(BULK_DATA_CACHE_TYPE, effectiveAccountId);
}

/**
 * Load automations list and optionally fetch detailed info for each
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadAutomationsWithDetails(data, options) {
  const { includeDetails, logger, accountId, progress } = options;

  progress('automations', 0, 1, 'Loading automations list...');
  const automationsList = await getAutomations(logger, accountId).catch(err => {
    if (logger) logger.warn(`Failed to load automations: ${err.message}`);
    return [];
  });
  progress('automations', 1, 1, `Loaded ${automationsList.length} automations`);

  if (includeDetails && automationsList.length > 0) {
    progress('automation-details', 0, automationsList.length, 'Loading automation details...');

    const batchSize = config.concurrency.automationDetailsConcurrency;
    for (let i = 0; i < automationsList.length; i += batchSize) {
      const batch = automationsList.slice(i, i + batchSize);

      const detailsPromises = batch.map(async (auto) => {
        try {
          const details = await getAutomationDetails(auto.id, logger, accountId);
          return {
            id: details.id,
            name: details.name,
            key: details.key,
            description: details.description,
            status: details.status,
            statusId: details.statusId,
            categoryId: details.categoryId,
            createdDate: details.createdDate,
            modifiedDate: details.modifiedDate,
            lastRunTime: details.lastRunTime,
            lastRunInstanceId: details.lastRunInstanceId,
            steps: details.steps || [],
            activityIds: extractActivityIds(details.steps)
          };
        } catch (err) {
          if (logger) logger.debug('Failed to get details for automation ' + auto.id + ': ' + err.message);
          return {
            id: auto.id,
            name: auto.name,
            key: auto.key,
            status: auto.status,
            statusId: auto.statusId,
            steps: [],
            activityIds: [],
            _detailsError: err.message
          };
        }
      });

      const batchResults = await Promise.all(detailsPromises);
      data.automations.push(...batchResults);

      const loadedCount = Math.min(i + batchSize, automationsList.length);
      progress('automation-details', loadedCount, automationsList.length,
        'Loaded ' + loadedCount + '/' + automationsList.length + ' automation details');
    }

    for (const automation of data.automations) {
      data.automationsById.set(automation.id, automation);
    }
  } else {
    data.automations = automationsList;
    for (const automation of automationsList) {
      data.automationsById.set(automation.id, automation);
    }
  }
}

/**
 * Load filter activities and build lookup map
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadFilterActivities(data, options) {
  const { logger, accountId, progress } = options;

  progress('filters', 0, 1, 'Loading filter activities...');
  data.filterActivities = await getFilterActivities(logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load filter activities: ' + err.message);
    return [];
  });
  progress('filters', 1, 1, 'Loaded ' + data.filterActivities.length + ' filter activities');

  for (const filter of data.filterActivities) {
    const id = filter.filterActivityId || filter.id;
    if (id) data.filtersById.set(id, filter);
  }
}

/**
 * Load query activities with optional SQL text
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadQueryActivities(data, options) {
  const { includeQueryText, logger, accountId, progress } = options;

  progress('queries', 0, 1, 'Loading query activities...');
  data.queryActivities = await retrieveQueryDefinitions(logger, false, accountId).catch(err => {
    if (logger) logger.warn('Failed to load query activities: ' + err.message);
    return [];
  });
  progress('queries', 1, 1, 'Loaded ' + data.queryActivities.length + ' query activities');

  if (includeQueryText && data.queryActivities.length > 0) {
    await loadQueryTexts(data, { logger, accountId, progress });
  }
}

/**
 * Load SQL text for query activities
 * @param {object} data - Data object with queryActivities
 * @param {object} options - Loading options
 */
async function loadQueryTexts(data, options) {
  const { logger, accountId, progress } = options;

  progress('query-text', 0, data.queryActivities.length, 'Loading query SQL text (parallel)...');

  const queryIds = data.queryActivities.map(q => q.ObjectID).filter(Boolean);

  const queryByObjectId = new Map();
  for (const query of data.queryActivities) {
    if (query.ObjectID) {
      queryByObjectId.set(query.ObjectID, query);
    }
  }

  const batchSize = config.pagination.defaultPageSize;
  let loaded = 0;

  for (let i = 0; i < queryIds.length; i += batchSize) {
    const batch = queryIds.slice(i, i + batchSize);

    try {
      const queryTexts = await retrieveQueryTexts(batch, logger, config.concurrency.queryTextConcurrency, accountId);

      for (const [objectId, queryText] of queryTexts) {
        const query = queryByObjectId.get(objectId);
        if (query) {
          query.QueryText = queryText;
        }
      }

      loaded += batch.length;
      progress('query-text', loaded, queryIds.length,
        'Loaded ' + loaded + '/' + queryIds.length + ' query SQL texts');
    } catch (err) {
      if (logger) logger.warn('Failed to load QueryText batch: ' + err.message);
      loaded += batch.length;
    }
  }

  const withText = data.queryActivities.filter(q => q.QueryText).length;
  progress('query-text', queryIds.length, queryIds.length,
    'Loaded SQL for ' + withText + '/' + data.queryActivities.length + ' queries');
}

/**
 * Load import activities
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadImportActivities(data, options) {
  const { logger, accountId, progress } = options;

  progress('imports', 0, 1, 'Loading import activities...');
  data.importActivities = await retrieveImportDefinitions(logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load import activities: ' + err.message);
    return [];
  });
  progress('imports', 1, 1, 'Loaded ' + data.importActivities.length + ' import activities');
}

/**
 * Load triggered send definitions
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadTriggeredSends(data, options) {
  const { logger, accountId, progress } = options;

  progress('triggered-sends', 0, 1, 'Loading triggered sends...');
  data.triggeredSends = await retrieveTriggeredSendDefinitions(logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load triggered sends: ' + err.message);
    return [];
  });
  progress('triggered-sends', 1, 1, 'Loaded ' + data.triggeredSends.length + ' triggered sends');
}

/**
 * Load journeys
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadJourneys(data, options) {
  const { logger, accountId, progress } = options;

  progress('journeys', 0, 1, 'Loading journeys...');
  data.journeys = await getJourneys(logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load journeys: ' + err.message);
    return [];
  });
  progress('journeys', 1, 1, 'Loaded ' + data.journeys.length + ' journeys');
}

/**
 * Load data extract definitions
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadDataExtracts(data, options) {
  const { logger, accountId, progress } = options;

  progress('extracts', 0, 1, 'Loading data extracts...');
  data.dataExtracts = await getDataExtracts(logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load data extracts: ' + err.message);
    return [];
  });
  progress('extracts', 1, 1, 'Loaded ' + data.dataExtracts.length + ' data extracts');
}

/**
 * Load data extensions
 * @param {object} data - Data object to populate
 * @param {object} options - Loading options
 */
async function loadDataExtensions(data, options) {
  const { logger, accountId, progress } = options;

  progress('dataExtensions', 0, 1, 'Loading data extensions...');
  data.dataExtensions = await retrieveDataExtensions(null, logger, accountId).catch(err => {
    if (logger) logger.warn('Failed to load data extensions: ' + err.message);
    return [];
  });
  progress('dataExtensions', 1, 1, 'Loaded ' + data.dataExtensions.length + ' data extensions');
}

/**
 * Load all SFMC metadata for dependency analysis
 *
 * @param {object} options - Loading options
 * @param {object} options.logger - Logger instance
 * @param {function} options.onProgress - Progress callback (stage, current, total, message)
 * @param {boolean} options.forceRefresh - Force refresh even if cache is valid
 * @param {boolean} options.includeAutomationDetails - Load full automation details (slower but has lastRunTime)
 * @param {boolean} options.includeQueryText - Load SQL text for queries (needed for FROM/JOIN DE detection)
 * @param {string} options.accountId - Business Unit account ID (optional, defaults to config)
 * @returns {Promise<object>} All loaded data
 */
export async function loadAllSfmcData(options = {}) {
  const {
    logger = null,
    onProgress = null,
    forceRefresh = false,
    includeAutomationDetails = true,
    includeQueryText = true,
    accountId = null
  } = options;

  const effectiveAccountId = accountId || config.sfmc.accountId;
  const memoryCache = getMemoryCacheEntry(effectiveAccountId);

  const progress = (stage, current, total, message) => {
    if (onProgress) onProgress(stage, current, total, message);
    if (logger) logger.debug(`[${stage}] ${current}/${total}: ${message}`);
  };

  // Check in-memory cache first (fastest)
  // Store reference to avoid race condition where cache could be cleared between check and use
  const cachedData = memoryCache.data;
  const cachedAt = memoryCache.loadedAt;
  if (!forceRefresh && cachedData && cachedAt) {
    // Validate in-memory cache has all required fields
    const validation = validateCachedData(cachedData);
    if (validation.isValid) {
      if (logger) logger.debug(`Using in-memory bulk data cache for BU ${effectiveAccountId}`);
      if (onProgress) onProgress('cached', 1, 1, 'Using in-memory cached data');
      return cachedData;
    }
    // If invalid, clear memory cache and continue to file cache or fresh fetch
    if (logger) logger.debug(`In-memory cache missing fields: ${validation.missingFields.join(', ')}. Checking file cache...`);
    memoryCacheByAccount.set(effectiveAccountId, { data: null, loadedAt: null });
  }

  // Check file cache (unless force refresh)
  if (!forceRefresh) {
    const cached = await readCache(BULK_DATA_CACHE_TYPE, effectiveAccountId, {
      maxAgeMs: DEFAULT_CACHE_EXPIRY_MS
    });

    if (cached && cached.data) {
      // Validate that cached data has all required fields
      const validation = validateCachedData(cached.data);

      if (!validation.isValid) {
        // Cache is missing required fields (likely from older version)
        if (logger) {
          logger.info(`Cached data for BU ${effectiveAccountId} is missing fields: ${validation.missingFields.join(', ')}. Refreshing...`);
        }
        // Fall through to fetch fresh data
      } else {
        const info = await getCacheInfo(BULK_DATA_CACHE_TYPE, effectiveAccountId);
        if (logger) {
          logger.info(`Using cached bulk data for BU ${effectiveAccountId} (${info.ageString})`);
        }

        // Rebuild the Maps from cached data
        const data = rebuildMapsFromCache(cached.data);

        // Store in memory cache for this session
        memoryCacheByAccount.set(effectiveAccountId, {
          data: data,
          loadedAt: new Date()
        });

        if (onProgress) onProgress('cached', 1, 1, `Using cached data (${info.ageString})`);
        return data;
      }
    }
  }

  const data = {
    automations: [],
    automationsById: new Map(),
    filterActivities: [],
    filtersById: new Map(),
    queryActivities: [],
    importActivities: [],
    triggeredSends: [],
    journeys: [],
    dataExtracts: [],
    dataExtensions: [],
    loadedAt: new Date().toISOString()
  };

  // Step 1 & 2: Load automations with optional details
  await loadAutomationsWithDetails(data, {
    includeDetails: includeAutomationDetails,
    logger,
    accountId: effectiveAccountId,
    progress
  });

  // Step 3: Load filter activities
  await loadFilterActivities(data, { logger, accountId: effectiveAccountId, progress });

  // Step 4: Load query activities with optional SQL text
  await loadQueryActivities(data, {
    includeQueryText,
    logger,
    accountId: effectiveAccountId,
    progress
  });

  // Step 5: Load import activities
  await loadImportActivities(data, { logger, accountId: effectiveAccountId, progress });

  // Step 6: Load triggered sends
  await loadTriggeredSends(data, { logger, accountId: effectiveAccountId, progress });

  // Step 7: Load journeys
  await loadJourneys(data, { logger, accountId: effectiveAccountId, progress });

  // Step 8: Load data extracts
  await loadDataExtracts(data, { logger, accountId: effectiveAccountId, progress });

  // Step 9: Load data extensions
  await loadDataExtensions(data, { logger, accountId: effectiveAccountId, progress });

  // Save to file cache (Maps need to be converted for JSON serialization)
  const cacheData = {
    automations: data.automations,
    filterActivities: data.filterActivities,
    queryActivities: data.queryActivities,
    importActivities: data.importActivities,
    triggeredSends: data.triggeredSends,
    journeys: data.journeys,
    dataExtracts: data.dataExtracts,
    dataExtensions: data.dataExtensions,
    loadedAt: data.loadedAt
  };

  await writeCache(BULK_DATA_CACHE_TYPE, effectiveAccountId, cacheData, {
    itemCounts: {
      automations: data.automations.length,
      filterActivities: data.filterActivities.length,
      queryActivities: data.queryActivities.length,
      importActivities: data.importActivities.length,
      triggeredSends: data.triggeredSends.length,
      journeys: data.journeys.length,
      dataExtracts: data.dataExtracts.length,
      dataExtensions: data.dataExtensions.length
    }
  });

  // Update in-memory cache for this account
  memoryCacheByAccount.set(effectiveAccountId, {
    data: data,
    loadedAt: new Date()
  });

  // Summary
  if (logger) {
    logger.info('Bulk data loaded and cached for BU ' + effectiveAccountId + ': ' +
      data.dataExtensions.length + ' DEs, ' + data.automations.length + ' automations, ' +
      data.queryActivities.length + ' queries, ' + data.journeys.length + ' journeys');
  }

  return data;
}

/**
 * Rebuild Maps from cached data (Maps can't be JSON serialized)
 * @param {object} cachedData - Data from file cache
 * @returns {object} Data with Maps rebuilt
 */
function rebuildMapsFromCache(cachedData) {
  const data = {
    ...cachedData,
    automationsById: new Map(),
    filtersById: new Map()
  };

  // Rebuild automationsById map
  for (const automation of data.automations || []) {
    if (automation.id) {
      data.automationsById.set(automation.id, automation);
    }
  }

  // Rebuild filtersById map
  for (const filter of data.filterActivities || []) {
    const id = filter.filterActivityId || filter.id;
    if (id) {
      data.filtersById.set(id, filter);
    }
  }

  return data;
}

/**
 * Extract activity IDs from automation steps
 * @param {object[]} steps - Automation steps
 * @returns {string[]} Array of activity IDs
 */
function extractActivityIds(steps) {
  const ids = [];

  if (!steps || !Array.isArray(steps)) return ids;

  for (const step of steps) {
    if (step.activities && Array.isArray(step.activities)) {
      for (const activity of step.activities) {
        if (activity.activityObjectId) {
          ids.push(activity.activityObjectId);
        }
        if (activity.id) {
          ids.push(activity.id);
        }
      }
    }
  }

  return ids;
}

/**
 * Find which automations contain a specific activity (filter, query, etc.)
 *
 * @param {string} activityId - The activity ID to search for
 * @param {object} bulkData - Pre-loaded bulk data
 * @returns {object[]} Array of automations containing this activity
 */
export function findAutomationsContainingActivity(activityId, bulkData) {
  const matches = [];
  const idLower = activityId.toLowerCase();

  for (const automation of bulkData.automations) {
    // Check pre-extracted activity IDs first (fast)
    if (automation.activityIds && automation.activityIds.some(id => id.toLowerCase() === idLower)) {
      matches.push({
        id: automation.id,
        name: automation.name,
        status: automation.status,
        statusId: automation.statusId,
        lastRunTime: automation.lastRunTime,
        createdDate: automation.createdDate
      });
      continue;
    }

    // Fall back to searching steps if activityIds not available
    if (automation.steps) {
      for (const step of automation.steps) {
        if (step.activities) {
          for (const activity of step.activities) {
            if ((activity.activityObjectId && activity.activityObjectId.toLowerCase() === idLower) ||
                (activity.id && activity.id.toLowerCase() === idLower)) {
              matches.push({
                id: automation.id,
                name: automation.name,
                status: automation.status,
                statusId: automation.statusId,
                lastRunTime: automation.lastRunTime,
                createdDate: automation.createdDate,
                stepNumber: step.stepNumber || step.step,
                activityName: activity.name
              });
              break; // Only add automation once per activity match
            }
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Get summary statistics for loaded data
 * @param {object} bulkData - Pre-loaded bulk data
 * @returns {object} Summary statistics
 */
export function getBulkDataSummary(bulkData) {
  return {
    automations: bulkData.automations?.length || 0,
    filterActivities: bulkData.filterActivities?.length || 0,
    queryActivities: bulkData.queryActivities?.length || 0,
    importActivities: bulkData.importActivities?.length || 0,
    triggeredSends: bulkData.triggeredSends?.length || 0,
    journeys: bulkData.journeys?.length || 0,
    dataExtracts: bulkData.dataExtracts?.length || 0,
    dataExtensions: bulkData.dataExtensions?.length || 0,
    loadedAt: bulkData.loadedAt
  };
}

export default {
  loadAllSfmcData,
  clearBulkDataCache,
  getBulkDataCacheStatus,
  findAutomationsContainingActivity,
  getBulkDataSummary
};
