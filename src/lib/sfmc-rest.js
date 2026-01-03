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
 * @returns {Promise<axios.AxiosInstance>} Configured axios instance
 */
async function createApiClient(logger = null) {
  const tokenInfo = await getAccessToken(logger);

  return axios.create({
    baseURL: tokenInfo.restInstanceUrl || config.sfmc.restUrl,
    headers: {
      'Authorization': `Bearer ${tokenInfo.accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000
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
 * @returns {Promise<object>} API response data
 */
async function makeRequest(method, endpoint, data = null, params = null, logger = null, retryCount = 0) {
  const client = await createApiClient(logger);

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
      return makeRequest(method, endpoint, data, params, logger, retryCount + 1);
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
 * @returns {Promise<object[]>} All items across all pages
 */
async function getAllPages(endpoint, itemsKey, params = {}, logger = null) {
  const allItems = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const pageParams = {
      ...params,
      $page: page,
      $pageSize: 500
    };

    const response = await makeRequest('get', endpoint, null, pageParams, logger);

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
    } else if (items.length < (pageParams.$pageSize || 500)) {
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
export async function getAutomations(logger = null) {
  try {
    const automations = await getAllPages('/automation/v1/automations', 'items', {}, logger);

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
export async function getAutomationDetails(automationId, logger = null) {
  return makeRequest('get', `/automation/v1/automations/${automationId}`, null, null, logger);
}

/**
 * Get automation by name
 * @param {string} automationName - Automation name to search for
 * @param {object[]} automations - Pre-loaded automations (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Automation object or null if not found
 */
export async function getAutomationByName(automationName, automations = null, logger = null) {
  try {
    if (!automations) {
      automations = await getAutomations(logger);
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
export async function getAutomationWithMetadata(automationId, logger = null) {
  try {
    const automation = await getAutomationDetails(automationId, logger);

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
export async function deleteAutomation(automationId, logger = null) {
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
export async function getJourneys(logger = null) {
  try {
    // Journey API uses different pagination
    const allJourneys = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await makeRequest('get', '/interaction/v1/interactions', null, {
        $page: page,
        $pageSize: 100
      }, logger);

      const items = response.items || [];
      allJourneys.push(...items);

      hasMore = items.length === 100;
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
export async function getJourneyDetails(journeyId, logger = null) {
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
export async function getDataExtensionRowCount(deKey, logger = null) {
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
export async function getFilterActivities(logger = null) {
  try {
    const filters = await getAllPages('/automation/v1/filters', 'items', {}, logger);

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
export async function getFilterActivityDetails(filterId, logger = null) {
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
export async function deleteFilterActivity(filterId, logger = null) {
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
export async function checkFilterInAutomations(filterId, automations = null, logger = null) {
  try {
    // If automations not provided, fetch them
    if (!automations) {
      automations = await getAutomations(logger);
    }

    const usedIn = [];

    for (const automation of automations) {
      // Get full automation details to check activities
      let automationDetails;
      try {
        automationDetails = await getAutomationDetails(automation.id, logger);
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
              // Also check the activityObjectId matches
              if (activity.objectTypeId === 303 ||
                  activity.activityObjectId === filterId ||
                  (activity.id && activity.id === filterId)) {
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
export async function getDataExtracts(logger = null) {
  try {
    const extracts = await getAllPages('/automation/v1/dataextracts', 'items', {}, logger);

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
      timeout: 10000
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
  sendWebhook
};
