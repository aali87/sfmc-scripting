/**
 * Dependency Analyzer Service
 *
 * Smart dependency analysis that:
 * 1. Bulk loads all SFMC metadata upfront (efficient)
 * 2. Deduplicates dependencies across multiple DEs
 * 3. Classifies dependencies as safe-to-delete or requires-review
 * 4. Provides actionable recommendations
 *
 * Uses the bulk data loader for efficiency - no repeated API calls during analysis.
 */

import { loadAllSfmcData, findAutomationsContainingActivity } from './bulk-data-loader.js';
import dayjs from 'dayjs';

// Default staleness threshold (1 year)
const DEFAULT_STALE_DAYS = 365;

/**
 * Dependency classification types
 */
export const DependencyClassification = {
  SAFE_TO_DELETE: 'safe_to_delete',
  REQUIRES_REVIEW: 'requires_review',
  UNKNOWN: 'unknown'
};

/**
 * Reasons for classification
 */
export const ClassificationReason = {
  STALE_AUTOMATION: 'Automation has not run in over a year',
  INACTIVE_AUTOMATION: 'Automation is inactive/paused',
  STANDALONE_FILTER: 'Filter is not used in any automation',
  ACTIVE_AUTOMATION: 'Automation is active and recently used',
  FILTER_IN_ACTIVE_AUTOMATION: 'Filter is used in an active automation',
  FILTER_IN_STALE_AUTOMATION: 'Filter only used in stale automations',
  NO_METADATA: 'Could not retrieve metadata to assess',
  NEVER_RUN: 'Automation has never been run',
  QUERY_ACTIVITY: 'Query Activity requires manual review',
  IMPORT_ACTIVITY: 'Import Activity requires manual review',
  TRIGGERED_SEND: 'Triggered Send requires manual review',
  DATA_EXTRACT: 'Data Extract requires manual review',
  JOURNEY: 'Journey requires manual review'
};

/**
 * Analyze dependencies for a list of Data Extensions
 * Returns a deduplicated, enriched dependency report
 *
 * @param {object[]} dataExtensions - Array of DE objects with {customerKey, objectId, name}
 * @param {object} options - Analysis options
 * @param {number} options.staleDays - Days without activity to consider stale (default: 365)
 * @param {object} options.logger - Logger instance
 * @param {function} options.onProgress - Progress callback (stage, current, total, message)
 * @param {boolean} options.forceRefresh - Force refresh of cached data
 * @returns {Promise<object>} Analysis report
 */
export async function analyzeDependencies(dataExtensions, options = {}) {
  const {
    staleDays = DEFAULT_STALE_DAYS,
    logger = null,
    onProgress = null,
    forceRefresh = false
  } = options;

  const staleThreshold = dayjs().subtract(staleDays, 'day');

  // Progress tracking
  const progress = (stage, current, total, message) => {
    if (onProgress) onProgress(stage, current, total, message);
    if (logger) logger.debug(`[${stage}] ${current}/${total}: ${message}`);
  };

  // Step 1: Bulk load ALL SFMC data upfront
  progress('loading', 0, 1, 'Loading all SFMC metadata (this may take a moment)...');

  const bulkData = await loadAllSfmcData({
    logger,
    onProgress: (stage, current, total, message) => {
      progress(`loading-${stage}`, current, total, message);
    },
    includeAutomationDetails: true,
    forceRefresh
  });

  progress('loading', 1, 1, 'All metadata loaded');

  // Step 2: Scan each DE for dependencies using the pre-loaded data
  const rawDependencies = [];
  const deCount = dataExtensions.length;

  for (let i = 0; i < deCount; i++) {
    const de = dataExtensions[i];
    progress('scanning', i + 1, deCount, `Scanning ${de.name || de.customerKey}`);

    const deps = findDependenciesForDe(de, bulkData);

    // Add DE reference to each dependency
    for (const dep of deps) {
      rawDependencies.push({
        ...dep,
        affectedDe: {
          customerKey: de.customerKey,
          objectId: de.objectId,
          name: de.name
        }
      });
    }
  }

  // Step 3: Deduplicate dependencies
  // Key by type + id to group affected DEs
  const dependencyMap = new Map();

  for (const dep of rawDependencies) {
    const key = `${dep.type}:${dep.id}`;

    if (!dependencyMap.has(key)) {
      dependencyMap.set(key, {
        type: dep.type,
        id: dep.id,
        name: dep.name,
        status: dep.status,
        details: dep.details,
        rawData: dep.rawData,
        affectedDes: []
      });
    }

    const entry = dependencyMap.get(key);
    // Add affected DE if not already in list
    const alreadyHasDe = entry.affectedDes.some(
      d => d.customerKey === dep.affectedDe.customerKey
    );
    if (!alreadyHasDe) {
      entry.affectedDes.push(dep.affectedDe);
    }
  }

  // Step 4: Classify each unique dependency (no API calls - using pre-loaded data)
  const uniqueDeps = Array.from(dependencyMap.values());
  const enrichedDependencies = [];

  for (let i = 0; i < uniqueDeps.length; i++) {
    const dep = uniqueDeps[i];
    progress('classifying', i + 1, uniqueDeps.length, `Classifying ${dep.name}`);

    const enriched = classifyDependency(dep, bulkData, staleThreshold);
    enrichedDependencies.push(enriched);
  }

  // Step 5: Categorize results
  const safeToDelete = enrichedDependencies.filter(
    d => d.classification === DependencyClassification.SAFE_TO_DELETE
  );
  const requiresReview = enrichedDependencies.filter(
    d => d.classification === DependencyClassification.REQUIRES_REVIEW
  );
  const unknown = enrichedDependencies.filter(
    d => d.classification === DependencyClassification.UNKNOWN
  );

  // Build summary
  const summary = {
    totalDes: dataExtensions.length,
    totalRawDependencies: rawDependencies.length,
    uniqueDependencies: enrichedDependencies.length,
    safeToDelete: safeToDelete.length,
    requiresReview: requiresReview.length,
    unknown: unknown.length,
    byType: {}
  };

  // Count by type
  for (const dep of enrichedDependencies) {
    if (!summary.byType[dep.type]) {
      summary.byType[dep.type] = { total: 0, safeToDelete: 0, requiresReview: 0 };
    }
    summary.byType[dep.type].total++;
    if (dep.classification === DependencyClassification.SAFE_TO_DELETE) {
      summary.byType[dep.type].safeToDelete++;
    } else if (dep.classification === DependencyClassification.REQUIRES_REVIEW) {
      summary.byType[dep.type].requiresReview++;
    }
  }

  return {
    summary,
    safeToDelete,
    requiresReview,
    unknown,
    all: enrichedDependencies,
    // Preserve the DE -> dependency mapping for reference
    deMapping: buildDeMapping(rawDependencies),
    // Include data load summary
    dataLoadSummary: {
      automations: bulkData.automations.length,
      filterActivities: bulkData.filterActivities.length,
      queryActivities: bulkData.queryActivities.length,
      importActivities: bulkData.importActivities.length,
      triggeredSends: bulkData.triggeredSends.length,
      journeys: bulkData.journeys.length,
      dataExtracts: bulkData.dataExtracts.length
    }
  };
}

/**
 * Find all dependencies for a single DE using pre-loaded bulk data
 * No API calls - pure in-memory search
 *
 * @param {object} de - Data Extension with {customerKey, objectId, name}
 * @param {object} bulkData - Pre-loaded SFMC data
 * @returns {object[]} Array of dependencies
 */
function findDependenciesForDe(de, bulkData) {
  const dependencies = [];
  const keyLower = de.customerKey.toLowerCase();
  const nameLower = de.name ? de.name.toLowerCase() : null;
  const objectIdLower = de.objectId ? de.objectId.toLowerCase() : null;

  // 1. Check Filter Activities (by ObjectID - most accurate)
  for (const filter of bulkData.filterActivities) {
    let isMatch = false;
    let matchType = '';

    // Primary: Check sourceObjectId and destinationObjectId
    if (objectIdLower) {
      if (filter.sourceObjectId && filter.sourceObjectId.toLowerCase() === objectIdLower) {
        isMatch = true;
        matchType = 'Source DE';
      }
      if (filter.destinationObjectId && filter.destinationObjectId.toLowerCase() === objectIdLower) {
        isMatch = true;
        matchType = matchType ? 'Source & Destination DE' : 'Destination DE';
      }
    }

    if (isMatch) {
      dependencies.push({
        type: 'Filter Activity',
        id: filter.filterActivityId || filter.id,
        name: filter.name,
        status: filter.statusId === 1 ? 'Active' : `Status ${filter.statusId}`,
        details: matchType,
        rawData: {
          filterActivityId: filter.filterActivityId,
          sourceObjectId: filter.sourceObjectId,
          destinationObjectId: filter.destinationObjectId,
          customerKey: filter.customerKey,
          createdDate: filter.createdDate,
          modifiedDate: filter.modifiedDate
        }
      });
    }
  }

  // 2. Check Query Activities (by CustomerKey/Name in target or SQL)
  for (const query of bulkData.queryActivities) {
    const targetKey = query['DataExtensionTarget.CustomerKey'] || query.DataExtensionTarget?.CustomerKey;
    const targetName = query['DataExtensionTarget.Name'] || query.DataExtensionTarget?.Name;

    let isMatch = false;
    let matchDetails = [];

    // Check if this DE is the query target
    if (targetKey?.toLowerCase() === keyLower || targetName?.toLowerCase() === keyLower) {
      isMatch = true;
      matchDetails.push('Query Target');
    }
    if (nameLower && targetName?.toLowerCase() === nameLower) {
      isMatch = true;
      if (!matchDetails.includes('Query Target')) matchDetails.push('Query Target');
    }

    // Check SQL for DE reference (by CustomerKey or Name)
    // SQL typically uses DE Name like: FROM [DE_Name] or JOIN [DE_Name]
    if (query.QueryText) {
      const sqlLower = query.QueryText.toLowerCase();
      if (sqlLower.includes(keyLower)) {
        isMatch = true;
        matchDetails.push('Referenced in SQL (by Key)');
      }
      if (nameLower && sqlLower.includes(nameLower)) {
        isMatch = true;
        matchDetails.push('Referenced in SQL (by Name)');
      }
    }

    if (isMatch) {
      dependencies.push({
        type: 'Query Activity',
        id: query.ObjectID,
        name: query.Name,
        status: query.Status,
        details: matchDetails.join(', '),
        rawData: {
          objectId: query.ObjectID,
          customerKey: query.CustomerKey,
          targetDeKey: targetKey,
          createdDate: query.CreatedDate,
          modifiedDate: query.ModifiedDate
        }
      });
    }
  }

  // 3. Check Import Activities
  for (const imp of bulkData.importActivities) {
    const destKey = imp['DestinationObject.CustomerKey'] || imp.DestinationObject?.CustomerKey;

    if (destKey?.toLowerCase() === keyLower) {
      dependencies.push({
        type: 'Import Activity',
        id: imp.ObjectID,
        name: imp.Name,
        status: imp.Status,
        details: 'Import Destination',
        rawData: {
          objectId: imp.ObjectID,
          customerKey: imp.CustomerKey,
          createdDate: imp.CreatedDate,
          modifiedDate: imp.ModifiedDate
        }
      });
    }
  }

  // 4. Check Triggered Sends
  for (const tsd of bulkData.triggeredSends) {
    const objString = JSON.stringify(tsd).toLowerCase();
    if (objString.includes(keyLower)) {
      dependencies.push({
        type: 'Triggered Send',
        id: tsd.ObjectID,
        name: tsd.Name,
        status: tsd.TriggeredSendStatus,
        details: 'Referenced in Triggered Send',
        rawData: {
          objectId: tsd.ObjectID,
          customerKey: tsd.CustomerKey,
          status: tsd.TriggeredSendStatus
        }
      });
    }
  }

  // 5. Check Automations (search in steps for DE reference)
  for (const auto of bulkData.automations) {
    const autoJson = JSON.stringify(auto).toLowerCase();
    if (autoJson.includes(keyLower)) {
      dependencies.push({
        type: 'Automation',
        id: auto.id,
        name: auto.name,
        status: auto.status,
        details: 'Referenced in Automation',
        rawData: {
          id: auto.id,
          key: auto.key,
          status: auto.status,
          statusId: auto.statusId,
          lastRunTime: auto.lastRunTime,
          createdDate: auto.createdDate,
          modifiedDate: auto.modifiedDate
        }
      });
    }
  }

  // 6. Check Journeys
  for (const journey of bulkData.journeys) {
    const journeyJson = JSON.stringify(journey).toLowerCase();
    if (journeyJson.includes(keyLower)) {
      dependencies.push({
        type: 'Journey',
        id: journey.id,
        name: journey.name,
        status: journey.status,
        details: 'Referenced in Journey',
        rawData: {
          id: journey.id,
          key: journey.key,
          status: journey.status,
          version: journey.version
        }
      });
    }
  }

  // 7. Check Data Extracts
  for (const extract of bulkData.dataExtracts) {
    const extractJson = JSON.stringify(extract).toLowerCase();
    if (extractJson.includes(keyLower)) {
      dependencies.push({
        type: 'Data Extract',
        id: extract.dataExtractDefinitionId || extract.id,
        name: extract.name,
        status: extract.status,
        details: 'Referenced in Data Extract',
        rawData: extract
      });
    }
  }

  return dependencies;
}

/**
 * Classify a dependency using pre-loaded data (no API calls)
 *
 * @param {object} dep - Dependency object
 * @param {object} bulkData - Pre-loaded SFMC data
 * @param {dayjs.Dayjs} staleThreshold - Date threshold for staleness
 * @returns {object} Enriched dependency with classification
 */
function classifyDependency(dep, bulkData, staleThreshold) {
  const enriched = {
    ...dep,
    metadata: {},
    classification: DependencyClassification.UNKNOWN,
    classificationReason: ClassificationReason.NO_METADATA,
    canDelete: false
  };

  switch (dep.type) {
    case 'Automation':
      classifyAutomation(enriched, bulkData, staleThreshold);
      break;

    case 'Filter Activity':
      classifyFilter(enriched, bulkData, staleThreshold);
      break;

    case 'Query Activity':
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = ClassificationReason.QUERY_ACTIVITY;
      enriched.canDelete = false;
      enriched.metadata = dep.rawData || {};
      break;

    case 'Import Activity':
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = ClassificationReason.IMPORT_ACTIVITY;
      enriched.canDelete = false;
      enriched.metadata = dep.rawData || {};
      break;

    case 'Triggered Send':
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = ClassificationReason.TRIGGERED_SEND;
      enriched.canDelete = false;
      enriched.metadata = dep.rawData || {};
      break;

    case 'Journey':
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = ClassificationReason.JOURNEY;
      enriched.canDelete = false;
      enriched.metadata = dep.rawData || {};
      break;

    case 'Data Extract':
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = ClassificationReason.DATA_EXTRACT;
      enriched.canDelete = false;
      enriched.metadata = dep.rawData || {};
      break;

    default:
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = `${dep.type} requires manual review`;
  }

  return enriched;
}

/**
 * Classify an automation dependency
 */
function classifyAutomation(enriched, bulkData, staleThreshold) {
  const autoData = enriched.rawData || {};
  const auto = bulkData.automationsById.get(enriched.id) || autoData;

  enriched.metadata = {
    status: auto.status,
    statusId: auto.statusId,
    lastRunTime: auto.lastRunTime,
    createdDate: auto.createdDate,
    modifiedDate: auto.modifiedDate
  };

  const lastRun = auto.lastRunTime ? dayjs(auto.lastRunTime) : null;
  const status = (auto.status || '').toLowerCase();
  const statusId = auto.statusId;

  // Status codes: 1=Building, 2=Ready, 3=Running, 4=Paused, 5=Stopped, 6=Scheduled, 7=Awaiting, 8=Inactive
  const isInactive = statusId === 4 || statusId === 5 || statusId === 8 ||
    status.includes('paused') || status.includes('stopped') || status.includes('inactive');

  if (!lastRun) {
    // Never run
    enriched.classification = DependencyClassification.SAFE_TO_DELETE;
    enriched.classificationReason = ClassificationReason.NEVER_RUN;
    enriched.canDelete = true;
  } else if (lastRun.isBefore(staleThreshold)) {
    // Stale - hasn't run in over a year
    enriched.classification = DependencyClassification.SAFE_TO_DELETE;
    enriched.classificationReason = ClassificationReason.STALE_AUTOMATION;
    enriched.canDelete = true;
    enriched.metadata.daysSinceLastRun = dayjs().diff(lastRun, 'day');
  } else if (isInactive) {
    // Inactive but recently used - flag for review
    enriched.classification = DependencyClassification.REQUIRES_REVIEW;
    enriched.classificationReason = ClassificationReason.INACTIVE_AUTOMATION;
    enriched.canDelete = false;
    enriched.metadata.daysSinceLastRun = dayjs().diff(lastRun, 'day');
  } else {
    // Active and recently used
    enriched.classification = DependencyClassification.REQUIRES_REVIEW;
    enriched.classificationReason = ClassificationReason.ACTIVE_AUTOMATION;
    enriched.canDelete = false;
    enriched.metadata.daysSinceLastRun = dayjs().diff(lastRun, 'day');
  }
}

/**
 * Classify a filter activity dependency
 */
function classifyFilter(enriched, bulkData, staleThreshold) {
  const filterData = enriched.rawData || {};
  const filterId = enriched.id;

  enriched.metadata = {
    sourceObjectId: filterData.sourceObjectId,
    destinationObjectId: filterData.destinationObjectId,
    customerKey: filterData.customerKey,
    createdDate: filterData.createdDate,
    modifiedDate: filterData.modifiedDate
  };

  // If no filter ID, can't determine automation usage - mark as unknown
  if (!filterId) {
    enriched.classification = DependencyClassification.UNKNOWN;
    enriched.classificationReason = ClassificationReason.NO_METADATA;
    enriched.canDelete = false;
    return;
  }

  // Check if filter is used in any automation
  const automationsUsingFilter = findAutomationsContainingActivity(filterId, bulkData);

  if (automationsUsingFilter.length === 0) {
    // Standalone filter - safe to delete
    enriched.classification = DependencyClassification.SAFE_TO_DELETE;
    enriched.classificationReason = ClassificationReason.STANDALONE_FILTER;
    enriched.canDelete = true;
    enriched.metadata.usedInAutomations = [];
  } else {
    // Filter is used in automation(s)
    enriched.metadata.usedInAutomations = automationsUsingFilter.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      lastRunTime: a.lastRunTime
    }));

    // Check if ALL automations using this filter are safe to delete
    // An automation is safe if it's:
    // 1. Inactive (paused/stopped/inactive status), OR
    // 2. Stale (hasn't run in over a year), OR
    // 3. Never run
    let allAutomationsSafe = true;
    let activeRecentAutomations = [];

    for (const auto of automationsUsingFilter) {
      const lastRun = auto.lastRunTime ? dayjs(auto.lastRunTime) : null;
      const status = (auto.status || '').toLowerCase();
      const statusId = auto.statusId;

      // Check if explicitly inactive
      const isInactive = statusId === 4 || statusId === 5 || statusId === 8 ||
        status.includes('paused') || status.includes('stopped') || status.includes('inactive');

      // Check if stale (hasn't run in over a year) or never run
      const isStale = !lastRun || lastRun.isBefore(staleThreshold);

      // Automation is safe to delete if inactive OR stale
      const isSafe = isInactive || isStale;

      if (!isSafe) {
        allAutomationsSafe = false;
        activeRecentAutomations.push(auto.name);
      }
    }

    if (allAutomationsSafe) {
      enriched.classification = DependencyClassification.SAFE_TO_DELETE;
      enriched.classificationReason = ClassificationReason.FILTER_IN_STALE_AUTOMATION;
      enriched.canDelete = true;
    } else {
      enriched.classification = DependencyClassification.REQUIRES_REVIEW;
      enriched.classificationReason = `Filter used in active automation(s): ${activeRecentAutomations.slice(0, 2).join(', ')}${activeRecentAutomations.length > 2 ? ' +more' : ''}`;
      enriched.canDelete = false;
    }
  }
}

/**
 * Build a mapping of DE customerKey -> list of dependencies
 *
 * @param {object[]} rawDependencies - Raw dependency list with affectedDe
 * @returns {Map<string, object[]>} Map of DE key to dependencies
 */
function buildDeMapping(rawDependencies) {
  const mapping = new Map();

  for (const dep of rawDependencies) {
    const key = dep.affectedDe.customerKey;
    if (!mapping.has(key)) {
      mapping.set(key, []);
    }
    mapping.get(key).push({
      type: dep.type,
      id: dep.id,
      name: dep.name
    });
  }

  return mapping;
}

/**
 * Format the analysis report for console output
 *
 * @param {object} report - Analysis report from analyzeDependencies
 * @returns {string} Formatted string for console
 */
export function formatAnalysisReport(report) {
  const lines = [];
  const width = 70;
  const line = '─'.repeat(width);

  lines.push('');
  lines.push(`┌${line}┐`);
  lines.push(`│${'DEPENDENCY ANALYSIS REPORT'.padStart(48).padEnd(width)}│`);
  lines.push(`├${line}┤`);

  // Summary
  lines.push(`│ Data Extensions analyzed: ${String(report.summary.totalDes).padEnd(width - 29)}│`);
  lines.push(`│ Total dependencies found: ${String(report.summary.totalRawDependencies).padEnd(width - 29)}│`);
  lines.push(`│ Unique dependencies: ${String(report.summary.uniqueDependencies).padEnd(width - 24)}│`);
  lines.push(`│${''.padEnd(width)}│`);

  // By classification
  lines.push(`│ ✓ Safe to delete: ${String(report.summary.safeToDelete).padEnd(width - 21)}│`);
  lines.push(`│ ⚠ Requires review: ${String(report.summary.requiresReview).padEnd(width - 22)}│`);
  if (report.summary.unknown > 0) {
    lines.push(`│ ? Unknown: ${String(report.summary.unknown).padEnd(width - 14)}│`);
  }

  // By type
  lines.push(`│${''.padEnd(width)}│`);
  lines.push(`│ By Type:${''.padEnd(width - 10)}│`);
  for (const [type, counts] of Object.entries(report.summary.byType)) {
    const typeStr = `   ${type}: ${counts.total} (${counts.safeToDelete} safe, ${counts.requiresReview} review)`;
    lines.push(`│${typeStr.padEnd(width)}│`);
  }

  lines.push(`└${line}┘`);

  // Safe to delete details
  if (report.safeToDelete.length > 0) {
    lines.push('');
    lines.push(`┌${line}┐`);
    lines.push(`│${'✓ SAFE TO DELETE'.padStart(43).padEnd(width)}│`);
    lines.push(`├${line}┤`);

    for (const dep of report.safeToDelete.slice(0, 20)) {
      const name = dep.name.length > 45 ? dep.name.substring(0, 42) + '...' : dep.name;
      lines.push(`│ ${dep.type.padEnd(18)} ${name.padEnd(width - 21)}│`);
      const reason = `   └ ${dep.classificationReason}`;
      lines.push(`│${reason.substring(0, width).padEnd(width)}│`);

      if (dep.metadata.lastRunTime) {
        const lastRun = `     Last run: ${dep.metadata.lastRunTime.split('T')[0]} (${dep.metadata.daysSinceLastRun} days ago)`;
        lines.push(`│${lastRun.substring(0, width).padEnd(width)}│`);
      }

      // Show affected DE count
      const deCount = `     Affects: ${dep.affectedDes.length} DE(s)`;
      lines.push(`│${deCount.padEnd(width)}│`);
    }

    if (report.safeToDelete.length > 20) {
      lines.push(`│ ... and ${report.safeToDelete.length - 20} more${''.padEnd(width - 16)}│`);
    }

    lines.push(`└${line}┘`);
  }

  // Requires review details
  if (report.requiresReview.length > 0) {
    lines.push('');
    lines.push(`┌${line}┐`);
    lines.push(`│${'⚠ REQUIRES REVIEW'.padStart(44).padEnd(width)}│`);
    lines.push(`├${line}┤`);

    for (const dep of report.requiresReview.slice(0, 20)) {
      const name = dep.name.length > 45 ? dep.name.substring(0, 42) + '...' : dep.name;
      lines.push(`│ ${dep.type.padEnd(18)} ${name.padEnd(width - 21)}│`);
      const reason = `   └ ${dep.classificationReason}`;
      lines.push(`│${reason.substring(0, width).padEnd(width)}│`);

      if (dep.metadata.lastRunTime) {
        const lastRun = `     Last run: ${dep.metadata.lastRunTime.split('T')[0]} (${dep.metadata.daysSinceLastRun || '?'} days ago)`;
        lines.push(`│${lastRun.substring(0, width).padEnd(width)}│`);
      }

      if (dep.metadata.usedInAutomations && dep.metadata.usedInAutomations.length > 0) {
        const autoNames = dep.metadata.usedInAutomations.map(a => a.name).slice(0, 2);
        const autoStr = `     Used in: ${autoNames.join(', ')}${dep.metadata.usedInAutomations.length > 2 ? ' +more' : ''}`;
        lines.push(`│${autoStr.substring(0, width).padEnd(width)}│`);
      }

      // Show affected DE count
      const deCount = `     Affects: ${dep.affectedDes.length} DE(s)`;
      lines.push(`│${deCount.padEnd(width)}│`);
    }

    if (report.requiresReview.length > 20) {
      lines.push(`│ ... and ${report.requiresReview.length - 20} more${''.padEnd(width - 16)}│`);
    }

    lines.push(`└${line}┘`);
  }

  return lines.join('\n');
}

/**
 * Export analysis report to CSV format
 *
 * @param {object} report - Analysis report from analyzeDependencies
 * @param {object} options - Export options
 * @param {boolean} options.includeAffectedDes - Include list of affected DEs (default: true)
 * @returns {string} CSV content
 */
export function exportReportToCsv(report, options = {}) {
  const { includeAffectedDes = true } = options;

  // Escape CSV values
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // CSV header
  const headers = [
    'Dependency Type',
    'Dependency Name',
    'Dependency ID',
    'Status',
    'Classification',
    'Recommendation',
    'Reason',
    'Last Run Time',
    'Days Since Last Run',
    'Affected DE Count'
  ];

  if (includeAffectedDes) {
    headers.push('Affected DEs');
  }

  const rows = [headers.join(',')];

  // Process all dependencies
  for (const dep of report.all) {
    // Map classification to recommendation
    let recommendation = 'Review Required';
    if (dep.classification === DependencyClassification.SAFE_TO_DELETE) {
      recommendation = 'Safe to Delete';
    } else if (dep.classification === DependencyClassification.UNKNOWN) {
      recommendation = 'Unknown - Manual Review';
    }

    const row = [
      escapeCSV(dep.type),
      escapeCSV(dep.name),
      escapeCSV(dep.id),
      escapeCSV(dep.status),
      escapeCSV(dep.classification),
      escapeCSV(recommendation),
      escapeCSV(dep.classificationReason),
      escapeCSV(dep.metadata?.lastRunTime || ''),
      escapeCSV(dep.metadata?.daysSinceLastRun ?? ''),
      escapeCSV(dep.affectedDes?.length || 0)
    ];

    if (includeAffectedDes) {
      const deList = (dep.affectedDes || []).map(de => de.name || de.customerKey).join('; ');
      row.push(escapeCSV(deList));
    }

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

/**
 * Export DE-centric view to CSV (one row per DE with dependency summary)
 *
 * @param {object[]} dataExtensions - Array of DE objects with dependency info
 * @param {object} report - Analysis report from analyzeDependencies
 * @returns {string} CSV content
 */
export function exportDeDependenciesToCsv(dataExtensions, report) {
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = [
    'DE Name',
    'DE CustomerKey',
    'Folder Path',
    'Row Count',
    'Total Dependencies',
    'Safe to Delete',
    'Requires Review',
    'Blocking Dependencies',
    'Recommendation',
    'Dependency Details'
  ];

  const rows = [headers.join(',')];

  for (const de of dataExtensions) {
    // Get dependencies for this DE from the report mapping
    const deDeps = report.deMapping?.get(de.customerKey) || [];

    // Count by classification
    let safeCount = 0;
    let reviewCount = 0;
    const blockingDeps = [];

    for (const depRef of deDeps) {
      // Find the full dependency info from report.all
      const fullDep = report.all.find(d => d.type === depRef.type && d.id === depRef.id);
      if (fullDep) {
        if (fullDep.classification === DependencyClassification.SAFE_TO_DELETE) {
          safeCount++;
        } else {
          reviewCount++;
          blockingDeps.push(`${fullDep.type}: ${fullDep.name}`);
        }
      }
    }

    // Determine overall recommendation
    let recommendation = 'Safe to Delete';
    if (reviewCount > 0) {
      recommendation = 'Review Required - Has Blocking Dependencies';
    } else if (safeCount > 0) {
      recommendation = 'Safe to Delete (dependencies can be auto-deleted)';
    }

    const row = [
      escapeCSV(de.name),
      escapeCSV(de.customerKey),
      escapeCSV(de.folderPath || ''),
      escapeCSV(de.rowCount ?? ''),
      escapeCSV(deDeps.length),
      escapeCSV(safeCount),
      escapeCSV(reviewCount),
      escapeCSV(blockingDeps.slice(0, 5).join('; ') + (blockingDeps.length > 5 ? ` (+${blockingDeps.length - 5} more)` : '')),
      escapeCSV(recommendation),
      escapeCSV(deDeps.map(d => `${d.type}: ${d.name}`).slice(0, 10).join('; ') + (deDeps.length > 10 ? ` (+${deDeps.length - 10} more)` : ''))
    ];

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

export default {
  analyzeDependencies,
  formatAnalysisReport,
  exportReportToCsv,
  exportDeDependenciesToCsv,
  DependencyClassification,
  ClassificationReason
};
