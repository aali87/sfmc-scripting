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
 * Uses file-based caching (24 hours) with in-memory cache for current session.
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
  retrieveTriggeredSendDefinitions
} from './sfmc-soap.js';
import { readCache, writeCache, clearCache, getCacheInfo } from './cache.js';
import config from '../config/index.js';
import { CACHE_CONFIG } from './utils.js';

// Cache type identifier
const BULK_DATA_CACHE_TYPE = 'bulk-data';

// Use shared cache expiry constant
const DEFAULT_CACHE_EXPIRY_MS = CACHE_CONFIG.DEFAULT_EXPIRY_MS;

// In-memory cache for current session (faster than file reads)
let memoryCache = {
  data: null,
  loadedAt: null
};

/**
 * Clear both in-memory and file-based bulk data cache
 * @param {object} logger - Logger instance
 */
export async function clearBulkDataCache(logger = null) {
  memoryCache = { data: null, loadedAt: null };
  const cleared = await clearCache(BULK_DATA_CACHE_TYPE, config.sfmc.accountId);
  if (logger) {
    logger.info('Bulk data cache cleared');
  }
  return cleared;
}

/**
 * Get cache status information
 * @returns {Promise<object>} Cache info
 */
export async function getBulkDataCacheStatus() {
  return getCacheInfo(BULK_DATA_CACHE_TYPE, config.sfmc.accountId);
}

/**
 * Load all SFMC metadata for dependency analysis
 *
 * @param {object} options - Loading options
 * @param {object} options.logger - Logger instance
 * @param {function} options.onProgress - Progress callback (stage, current, total, message)
 * @param {boolean} options.forceRefresh - Force refresh even if cache is valid
 * @param {boolean} options.includeAutomationDetails - Load full automation details (slower but has lastRunTime)
 * @param {boolean} options.includeQueryText - Load SQL text for queries (DISABLED - causes API issues with large datasets)
 * @returns {Promise<object>} All loaded data
 */
export async function loadAllSfmcData(options = {}) {
  const {
    logger = null,
    onProgress = null,
    forceRefresh = false,
    includeAutomationDetails = true,
    includeQueryText = true // Load SQL for queries (needed for FROM/JOIN DE detection)
  } = options;

  const accountId = config.sfmc.accountId;

  const progress = (stage, current, total, message) => {
    if (onProgress) onProgress(stage, current, total, message);
    if (logger) logger.debug(`[${stage}] ${current}/${total}: ${message}`);
  };

  // Check in-memory cache first (fastest)
  if (!forceRefresh && memoryCache.data && memoryCache.loadedAt) {
    if (logger) logger.debug('Using in-memory bulk data cache');
    if (onProgress) onProgress('cached', 1, 1, 'Using in-memory cached data');
    return memoryCache.data;
  }

  // Check file cache (unless force refresh)
  if (!forceRefresh) {
    const cached = await readCache(BULK_DATA_CACHE_TYPE, accountId, {
      maxAgeMs: DEFAULT_CACHE_EXPIRY_MS
    });

    if (cached && cached.data) {
      const info = await getCacheInfo(BULK_DATA_CACHE_TYPE, accountId);
      if (logger) {
        logger.info(`Using cached bulk data (${info.ageString})`);
      }

      // Rebuild the Maps from cached data
      const data = rebuildMapsFromCache(cached.data);

      // Store in memory cache for this session
      memoryCache = {
        data: data,
        loadedAt: new Date()
      };

      if (onProgress) onProgress('cached', 1, 1, `Using cached data (${info.ageString})`);
      return data;
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
    loadedAt: new Date().toISOString()
  };

  // Step 1: Load automations list
  progress('automations', 0, 1, 'Loading automations list...');
  const automationsList = await getAutomations(logger).catch(err => {
    if (logger) logger.warn(`Failed to load automations: ${err.message}`);
    return [];
  });
  progress('automations', 1, 1, `Loaded ${automationsList.length} automations`);

  // Step 2: Load full automation details (for lastRunTime, status, steps)
  // This is the slow part, but necessary for accurate analysis
  if (includeAutomationDetails && automationsList.length > 0) {
    progress('automation-details', 0, automationsList.length, 'Loading automation details...');

    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < automationsList.length; i += batchSize) {
      const batch = automationsList.slice(i, i + batchSize);

      // Load batch in parallel
      const detailsPromises = batch.map(async (auto) => {
        try {
          const details = await getAutomationDetails(auto.id, logger);
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
            // Extract activity IDs for quick lookup
            activityIds: extractActivityIds(details.steps)
          };
        } catch (err) {
          // Fall back to basic info if details fail
          if (logger) logger.debug(`Failed to get details for automation ${auto.id}: ${err.message}`);
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

      progress('automation-details', Math.min(i + batchSize, automationsList.length), automationsList.length,
        `Loaded ${Math.min(i + batchSize, automationsList.length)}/${automationsList.length} automation details`);
    }

    // Build lookup map
    for (const auto of data.automations) {
      data.automationsById.set(auto.id, auto);
    }
  } else {
    data.automations = automationsList;
    for (const auto of automationsList) {
      data.automationsById.set(auto.id, auto);
    }
  }

  // Step 3: Load filter activities
  progress('filters', 0, 1, 'Loading filter activities...');
  data.filterActivities = await getFilterActivities(logger).catch(err => {
    if (logger) logger.warn(`Failed to load filter activities: ${err.message}`);
    return [];
  });
  progress('filters', 1, 1, `Loaded ${data.filterActivities.length} filter activities`);

  // Build filter lookup map
  for (const filter of data.filterActivities) {
    const id = filter.filterActivityId || filter.id;
    if (id) data.filtersById.set(id, filter);
  }

  // Step 4: Load query activities (SOAP)
  progress('queries', 0, 1, 'Loading query activities...');
  data.queryActivities = await retrieveQueryDefinitions(logger).catch(err => {
    if (logger) logger.warn(`Failed to load query activities: ${err.message}`);
    return [];
  });
  progress('queries', 1, 1, `Loaded ${data.queryActivities.length} query activities`);

  // Step 4b: Load QueryText for queries (optional, slower but needed for SQL analysis)
  // Uses parallel requests with concurrency=10 - loads ~10 queries simultaneously
  if (includeQueryText && data.queryActivities.length > 0) {
    progress('query-text', 0, data.queryActivities.length, 'Loading query SQL text (parallel)...');

    const queryIds = data.queryActivities.map(q => q.ObjectID).filter(Boolean);

    // Build lookup map for faster query updates
    const queryByObjectId = new Map();
    for (const query of data.queryActivities) {
      if (query.ObjectID) {
        queryByObjectId.set(query.ObjectID, query);
      }
    }

    // Process in larger batches since retrieveQueryTexts now handles parallelism internally
    const batchSize = 500;
    let loaded = 0;

    for (let i = 0; i < queryIds.length; i += batchSize) {
      const batch = queryIds.slice(i, i + batchSize);

      try {
        // retrieveQueryTexts now processes in parallel with concurrency=10
        const queryTexts = await retrieveQueryTexts(batch, logger, 10);

        // Merge QueryText back into query objects using the lookup map
        for (const [objectId, queryText] of queryTexts) {
          const query = queryByObjectId.get(objectId);
          if (query) {
            query.QueryText = queryText;
          }
        }

        loaded += batch.length;
        progress('query-text', loaded, queryIds.length,
          `Loaded ${loaded}/${queryIds.length} query SQL texts`);
      } catch (err) {
        if (logger) logger.warn(`Failed to load QueryText batch: ${err.message}`);
        loaded += batch.length;
      }
    }

    const withText = data.queryActivities.filter(q => q.QueryText).length;
    progress('query-text', queryIds.length, queryIds.length,
      `Loaded SQL for ${withText}/${data.queryActivities.length} queries`);
  }

  // Step 5: Load import activities (SOAP)
  progress('imports', 0, 1, 'Loading import activities...');
  data.importActivities = await retrieveImportDefinitions(logger).catch(err => {
    if (logger) logger.warn(`Failed to load import activities: ${err.message}`);
    return [];
  });
  progress('imports', 1, 1, `Loaded ${data.importActivities.length} import activities`);

  // Step 6: Load triggered sends (SOAP)
  progress('triggered-sends', 0, 1, 'Loading triggered sends...');
  data.triggeredSends = await retrieveTriggeredSendDefinitions(logger).catch(err => {
    if (logger) logger.warn(`Failed to load triggered sends: ${err.message}`);
    return [];
  });
  progress('triggered-sends', 1, 1, `Loaded ${data.triggeredSends.length} triggered sends`);

  // Step 7: Load journeys
  progress('journeys', 0, 1, 'Loading journeys...');
  data.journeys = await getJourneys(logger).catch(err => {
    if (logger) logger.warn(`Failed to load journeys: ${err.message}`);
    return [];
  });
  progress('journeys', 1, 1, `Loaded ${data.journeys.length} journeys`);

  // Step 8: Load data extracts
  progress('extracts', 0, 1, 'Loading data extracts...');
  data.dataExtracts = await getDataExtracts(logger).catch(err => {
    if (logger) logger.warn(`Failed to load data extracts: ${err.message}`);
    return [];
  });
  progress('extracts', 1, 1, `Loaded ${data.dataExtracts.length} data extracts`);

  // Save to file cache (Maps need to be converted for JSON serialization)
  const cacheData = {
    automations: data.automations,
    filterActivities: data.filterActivities,
    queryActivities: data.queryActivities,
    importActivities: data.importActivities,
    triggeredSends: data.triggeredSends,
    journeys: data.journeys,
    dataExtracts: data.dataExtracts,
    loadedAt: data.loadedAt
  };

  await writeCache(BULK_DATA_CACHE_TYPE, accountId, cacheData, {
    itemCounts: {
      automations: data.automations.length,
      filterActivities: data.filterActivities.length,
      queryActivities: data.queryActivities.length,
      importActivities: data.importActivities.length,
      triggeredSends: data.triggeredSends.length,
      journeys: data.journeys.length,
      dataExtracts: data.dataExtracts.length
    }
  });

  // Update in-memory cache
  memoryCache = {
    data: data,
    loadedAt: new Date()
  };

  // Summary
  if (logger) {
    logger.info(`Bulk data loaded and cached: ${data.automations.length} automations, ` +
      `${data.filterActivities.length} filters, ${data.queryActivities.length} queries, ` +
      `${data.importActivities.length} imports, ${data.journeys.length} journeys`);
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
  for (const auto of data.automations || []) {
    if (auto.id) {
      data.automationsById.set(auto.id, auto);
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

  for (const auto of bulkData.automations) {
    // Check pre-extracted activity IDs first (fast)
    if (auto.activityIds && auto.activityIds.some(id => id.toLowerCase() === idLower)) {
      matches.push({
        id: auto.id,
        name: auto.name,
        status: auto.status,
        statusId: auto.statusId,
        lastRunTime: auto.lastRunTime,
        createdDate: auto.createdDate
      });
      continue;
    }

    // Fall back to searching steps if activityIds not available
    if (auto.steps) {
      for (const step of auto.steps) {
        if (step.activities) {
          for (const activity of step.activities) {
            if ((activity.activityObjectId && activity.activityObjectId.toLowerCase() === idLower) ||
                (activity.id && activity.id.toLowerCase() === idLower)) {
              matches.push({
                id: auto.id,
                name: auto.name,
                status: auto.status,
                statusId: auto.statusId,
                lastRunTime: auto.lastRunTime,
                createdDate: auto.createdDate,
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
    automations: bulkData.automations.length,
    filterActivities: bulkData.filterActivities.length,
    queryActivities: bulkData.queryActivities.length,
    importActivities: bulkData.importActivities.length,
    triggeredSends: bulkData.triggeredSends.length,
    journeys: bulkData.journeys.length,
    dataExtracts: bulkData.dataExtracts.length,
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
