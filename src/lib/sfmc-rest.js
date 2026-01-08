/**
 * SFMC REST API Client
 * Handles REST API requests for Automations, Journeys, and other REST-only endpoints
 */

import axios from 'axios';
import { getAccessToken } from './sfmc-auth.js';
import config from '../config/index.js';
import {
  sleep,
  extractErrorMessage,
  isRetryableError,
  calculateBackoffDelay,
  RETRY_CONFIG
} from './utils.js';

const { MAX_RETRIES, RETRY_DELAY_MS } = RETRY_CONFIG;

/**
 * Create axios instance with auth headers
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<axios.AxiosInstance>} Configured axios instance
 */
async function createApiClient(logger = null, accountId = null) {
  const tokenInfo = await getAccessToken(logger, accountId);

  return axios.create({
    baseURL: tokenInfo.restInstanceUrl || config.sfmc.restUrl,
    headers: {
      'Authorization': `Bearer ${tokenInfo.accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: config.timeouts.restTimeoutMs
  });
}

/**
 * Make REST API request with retry logic
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint
 * @param {object} data - Request body (for POST/PUT)
 * @param {object} params - Query parameters
 * @param {object} logger - Logger instance
 * @param {number} retryCount - Current retry count
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object>} API response data
 */
async function makeRequest(method, endpoint, data = null, params = null, logger = null, retryCount = 0, accountId = null) {
  const client = await createApiClient(logger, accountId);

  if (logger) {
    logger.api(method.toUpperCase(), endpoint, { params });
  }

  try {
    const response = await client.request({
      method,
      url: endpoint,
      data,
      params
    });

    // Rate limit delay
    await sleep(config.safety.apiRateLimitDelayMs);

    return response.data;

  } catch (error) {
    // Handle retryable errors
    if (retryCount < MAX_RETRIES && isRetryableError(error)) {
      let delay = calculateBackoffDelay(retryCount);

      // Check for Retry-After header
      if (error.response && error.response.headers['retry-after']) {
        delay = parseInt(error.response.headers['retry-after'], 10) * 1000;
      }

      if (logger) {
        logger.warn(`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      }

      await sleep(delay);
      return makeRequest(method, endpoint, data, params, logger, retryCount + 1, accountId);
    }

    // Extract error message
    const errorMessage = extractErrorMessage(error);
    throw new Error(`REST API error [${method.toUpperCase()} ${endpoint}]: ${errorMessage}`);
  }
}

/**
 * Get all pages of a paginated endpoint
 * @param {string} endpoint - API endpoint
 * @param {string} itemsKey - Key containing items in response
 * @param {object} params - Additional query parameters
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object[]>} All items across all pages
 */
async function getAllPages(endpoint, itemsKey, params = {}, logger = null, accountId = null) {
  const allItems = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const pageParams = {
      ...params,
      $page: page,
      $pageSize: config.pagination.defaultPageSize
    };

    const response = await makeRequest('get', endpoint, null, pageParams, logger, 0, accountId);

    // Handle different response formats
    let items = [];
    if (response[itemsKey] && Array.isArray(response[itemsKey])) {
      items = response[itemsKey];
    } else if (Array.isArray(response.items)) {
      items = response.items;
    } else if (Array.isArray(response)) {
      items = response;
    }

    allItems.push(...items);

    // Check for more pages
    if (response.page && response.pageSize && response.count) {
      hasMore = (response.page * response.pageSize) < response.count;
    } else if (items.length === 0) {
      hasMore = false;
    } else if (items.length < (pageParams.$pageSize || config.pagination.defaultPageSize)) {
      hasMore = false;
    }

    page++;

    if (logger) {
      logger.debug(`Fetched page ${page - 1}: ${items.length} items (total: ${allItems.length})`);
    }
  }

  return allItems;
}

// =============================================================================
// Automation Studio APIs
// =============================================================================

/**
 * Get all automations
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of automation objects
 */
export async function getAutomations(logger = null, accountId = null) {
  try {
    const automations = await getAllPages('/automation/v1/automations', 'items', {}, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${automations.length} automations`);
    }

    return automations;
  } catch (error) {
    if (logger) {
      logger.error(`Failed to retrieve automations: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get automation details by ID
 * @param {string} automationId - Automation ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Automation details
 */
export async function getAutomationDetails(automationId, logger = null, accountId = null) {
  return makeRequest('get', `/automation/v1/automations/${automationId}`, null, null, logger);
}

/**
 * Get automation by name
 * @param {string} automationName - Automation name to search for
 * @param {object[]} automations - Pre-loaded automations (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Automation object or null if not found
 */
export async function getAutomationByName(automationName, automations = null, logger = null, accountId = null) {
  try {
    if (!automations) {
      automations = await getAutomations(logger, accountId);
    }

    const nameLower = automationName.toLowerCase().trim();
    const automation = automations.find(a =>
      a.name && a.name.toLowerCase().trim() === nameLower
    );

    return automation || null;
  } catch (error) {
    if (logger) {
      logger.debug(`Error finding automation by name: ${error.message}`);
    }
    return null;
  }
}

/**
 * Get automation with full metadata including last run info
 * Returns: id, name, description, status, createdDate, modifiedDate, lastRunTime, lastRunInstanceId
 * @param {string} automationId - Automation ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Automation with full metadata
 */
export async function getAutomationWithMetadata(automationId, logger = null, accountId = null) {
  try {
    const automation = await getAutomationDetails(automationId, logger, accountId);

    // The REST API returns these fields directly:
    // - createdDate
    // - modifiedDate
    // - lastRunTime
    // - lastRunInstanceId
    // - status/statusId

    return {
      id: automation.id,
      name: automation.name,
      description: automation.description,
      key: automation.key,
      status: automation.status,
      statusId: automation.statusId,
      createdDate: automation.createdDate,
      modifiedDate: automation.modifiedDate,
      lastRunTime: automation.lastRunTime,
      lastRunInstanceId: automation.lastRunInstanceId,
      categoryId: automation.categoryId,
      steps: automation.steps,
      // Full object for backup purposes
      _raw: automation
    };
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to get automation metadata for ${automationId}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Delete an automation
 * Note: This uses an undocumented endpoint - use with caution
 * @param {string} automationId - Automation ID
 * @param {object} logger - Logger instance
 * @returns {Promise<{success: boolean, error?: string}>} Deletion result
 */
export async function deleteAutomation(automationId, logger = null, accountId = null) {
  try {
    await makeRequest('delete', `/automation/v1/automations/${automationId}`, null, null, logger);

    if (logger) {
      logger.info(`Successfully deleted automation: ${automationId}`);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';

    if (logger) {
      logger.error(`Failed to delete automation ${automationId}: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Backup automation configuration to JSON
 * @param {object} automation - Full automation object
 * @returns {object} Backup data structure
 */
export function createAutomationBackup(automation) {
  return {
    backupDate: new Date().toISOString(),
    automationId: automation.id,
    automationName: automation.name,
    automationKey: automation.key,
    configuration: automation._raw || automation
  };
}

// =============================================================================
// Journey Builder APIs
// =============================================================================

/**
 * Get all journeys
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of journey objects
 */
export async function getJourneys(logger = null, accountId = null) {
  try {
    // Journey API uses different pagination
    const allJourneys = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await makeRequest('get', '/interaction/v1/interactions', null, {
        $page: page,
        $pageSize: config.pagination.journeyPageSize
      }, logger);

      const items = response.items || [];
      allJourneys.push(...items);

      hasMore = items.length === config.pagination.journeyPageSize;
      page++;
    }

    if (logger) {
      logger.debug(`Retrieved ${allJourneys.length} journeys`);
    }

    return allJourneys;
  } catch (error) {
    if (logger) {
      logger.error(`Failed to retrieve journeys: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get journey details by ID
 * @param {string} journeyId - Journey ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Journey details
 */
export async function getJourneyDetails(journeyId, logger = null, accountId = null) {
  return makeRequest('get', `/interaction/v1/interactions/${journeyId}`, null, null, logger);
}

// =============================================================================
// Data Extension Row Count API
// =============================================================================

/**
 * Get row count for a Data Extension
 * @param {string} deKey - Data Extension CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<number>} Row count
 */
export async function getDataExtensionRowCount(deKey, logger = null, accountId = null) {
  try {
    // Use the rowset endpoint with count
    const response = await makeRequest('get', `/data/v1/customobjectdata/key/${encodeURIComponent(deKey)}/rowset`, null, {
      $pageSize: 1
    }, logger);

    // The count is in the response
    return response.count || 0;
  } catch (error) {
    // If DE doesn't exist or no access, return 0
    if (error.message.includes('404') || error.message.includes('Not Found')) {
      return 0;
    }

    // Try alternative method using data extension endpoint
    try {
      const response = await makeRequest('get', `/data/v1/customobjectdata/key/${encodeURIComponent(deKey)}`, null, null, logger);
      return response.count || 0;
    } catch (altError) {
      if (logger) {
        logger.debug(`Could not get row count for ${deKey}: ${altError.message}`);
      }
      return null; // null indicates count unavailable
    }
  }
}

// =============================================================================
// Filter Activity APIs
// =============================================================================

/**
 * Get all filter activities
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of filter activity objects
 */
export async function getFilterActivities(logger = null, accountId = null) {
  try {
    const filters = await getAllPages('/automation/v1/filters', 'items', {}, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${filters.length} filter activities`);
    }

    return filters;
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to retrieve filter activities: ${error.message}`);
    }
    return []; // Filters may not be accessible, return empty
  }
}

/**
 * Get filter activity details by ID
 * @param {string} filterId - Filter Activity ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Filter details or null if not found
 */
export async function getFilterActivityDetails(filterId, logger = null, accountId = null) {
  try {
    return await makeRequest('get', `/automation/v1/filters/${filterId}`, null, null, logger);
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to get filter details for ${filterId}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Delete a filter activity
 * Note: This uses an undocumented endpoint following the same pattern as queries
 * @param {string} filterId - Filter Activity ID
 * @param {object} logger - Logger instance
 * @returns {Promise<{success: boolean, error?: string}>} Deletion result
 */
export async function deleteFilterActivity(filterId, logger = null, accountId = null) {
  try {
    await makeRequest('delete', `/automation/v1/filters/${filterId}`, null, null, logger);

    if (logger) {
      logger.info(`Successfully deleted filter activity: ${filterId}`);
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';

    if (logger) {
      logger.error(`Failed to delete filter activity ${filterId}: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Check if a filter activity is used in any automation
 * @param {string} filterId - Filter Activity ID
 * @param {object[]} automations - Array of automation objects (pre-loaded)
 * @param {object} logger - Logger instance
 * @returns {Promise<{isUsed: boolean, automations: object[]}>} Usage info
 */
export async function checkFilterInAutomations(filterId, automations = null, logger = null, accountId = null) {
  try {
    // If automations not provided, fetch them
    if (!automations) {
      automations = await getAutomations(logger, accountId);
    }

    const usedIn = [];

    for (const automation of automations) {
      // Get full automation details to check activities
      let automationDetails;
      try {
        automationDetails = await getAutomationDetails(automation.id, logger, accountId);
      } catch (e) {
        // Skip if can't get details
        continue;
      }

      // Search for filter activity in automation steps
      if (automationDetails.steps) {
        for (const step of automationDetails.steps) {
          if (step.activities) {
            for (const activity of step.activities) {
              // Filter activities have objectTypeId 303
              // Must check BOTH objectTypeId AND activityObjectId to avoid false positives
              const isFilterActivity = activity.objectTypeId === 303;
              const matchesFilterId = activity.activityObjectId === filterId ||
                  (activity.id && activity.id === filterId);
              if (isFilterActivity && matchesFilterId) {
                usedIn.push({
                  automationId: automation.id,
                  automationName: automation.name,
                  automationStatus: automation.status,
                  stepNumber: step.stepNumber || step.step,
                  activityName: activity.name
                });
              }
            }
          }
        }
      }
    }

    return {
      isUsed: usedIn.length > 0,
      automations: usedIn
    };
  } catch (error) {
    if (logger) {
      logger.debug(`Error checking filter in automations: ${error.message}`);
    }
    // Return false on error to be safe (don't delete if unsure)
    return { isUsed: false, automations: [], error: error.message };
  }
}

// =============================================================================
// Data Extract APIs
// =============================================================================

/**
 * Get all data extract activities
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of data extract objects
 */
export async function getDataExtracts(logger = null, accountId = null) {
  try {
    const extracts = await getAllPages('/automation/v1/dataextracts', 'items', {}, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${extracts.length} data extract activities`);
    }

    return extracts;
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to retrieve data extracts: ${error.message}`);
    }
    return [];
  }
}

// =============================================================================
// Webhook Helper
// =============================================================================

/**
 * Send webhook notification
 * @param {string} url - Webhook URL
 * @param {object} payload - Data to send
 * @param {object} logger - Logger instance
 * @returns {Promise<boolean>} Success status
 */
export async function sendWebhook(url, payload, logger = null) {
  if (!url) {
    return false;
  }

  try {
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.timeouts.webhookTimeoutMs
    });

    if (logger) {
      logger.debug('Webhook notification sent successfully');
    }

    return true;
  } catch (error) {
    if (logger) {
      logger.warn(`Webhook notification failed: ${error.message}`);
    }
    return false;
  }
}

// =============================================================================
// File Transfer APIs
// =============================================================================

/**
 * Get all file transfer activities
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object[]>} Array of file transfer objects
 */
export async function getFileTransfers(logger = null, accountId = null) {
  try {
    const transfers = await getAllPages('/automation/v1/filetransfers', 'items', {}, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${transfers.length} file transfer activities`);
    }

    return transfers;
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to retrieve file transfers: ${error.message}`);
    }
    return [];
  }
}

/**
 * Get file transfer details by ID
 * @param {string} fileTransferId - File Transfer Activity ID
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object|null>} File transfer details or null if not found
 */
export async function getFileTransferDetails(fileTransferId, logger = null, accountId = null) {
  try {
    return await makeRequest('get', `/automation/v1/filetransfers/${fileTransferId}`, null, null, logger);
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to get file transfer details for ${fileTransferId}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Update a file transfer activity
 * @param {string} fileTransferId - File Transfer Activity ID
 * @param {object} updates - Fields to update (e.g., { fileNamePattern: 'new_file.csv' })
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<{success: boolean, data?: object, error?: string}>} Update result
 */
export async function updateFileTransfer(fileTransferId, updates, logger = null, accountId = null) {
  try {
    const result = await makeRequest('patch', `/automation/v1/filetransfers/${fileTransferId}`, updates, null, logger);

    if (logger) {
      logger.info(`Successfully updated file transfer: ${fileTransferId}`);
    }

    return { success: true, data: result };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';

    if (logger) {
      logger.error(`Failed to update file transfer ${fileTransferId}: ${errorMessage}`);
    }

    return { success: false, error: errorMessage };
  }
}

// =============================================================================
// Import Definition APIs
// =============================================================================

/**
 * Get all import definitions via REST API
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object[]>} Array of import definition objects
 */
export async function getImports(logger = null, accountId = null) {
  try {
    const imports = await getAllPages('/automation/v1/imports', 'items', {}, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${imports.length} import definitions`);
    }

    return imports;
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to retrieve imports: ${error.message}`);
    }
    return [];
  }
}

/**
 * Get import definition details by ID
 * @param {string} importId - Import Definition ID
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object|null>} Import details or null if not found
 */
export async function getImportDetails(importId, logger = null, accountId = null) {
  try {
    return await makeRequest('get', `/automation/v1/imports/${importId}`, null, null, logger);
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to get import details for ${importId}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Update an import definition
 * @param {string} importId - Import Definition ID
 * @param {object} updates - Fields to update (e.g., { destinationObjectId: 'DE_Key', fileSpec: 'file.csv' })
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<{success: boolean, data?: object, error?: string}>} Update result
 */
export async function updateImport(importId, updates, logger = null, accountId = null) {
  try {
    const result = await makeRequest('patch', `/automation/v1/imports/${importId}`, updates, null, logger);

    if (logger) {
      logger.info(`Successfully updated import definition: ${importId}`);
    }

    return { success: true, data: result };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';

    if (logger) {
      logger.error(`Failed to update import ${importId}: ${errorMessage}`);
    }

    return { success: false, error: errorMessage };
  }
}

// =============================================================================
// Automation Execution APIs
// =============================================================================

/**
 * Trigger an automation to run once
 * @param {string} automationId - Automation ID
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<{success: boolean, data?: object, error?: string}>} Trigger result
 */
export async function runAutomationOnce(automationId, logger = null, accountId = null) {
  try {
    const result = await makeRequest('post', `/automation/v1/automations/${automationId}/actions/runallonce`, null, null, logger);

    if (logger) {
      logger.info(`Successfully triggered automation: ${automationId}`);
    }

    return { success: true, data: result };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';

    if (logger) {
      logger.error(`Failed to trigger automation ${automationId}: ${errorMessage}`);
    }

    return { success: false, error: errorMessage };
  }
}

// =============================================================================
// Content Builder / CloudPages APIs
// =============================================================================

/**
 * Query Content Builder assets with filters
 * @param {object} queryPayload - Query payload with filters
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object[]>} Array of asset objects
 */
export async function queryAssets(queryPayload, logger = null, accountId = null) {
  try {
    const allAssets = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const payload = {
        ...queryPayload,
        page: {
          page: page,
          pageSize: 50
        }
      };

      const response = await makeRequest('post', '/asset/v1/content/assets/query', payload, null, logger);

      if (response.items && Array.isArray(response.items)) {
        allAssets.push(...response.items);
      }

      // Check if more pages exist
      if (response.count && response.page) {
        const totalPages = Math.ceil(response.count / (response.pageSize || 50));
        hasMore = page < totalPages;
      } else {
        hasMore = response.items && response.items.length === 50;
      }

      page++;

      if (logger) {
        logger.debug(`Fetched asset page ${page - 1}: ${response.items?.length || 0} items (total: ${allAssets.length})`);
      }
    }

    return allAssets;
  } catch (error) {
    if (logger) {
      logger.error(`Failed to query assets: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get all CloudPages (Landing Pages) in the Business Unit
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object[]>} Array of CloudPage asset objects
 */
export async function getCloudPages(logger = null, accountId = null) {
  const queryPayload = {
    query: {
      leftOperand: {
        property: 'assetType.id',
        simpleOperator: 'equal',
        value: 205
      },
      logicalOperator: 'OR',
      rightOperand: {
        property: 'assetType.id',
        simpleOperator: 'equal',
        value: 247
      }
    },
    fields: [
      'id', 'customerKey', 'objectID', 'assetType', 'name', 'description',
      'content', 'views', 'createdDate', 'createdBy', 'modifiedDate', 'modifiedBy',
      'status', 'category', 'data', 'meta'
    ],
    sort: [{ property: 'modifiedDate', direction: 'DESC' }]
  };

  try {
    const assets = await queryAssets(queryPayload, logger, accountId);

    if (logger) {
      logger.debug(`Retrieved ${assets.length} CloudPages`);
    }

    return assets;
  } catch (error) {
    if (logger) {
      logger.error(`Failed to retrieve CloudPages: ${error.message}`);
    }
    return [];
  }
}

/**
 * Get CloudPage details by ID including full content
 * @param {string|number} assetId - Asset ID
 * @param {object} logger - Logger instance
 * @param {string} accountId - Business Unit account ID (optional)
 * @returns {Promise<object|null>} CloudPage details or null if not found
 */
export async function getCloudPageDetails(assetId, logger = null, accountId = null) {
  try {
    return await makeRequest('get', `/asset/v1/content/assets/${assetId}`, null, null, logger);
  } catch (error) {
    if (logger) {
      logger.debug(`Failed to get CloudPage details for ${assetId}: ${error.message}`);
    }
    return null;
  }
}

export default {
  getAutomations,
  getAutomationDetails,
  getAutomationByName,
  getAutomationWithMetadata,
  deleteAutomation,
  createAutomationBackup,
  getJourneys,
  getJourneyDetails,
  getDataExtensionRowCount,
  getFilterActivities,
  getFilterActivityDetails,
  deleteFilterActivity,
  checkFilterInAutomations,
  getDataExtracts,
  sendWebhook,
  getFileTransfers,
  getFileTransferDetails,
  updateFileTransfer,
  getImports,
  getImportDetails,
  updateImport,
  runAutomationOnce,
  queryAssets,
  getCloudPages,
  getCloudPageDetails
};
