/**
 * Dependency Service
 * Checks for dependencies on Data Extensions across SFMC
 */

import {
  retrieveTriggeredSendDefinitions,
  retrieveQueryDefinitions,
  retrieveImportDefinitions
} from './sfmc-soap.js';
import {
  getAutomations,
  getAutomationDetails,
  getJourneys,
  getJourneyDetails,
  getFilterActivities,
  getDataExtracts
} from './sfmc-rest.js';

// Cache for dependency data to avoid repeated API calls
let dependencyCache = {
  automations: null,
  journeys: null,
  triggeredSends: null,
  queryActivities: null,
  importActivities: null,
  filterActivities: null,
  dataExtracts: null,
  loadedAt: null
};

// Cache TTL (10 minutes - dependency checks can be slow)
const CACHE_TTL = 10 * 60 * 1000;

/**
 * Clear dependency cache
 */
export function clearDependencyCache() {
  dependencyCache = {
    automations: null,
    journeys: null,
    triggeredSends: null,
    queryActivities: null,
    importActivities: null,
    filterActivities: null,
    dataExtracts: null,
    loadedAt: null
  };
}

/**
 * Check if cache is valid
 * @returns {boolean}
 */
function isCacheValid() {
  return dependencyCache.loadedAt && (Date.now() - dependencyCache.loadedAt < CACHE_TTL);
}

/**
 * Load all dependency sources
 * @param {object} logger - Logger instance
 * @param {boolean} forceRefresh - Force refresh cache
 */
async function loadAllDependencies(logger = null, forceRefresh = false) {
  if (!forceRefresh && isCacheValid()) {
    if (logger) {
      logger.debug('Using cached dependency data');
    }
    return;
  }

  if (logger) {
    logger.info('Loading dependency data from SFMC (this may take a moment)...');
  }

  // Load all sources in parallel for speed
  const [
    automations,
    journeys,
    triggeredSends,
    queryActivities,
    importActivities,
    filterActivities,
    dataExtracts
  ] = await Promise.all([
    getAutomations(logger).catch(err => {
      if (logger) logger.debug(`Failed to load automations: ${err.message}`);
      return [];
    }),
    getJourneys(logger).catch(err => {
      if (logger) logger.debug(`Failed to load journeys: ${err.message}`);
      return [];
    }),
    retrieveTriggeredSendDefinitions(logger).catch(err => {
      if (logger) logger.debug(`Failed to load triggered sends: ${err.message}`);
      return [];
    }),
    retrieveQueryDefinitions(logger).catch(err => {
      if (logger) logger.debug(`Failed to load query activities: ${err.message}`);
      return [];
    }),
    retrieveImportDefinitions(logger).catch(err => {
      if (logger) logger.debug(`Failed to load import activities: ${err.message}`);
      return [];
    }),
    getFilterActivities(logger).catch(err => {
      if (logger) logger.debug(`Failed to load filter activities: ${err.message}`);
      return [];
    }),
    getDataExtracts(logger).catch(err => {
      if (logger) logger.debug(`Failed to load data extracts: ${err.message}`);
      return [];
    })
  ]);

  dependencyCache = {
    automations,
    journeys,
    triggeredSends,
    queryActivities,
    importActivities,
    filterActivities,
    dataExtracts,
    loadedAt: Date.now()
  };

  if (logger) {
    logger.debug(`Loaded: ${automations.length} automations, ${journeys.length} journeys, ` +
      `${triggeredSends.length} triggered sends, ${queryActivities.length} queries, ` +
      `${importActivities.length} imports`);
  }
}

/**
 * Search for DE reference in automation activities
 * @param {object} automation - Automation object
 * @param {string} deCustomerKey - DE CustomerKey to search for
 * @returns {object|null} Reference details if found
 */
function searchAutomationForDe(automation, deCustomerKey) {
  const keyLower = deCustomerKey.toLowerCase();
  const references = [];

  // Search in automation JSON (steps, activities, etc.)
  const searchObject = (obj, path = '') => {
    if (!obj) return;

    if (typeof obj === 'string') {
      if (obj.toLowerCase().includes(keyLower)) {
        references.push({ path, value: obj });
      }
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item, i) => searchObject(item, `${path}[${i}]`));
      return;
    }

    if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        searchObject(value, path ? `${path}.${key}` : key);
      }
    }
  };

  searchObject(automation);

  if (references.length > 0) {
    return {
      id: automation.id || automation.ObjectID,
      name: automation.name || automation.Name,
      status: automation.status || automation.Status,
      references
    };
  }

  return null;
}

/**
 * Search for DE reference in journey configuration
 * @param {object} journey - Journey object
 * @param {string} deCustomerKey - DE CustomerKey to search for
 * @returns {object|null} Reference details if found
 */
function searchJourneyForDe(journey, deCustomerKey) {
  const keyLower = deCustomerKey.toLowerCase();
  const references = [];

  // Search in journey JSON
  const searchObject = (obj, path = '') => {
    if (!obj) return;

    if (typeof obj === 'string') {
      if (obj.toLowerCase().includes(keyLower)) {
        references.push({ path, value: obj });
      }
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((item, i) => searchObject(item, `${path}[${i}]`));
      return;
    }

    if (typeof obj === 'object') {
      // Check specific journey fields
      const checkFields = ['dataExtensionId', 'dataExtensionKey', 'configurationArguments', 'outcomes'];
      for (const [key, value] of Object.entries(obj)) {
        searchObject(value, path ? `${path}.${key}` : key);
      }
    }
  };

  searchObject(journey);

  if (references.length > 0) {
    return {
      id: journey.id,
      name: journey.name,
      status: journey.status,
      version: journey.version,
      references
    };
  }

  return null;
}

/**
 * Check Automation Studio for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of automation dependencies
 */
export async function checkAutomationDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const automation of dependencyCache.automations) {
    // Check if automation contains reference to this DE
    const ref = searchAutomationForDe(automation, deCustomerKey);
    if (ref) {
      dependencies.push({
        type: 'Automation',
        id: ref.id,
        name: ref.name,
        status: ref.status,
        details: `Found in: ${ref.references.map(r => r.path).join(', ')}`
      });
    }
  }

  // Also check query activities specifically
  for (const query of dependencyCache.queryActivities) {
    const targetKey = query['DataExtensionTarget.CustomerKey'] ||
                     query.DataExtensionTarget?.CustomerKey;
    const targetName = query['DataExtensionTarget.Name'] ||
                      query.DataExtensionTarget?.Name;

    if (targetKey?.toLowerCase() === keyLower ||
        targetName?.toLowerCase() === keyLower) {
      dependencies.push({
        type: 'Query Activity',
        id: query.ObjectID,
        name: query.Name,
        status: query.Status,
        details: 'Used as query target'
      });
    }
  }

  return dependencies;
}

/**
 * Check Journey Builder for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of journey dependencies
 */
export async function checkJourneyDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];

  for (const journey of dependencyCache.journeys) {
    const ref = searchJourneyForDe(journey, deCustomerKey);
    if (ref) {
      dependencies.push({
        type: 'Journey',
        id: ref.id,
        name: ref.name,
        status: ref.status,
        version: ref.version,
        details: `Found in: ${ref.references.map(r => r.path).join(', ')}`
      });
    }
  }

  return dependencies;
}

/**
 * Check Triggered Send Definitions for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of TSD dependencies
 */
export async function checkTriggeredSendDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const tsd of dependencyCache.triggeredSends) {
    // Check sendable data extension reference
    const sendableField = tsd['SendableDataExtensionField.Name'] ||
                         tsd.SendableDataExtensionField?.Name;

    // TSD might reference DE in various ways
    const objString = JSON.stringify(tsd).toLowerCase();
    if (objString.includes(keyLower)) {
      dependencies.push({
        type: 'Triggered Send',
        id: tsd.ObjectID,
        name: tsd.Name,
        status: tsd.TriggeredSendStatus,
        details: 'Referenced in triggered send configuration'
      });
    }
  }

  return dependencies;
}

/**
 * Check Query Activities for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of query dependencies
 */
export async function checkQueryActivityDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const query of dependencyCache.queryActivities) {
    // Check target DE
    const targetKey = query['DataExtensionTarget.CustomerKey'] ||
                     query.DataExtensionTarget?.CustomerKey;
    const targetName = query['DataExtensionTarget.Name'] ||
                      query.DataExtensionTarget?.Name;

    let isTarget = false;
    let inSql = false;

    if (targetKey?.toLowerCase() === keyLower ||
        targetName?.toLowerCase() === keyLower) {
      isTarget = true;
    }

    // Check if DE is referenced in SQL (if available)
    if (query.QueryText) {
      const sqlLower = query.QueryText.toLowerCase();
      if (sqlLower.includes(keyLower)) {
        inSql = true;
      }
    }

    if (isTarget || inSql) {
      const details = [];
      if (isTarget) details.push('Target DE');
      if (inSql) details.push('Referenced in SQL');

      dependencies.push({
        type: 'Query Activity',
        id: query.ObjectID,
        name: query.Name,
        status: query.Status,
        details: details.join(', ')
      });
    }
  }

  return dependencies;
}

/**
 * Check Import Activities for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of import dependencies
 */
export async function checkImportActivityDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const imp of dependencyCache.importActivities) {
    // Check destination object
    const destKey = imp['DestinationObject.CustomerKey'] ||
                   imp.DestinationObject?.CustomerKey;
    const destId = imp['DestinationObject.ObjectID'] ||
                  imp.DestinationObject?.ObjectID;

    if (destKey?.toLowerCase() === keyLower) {
      dependencies.push({
        type: 'Import Activity',
        id: imp.ObjectID,
        name: imp.Name,
        status: imp.Status,
        details: 'Import destination'
      });
    }
  }

  return dependencies;
}

/**
 * Check Filter Activities for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of filter dependencies
 */
export async function checkFilterActivityDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const filter of dependencyCache.filterActivities) {
    // Search filter configuration for DE reference
    const configString = JSON.stringify(filter).toLowerCase();
    if (configString.includes(keyLower)) {
      dependencies.push({
        type: 'Filter Activity',
        id: filter.id || filter.filterId,
        name: filter.name,
        status: filter.status,
        details: 'Referenced in filter configuration'
      });
    }
  }

  return dependencies;
}

/**
 * Check Data Extract Activities for DE dependencies
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of extract dependencies
 */
export async function checkDataExtractDependencies(deCustomerKey, logger = null) {
  await loadAllDependencies(logger);

  const dependencies = [];
  const keyLower = deCustomerKey.toLowerCase();

  for (const extract of dependencyCache.dataExtracts) {
    const configString = JSON.stringify(extract).toLowerCase();
    if (configString.includes(keyLower)) {
      dependencies.push({
        type: 'Data Extract',
        id: extract.id || extract.dataExtractId,
        name: extract.name,
        status: extract.status,
        details: 'Referenced in data extract configuration'
      });
    }
  }

  return dependencies;
}

/**
 * Run all dependency checks for a Data Extension
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Consolidated dependency report
 */
export async function checkAllDependencies(deCustomerKey, logger = null) {
  // Load all dependency data once
  await loadAllDependencies(logger);

  // Run all checks in parallel
  const [
    automations,
    journeys,
    triggeredSends,
    queryActivities,
    importActivities,
    filterActivities,
    dataExtracts
  ] = await Promise.all([
    checkAutomationDependencies(deCustomerKey, logger),
    checkJourneyDependencies(deCustomerKey, logger),
    checkTriggeredSendDependencies(deCustomerKey, logger),
    checkQueryActivityDependencies(deCustomerKey, logger),
    checkImportActivityDependencies(deCustomerKey, logger),
    checkFilterActivityDependencies(deCustomerKey, logger),
    checkDataExtractDependencies(deCustomerKey, logger)
  ]);

  const allDependencies = [
    ...automations,
    ...journeys,
    ...triggeredSends,
    ...queryActivities,
    ...importActivities,
    ...filterActivities,
    ...dataExtracts
  ];

  // Deduplicate by type + id
  const seen = new Set();
  const uniqueDependencies = allDependencies.filter(dep => {
    const key = `${dep.type}:${dep.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    customerKey: deCustomerKey,
    hasDependencies: uniqueDependencies.length > 0,
    totalCount: uniqueDependencies.length,
    dependencies: {
      automations: automations,
      journeys: journeys,
      triggeredSends: triggeredSends,
      queryActivities: queryActivities,
      importActivities: importActivities,
      filterActivities: filterActivities,
      dataExtracts: dataExtracts
    },
    all: uniqueDependencies,
    summary: {
      automations: automations.length,
      journeys: journeys.length,
      triggeredSends: triggeredSends.length,
      queryActivities: queryActivities.length,
      importActivities: importActivities.length,
      filterActivities: filterActivities.length,
      dataExtracts: dataExtracts.length
    }
  };
}

/**
 * Batch check dependencies for multiple DEs
 * More efficient than calling checkAllDependencies for each
 * @param {string[]} customerKeys - Array of DE CustomerKeys
 * @param {object} logger - Logger instance
 * @param {function} onProgress - Progress callback (current, total, de)
 * @returns {Promise<Map<string, object>>} Map of CustomerKey to dependency report
 */
export async function batchCheckDependencies(customerKeys, logger = null, onProgress = null) {
  // Load all dependency data once
  await loadAllDependencies(logger, true); // Force refresh for batch

  const results = new Map();
  let current = 0;

  for (const key of customerKeys) {
    current++;
    if (onProgress) {
      onProgress(current, customerKeys.length, key);
    }

    // Since data is cached, these are fast
    const report = await checkAllDependencies(key, logger);
    results.set(key, report);
  }

  return results;
}

export default {
  clearDependencyCache,
  checkAutomationDependencies,
  checkJourneyDependencies,
  checkTriggeredSendDependencies,
  checkQueryActivityDependencies,
  checkImportActivityDependencies,
  checkFilterActivityDependencies,
  checkDataExtractDependencies,
  checkAllDependencies,
  batchCheckDependencies
};
