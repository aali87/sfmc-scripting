#!/usr/bin/env node

/**
 * SFMC Business Unit Analysis Script
 *
 * Scans all Data Extensions within a Business Unit and generates
 * a comprehensive CSV report with deletion recommendations based on:
 * - Automation lastRunTime + DE ModifiedDate (configurable inactivity threshold)
 * - Query Activity, Journey, Filter, Import references
 * - Retention settings (flags DEs without retention)
 *
 * Usage:
 *   node src/scripts/analyze-bu.js --business-unit 123456 [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';

dayjs.extend(relativeTime);

import config, { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { loadAllFolders } from '../lib/folder-service.js';
import { retrieveDataExtensionFields } from '../lib/sfmc-soap.js';
import { loadAllSfmcData, getBulkDataSummary } from '../lib/bulk-data-loader.js';
import { escapeCSV } from '../lib/utils.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --business-unit <mid> [options]')
  .option('business-unit', {
    alias: 'bu',
    describe: 'Business Unit MID to analyze',
    type: 'string',
    demandOption: true
  })
  .option('stale-years', {
    describe: 'Years of inactivity to consider stale',
    type: 'number',
    default: 3
  })
  .option('output', {
    alias: 'o',
    describe: 'Output CSV file path',
    type: 'string'
  })
  .option('refresh-cache', {
    describe: 'Force refresh of cached SFMC data',
    type: 'boolean',
    default: false
  })
  .option('verbose', {
    alias: 'v',
    describe: 'Show detailed progress',
    type: 'boolean',
    default: false
  })
  .option('limit', {
    describe: 'Limit number of DEs to analyze (for testing)',
    type: 'number'
  })
  .help()
  .alias('help', 'h')
  .example('$0 --bu 123456', 'Analyze Business Unit 123456')
  .example('$0 --bu 123456 --stale-years 2 -o report.csv', 'Custom threshold and output')
  .parseSync();

// Initialize logger
const logger = createLogger('analyze-bu');

// Recommendation types
const Recommendation = {
  KEEP: 'KEEP',
  RECOMMEND_DELETE: 'RECOMMEND_DELETE',
  SAFE_TO_DELETE: 'SAFE_TO_DELETE',
  REVIEW: 'REVIEW'
};

/**
 * Main analysis function
 */
async function runAnalysis() {
  const startTime = Date.now();
  const accountId = argv.businessUnit;
  const staleThreshold = dayjs().subtract(argv.staleYears, 'year');

  console.log('');
  console.log(chalk.cyan('='.repeat(config.ui.consoleWidth)));
  console.log(chalk.cyan.bold('  SFMC Business Unit Analysis'));
  console.log(chalk.cyan('='.repeat(config.ui.consoleWidth)));
  console.log('');
  console.log(`  Business Unit: ${chalk.yellow(accountId)}`);
  console.log(`  Stale Threshold: ${chalk.yellow(argv.staleYears + ' years')}`);
  console.log(`  Output: ${argv.output ? chalk.yellow(argv.output) : chalk.gray('console (use -o to save CSV)')}`);
  console.log('');

  // Validate configuration
  try {
    validateConfig();
  } catch (error) {
    console.log(chalk.red('Configuration error:'));
    console.log(chalk.red(`  ${error.message}`));
    process.exit(1);
  }

  // Test connection
  let spinner = ora('Testing SFMC connection...').start();
  try {
    const connResult = await testConnection(null, accountId);
    if (!connResult.success) {
      spinner.fail(`Connection failed: ${connResult.error}`);
      process.exit(1);
    }
    spinner.succeed(`Connected to BU ${accountId}`);
  } catch (error) {
    spinner.fail(`Connection error: ${error.message}`);
    process.exit(1);
  }

  // Step 1: Load all folders
  spinner = ora('Loading folder structure...').start();
  let folders;
  try {
    folders = await loadAllFolders(logger, argv.refreshCache, accountId);
    spinner.succeed(`Loaded ${folders.length} folders`);
  } catch (error) {
    spinner.fail(`Failed to load folders: ${error.message}`);
    process.exit(1);
  }

  // Build folder path lookup
  const folderPathById = new Map();
  for (const folder of folders) {
    folderPathById.set(folder.ID, folder.Path || folder.Name);
  }

  // Step 2: Load all bulk data (DEs, automations, queries, etc.)
  spinner = ora('Loading SFMC metadata (DEs, automations, queries, etc.)...').start();
  let bulkData;
  try {
    bulkData = await loadAllSfmcData({
      logger: argv.verbose ? logger : null,
      onProgress: (stage, current, total, message) => {
        spinner.text = `Loading ${stage}: ${current}/${total}`;
      },
      includeAutomationDetails: true,
      includeQueryText: true,
      forceRefresh: argv.refreshCache,
      accountId
    });
    const summary = getBulkDataSummary(bulkData);
    spinner.succeed(`Loaded: ${summary.dataExtensions || bulkData.dataExtensions?.length || 0} DEs, ${summary.automations} automations, ${summary.queryActivities} queries, ${summary.journeys} journeys`);
  } catch (error) {
    spinner.fail(`Failed to load metadata: ${error.message}`);
    process.exit(1);
  }

  // Get Data Extensions from bulk data
  let dataExtensions = bulkData.dataExtensions || [];

  // Apply limit if specified
  if (argv.limit && argv.limit < dataExtensions.length) {
    dataExtensions = dataExtensions.slice(0, argv.limit);
    console.log(chalk.yellow(`  (Limited to ${argv.limit} DEs for testing)`));
  }

  // Step 4: Analyze each DE
  console.log('');
  console.log(chalk.cyan('Analyzing Data Extensions...'));
  console.log('');

  const results = [];
  const progressBar = argv.verbose ? null : ora(`Analyzing 0/${dataExtensions.length} DEs`).start();

  try {
    for (let i = 0; i < dataExtensions.length; i++) {
      const de = dataExtensions[i];

      if (progressBar) {
        progressBar.text = `Analyzing ${i + 1}/${dataExtensions.length}: ${de.Name}`;
      } else if (argv.verbose) {
        console.log(chalk.gray(`  [${i + 1}/${dataExtensions.length}] ${de.Name}`));
      }

      try {
        const analysis = analyzeDataExtension(de, bulkData, folderPathById, staleThreshold);
        results.push(analysis);
      } catch (error) {
        logger.warn(`Failed to analyze ${de.Name}: ${error.message}`);
        results.push({
          name: de.Name,
          customerKey: de.CustomerKey,
          error: error.message,
          recommendation: Recommendation.REVIEW,
          reasons: ['Analysis failed: ' + error.message]
        });
      }
    }

    if (progressBar) {
      progressBar.succeed(`Analyzed ${dataExtensions.length} Data Extensions`);
    }
  } catch (error) {
    if (progressBar) {
      progressBar.fail('Analysis failed');
    }
    throw error;
  }

  // Step 5: Generate report
  console.log('');

  // Summary
  const summary = {
    total: results.length,
    keep: results.filter(r => r.recommendation === Recommendation.KEEP).length,
    recommendDelete: results.filter(r => r.recommendation === Recommendation.RECOMMEND_DELETE).length,
    safeToDelete: results.filter(r => r.recommendation === Recommendation.SAFE_TO_DELETE).length,
    review: results.filter(r => r.recommendation === Recommendation.REVIEW).length,
    noRetention: results.filter(r => !r.hasRetention).length
  };

  console.log(chalk.cyan('='.repeat(config.ui.consoleWidth)));
  console.log(chalk.cyan.bold('  ANALYSIS SUMMARY'));
  console.log(chalk.cyan('='.repeat(config.ui.consoleWidth)));
  console.log('');
  console.log(`  Total Data Extensions: ${chalk.white(summary.total)}`);
  console.log('');
  console.log(`  ${chalk.green('KEEP')}: ${summary.keep} - Active within ${argv.staleYears} years`);
  console.log(`  ${chalk.red('RECOMMEND_DELETE')}: ${summary.recommendDelete} - Inactive ${argv.staleYears}+ years, safe dependencies`);
  console.log(`  ${chalk.magenta('SAFE_TO_DELETE')}: ${summary.safeToDelete} - No dependencies found`);
  console.log(`  ${chalk.yellow('REVIEW')}: ${summary.review} - Requires manual review`);
  console.log('');
  console.log(`  ${chalk.yellow('!')} No Retention Policy: ${summary.noRetention} DEs`);
  console.log('');

  // Generate CSV
  const csv = generateCsv(results);

  // Output
  if (argv.output) {
    const outputPath = path.resolve(argv.output);
    fs.writeFileSync(outputPath, csv);
    console.log(chalk.green(`CSV report saved to: ${outputPath}`));
  } else {
    console.log(chalk.gray('Use -o <file.csv> to save the full report'));
    console.log('');

    // Show top candidates for deletion
    const deleteCandidates = results
      .filter(r => r.recommendation === Recommendation.RECOMMEND_DELETE || r.recommendation === Recommendation.SAFE_TO_DELETE)
      .slice(0, 10);

    if (deleteCandidates.length > 0) {
      console.log(chalk.cyan('Top Deletion Candidates:'));
      for (const de of deleteCandidates) {
        const badge = de.recommendation === Recommendation.SAFE_TO_DELETE
          ? chalk.magenta('[SAFE]')
          : chalk.red('[REC]');
        console.log(`  ${badge} ${de.name}`);
        console.log(chalk.gray(`       ${de.reasons.slice(0, 2).join(', ')}`));
      }
    }
  }

  // Timing
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(chalk.gray(`Completed in ${elapsed}s`));
}

/**
 * Analyze a single Data Extension
 */
function analyzeDataExtension(de, bulkData, folderPathById, staleThreshold) {
  const result = {
    name: de.Name,
    customerKey: de.CustomerKey,
    folderPath: folderPathById.get(parseInt(de.CategoryID, 10)) || `Folder ${de.CategoryID}`,
    rowCount: null, // Would need separate API call
    createdDate: de.CreatedDate,
    modifiedDate: de.ModifiedDate,
    daysSinceModified: de.ModifiedDate ? dayjs().diff(dayjs(de.ModifiedDate), 'day') : null,

    // Retention info
    hasRetention: !!(de.DataRetentionPeriodLength || de.RetainUntil),
    retentionPeriod: de.DataRetentionPeriodLength || null,
    retentionUnit: de.DataRetentionPeriodUnitOfMeasure || null,
    retainUntil: de.RetainUntil || null,
    deleteAtEnd: de.DeleteAtEndOfRetentionPeriod === 'true',

    // Dependencies
    automations: [],
    activeAutomations: [],
    mostRecentAutomationRun: null,
    daysSinceLastAutomationRun: null,
    queries: [],
    queriesAsTarget: [], // Queries where this DE is the target (data written TO it)
    filters: [],
    imports: [],
    journeys: [],
    dataExtracts: [],
    triggeredSends: [],

    // Estimated last data load (based on automation runs for imports/queries targeting this DE)
    estimatedLastDataLoad: null,
    daysSinceLastDataLoad: null,
    lastDataLoadSource: null, // 'import', 'query', or 'unknown'

    // Recommendation
    recommendation: Recommendation.REVIEW,
    reasons: [],
    retentionFlag: ''
  };

  const keyLower = de.CustomerKey.toLowerCase();
  const nameLower = de.Name.toLowerCase();

  // Find automation references
  for (const auto of bulkData.automations) {
    const autoJson = JSON.stringify(auto).toLowerCase();
    if (autoJson.includes(keyLower) || autoJson.includes(nameLower)) {
      result.automations.push({
        name: auto.name,
        status: auto.status,
        lastRunTime: auto.lastRunTime
      });

      // Track active automations (ran recently)
      if (auto.lastRunTime) {
        const lastRun = dayjs(auto.lastRunTime);
        if (lastRun.isAfter(staleThreshold)) {
          result.activeAutomations.push(auto.name);
        }

        // Track most recent run
        if (!result.mostRecentAutomationRun || lastRun.isAfter(dayjs(result.mostRecentAutomationRun))) {
          result.mostRecentAutomationRun = auto.lastRunTime;
        }
      }
    }
  }

  if (result.mostRecentAutomationRun) {
    result.daysSinceLastAutomationRun = dayjs().diff(dayjs(result.mostRecentAutomationRun), 'day');
  }

  // Find query references (distinguish between target and source DEs)
  for (const query of bulkData.queryActivities) {
    const targetKey = query['DataExtensionTarget.CustomerKey'] || query.DataExtensionTarget?.CustomerKey;
    const targetName = query['DataExtensionTarget.Name'] || query.DataExtensionTarget?.Name;

    let isTarget = false;
    let isSource = false;

    // Check if this DE is the target (data written TO it)
    if (targetKey?.toLowerCase() === keyLower || targetName?.toLowerCase() === nameLower) {
      isTarget = true;
      result.queriesAsTarget.push({
        name: query.Name,
        objectId: query.ObjectID,
        customerKey: query.CustomerKey
      });
    }

    // Check if this DE is referenced in the SQL (source DE)
    if (query.QueryText) {
      const sqlLower = query.QueryText.toLowerCase();
      if (sqlLower.includes(keyLower) || sqlLower.includes(nameLower)) {
        isSource = true;
      }
    }

    if (isTarget || isSource) {
      result.queries.push(query.Name);
    }
  }

  // Find filter references
  for (const filter of bulkData.filterActivities) {
    const sourceId = filter.sourceObjectId?.toLowerCase();
    const destId = filter.destinationObjectId?.toLowerCase();
    const deObjectId = de.ObjectID?.toLowerCase();

    if (deObjectId && (sourceId === deObjectId || destId === deObjectId)) {
      result.filters.push(filter.name);
    }
  }

  // Find import references (imports that target this DE)
  const importDetails = [];
  for (const imp of bulkData.importActivities) {
    const destKey = imp['DestinationObject.CustomerKey'] || imp.DestinationObject?.CustomerKey;
    const destName = imp['DestinationObject.Name'] || imp.DestinationObject?.Name;
    if (destKey?.toLowerCase() === keyLower || destName?.toLowerCase() === nameLower) {
      result.imports.push(imp.Name);
      importDetails.push({
        name: imp.Name,
        objectId: imp.ObjectID,
        customerKey: imp.CustomerKey
      });
    }
  }

  // Find journey references
  for (const journey of bulkData.journeys) {
    const journeyJson = JSON.stringify(journey).toLowerCase();
    if (journeyJson.includes(keyLower)) {
      result.journeys.push(journey.name);
    }
  }

  // Find data extract references
  for (const extract of bulkData.dataExtracts) {
    const extractJson = JSON.stringify(extract).toLowerCase();
    if (extractJson.includes(keyLower)) {
      result.dataExtracts.push(extract.name);
    }
  }

  // Find triggered send references
  for (const tsd of bulkData.triggeredSends) {
    const tsdJson = JSON.stringify(tsd).toLowerCase();
    if (tsdJson.includes(keyLower)) {
      result.triggeredSends.push(tsd.Name);
    }
  }

  // Estimate last data load time by finding automations that contain imports/queries targeting this DE
  // This is an estimate since SFMC doesn't track actual data insert timestamps
  estimateLastDataLoad(result, importDetails, bulkData);

  // Determine recommendation
  determineRecommendation(result, staleThreshold);

  return result;
}

/**
 * Estimate last data load time for a DE by correlating imports/queries with automation run times
 *
 * SFMC doesn't provide a direct "last data insert" timestamp, so we estimate by:
 * 1. Finding imports that target this DE
 * 2. Finding query activities that write to this DE (as target)
 * 3. Finding automations that contain these activities
 * 4. Using the most recent lastRunTime from those automations
 *
 * This is an ESTIMATE and may not be accurate if:
 * - Data was loaded manually via UI
 * - Data was loaded via API directly
 * - The automation ran but the activity was skipped/failed
 */
function estimateLastDataLoad(result, importDetails, bulkData) {
  let mostRecentDataLoad = null;
  let dataLoadSource = null;

  // Helper to find automations containing a specific activity
  const findAutomationsWithActivity = (activityObjectId, activityCustomerKey) => {
    const matchingAutos = [];
    for (const auto of bulkData.automations) {
      // Search in the automation's activity IDs
      if (auto.activityIds) {
        const activityIds = auto.activityIds.map(id => id?.toLowerCase());
        if ((activityObjectId && activityIds.includes(activityObjectId.toLowerCase())) ||
            (activityCustomerKey && activityIds.includes(activityCustomerKey.toLowerCase()))) {
          matchingAutos.push(auto);
          continue;
        }
      }

      // Fall back to JSON search if activityIds not available
      const autoJson = JSON.stringify(auto).toLowerCase();
      if ((activityObjectId && autoJson.includes(activityObjectId.toLowerCase())) ||
          (activityCustomerKey && autoJson.includes(activityCustomerKey.toLowerCase()))) {
        matchingAutos.push(auto);
      }
    }
    return matchingAutos;
  };

  // Check imports that target this DE
  for (const imp of importDetails) {
    const relatedAutos = findAutomationsWithActivity(imp.objectId, imp.customerKey);
    for (const auto of relatedAutos) {
      if (auto.lastRunTime) {
        const runTime = dayjs(auto.lastRunTime);
        if (!mostRecentDataLoad || runTime.isAfter(mostRecentDataLoad)) {
          mostRecentDataLoad = runTime;
          dataLoadSource = `Import: ${imp.name} (via ${auto.name})`;
        }
      }
    }
  }

  // Check queries that target this DE (queriesAsTarget)
  for (const query of result.queriesAsTarget) {
    const relatedAutos = findAutomationsWithActivity(query.objectId, query.customerKey);
    for (const auto of relatedAutos) {
      if (auto.lastRunTime) {
        const runTime = dayjs(auto.lastRunTime);
        if (!mostRecentDataLoad || runTime.isAfter(mostRecentDataLoad)) {
          mostRecentDataLoad = runTime;
          dataLoadSource = `Query: ${query.name} (via ${auto.name})`;
        }
      }
    }
  }

  // Set the results
  if (mostRecentDataLoad) {
    result.estimatedLastDataLoad = mostRecentDataLoad.toISOString();
    result.daysSinceLastDataLoad = dayjs().diff(mostRecentDataLoad, 'day');
    result.lastDataLoadSource = dataLoadSource;
  }
}

/**
 * Determine the recommendation for a DE
 */
function determineRecommendation(result, staleThreshold) {
  const reasons = [];
  let recommendation = Recommendation.REVIEW;

  const hasDependencies = result.automations.length > 0 ||
    result.queries.length > 0 ||
    result.filters.length > 0 ||
    result.imports.length > 0 ||
    result.journeys.length > 0 ||
    result.dataExtracts.length > 0 ||
    result.triggeredSends.length > 0;

  const hasActiveAutomations = result.activeAutomations.length > 0;
  const deModifiedRecently = result.modifiedDate && dayjs(result.modifiedDate).isAfter(staleThreshold);
  const hadRecentDataLoad = result.estimatedLastDataLoad && dayjs(result.estimatedLastDataLoad).isAfter(staleThreshold);

  // Check retention
  if (!result.hasRetention) {
    result.retentionFlag = 'NO_RETENTION';
    reasons.push('No retention policy configured');
  }

  // Determine recommendation
  if (!hasDependencies) {
    // No dependencies at all
    recommendation = Recommendation.SAFE_TO_DELETE;
    reasons.push('No dependencies found');
  } else if (hasActiveAutomations || deModifiedRecently || hadRecentDataLoad) {
    // Active
    recommendation = Recommendation.KEEP;
    if (hasActiveAutomations) {
      reasons.push(`Active automation(s): ${result.activeAutomations.slice(0, 2).join(', ')}`);
    }
    if (hadRecentDataLoad) {
      reasons.push(`Data loaded recently (${result.daysSinceLastDataLoad} days ago)`);
    }
    if (deModifiedRecently) {
      reasons.push(`Metadata modified recently (${result.daysSinceModified} days ago)`);
    }
  } else if (result.journeys.length > 0 || result.triggeredSends.length > 0) {
    // Has journey/triggered send - needs review
    recommendation = Recommendation.REVIEW;
    if (result.journeys.length > 0) {
      reasons.push(`Used in Journey(s): ${result.journeys.slice(0, 2).join(', ')}`);
    }
    if (result.triggeredSends.length > 0) {
      reasons.push(`Used in Triggered Send(s): ${result.triggeredSends.slice(0, 2).join(', ')}`);
    }
  } else if (result.automations.length > 0 && !hasActiveAutomations) {
    // Has automations but none active recently
    recommendation = Recommendation.RECOMMEND_DELETE;
    reasons.push(`All ${result.automations.length} automation(s) inactive for ${staleThreshold.fromNow(true)}+`);
    if (result.daysSinceLastAutomationRun) {
      reasons.push(`Last automation run: ${result.daysSinceLastAutomationRun} days ago`);
    }
  } else if (result.queries.length > 0 || result.filters.length > 0 || result.imports.length > 0) {
    // Has query/filter/import refs but no automation context
    recommendation = Recommendation.REVIEW;
    if (result.queries.length > 0) reasons.push(`Referenced in ${result.queries.length} query(ies)`);
    if (result.filters.length > 0) reasons.push(`Referenced in ${result.filters.length} filter(s)`);
    if (result.imports.length > 0) reasons.push(`Referenced in ${result.imports.length} import(s)`);
  }

  result.recommendation = recommendation;
  result.reasons = reasons;
}

/**
 * Generate CSV output with proper RFC 4180 escaping
 */
function generateCsv(results) {

  // Helper to safely join array items and then escape the result
  const joinAndEscape = (arr, separator = '; ') => {
    if (!arr || arr.length === 0) return '';
    // Join array items, then escape the combined string
    const joined = arr.map(item => {
      // For objects, extract the name property
      return typeof item === 'object' ? (item.name || '') : String(item);
    }).join(separator);
    return escapeCSV(joined);
  };

  const headers = [
    'DE Name',
    'Customer Key',
    'Folder Path',
    'Created Date',
    'Modified Date',
    'Days Since Modified',
    'Estimated Last Data Load',
    'Days Since Last Data Load',
    'Last Data Load Source',
    'Has Retention',
    'Retention Period',
    'Retention Unit',
    'Retain Until',
    'Delete At End',
    'Automation Count',
    'Active Automation Count',
    'Automation Names',
    'Most Recent Automation Run',
    'Days Since Last Automation Run',
    'Query Count',
    'Queries As Target Count',
    'Query Names',
    'Filter Count',
    'Filter Names',
    'Import Count',
    'Journey Count',
    'Journey Names',
    'Data Extract Count',
    'Triggered Send Count',
    'Recommendation',
    'Recommendation Reasons',
    'Retention Flag'
  ];

  // Escape headers too (RFC 4180 compliant)
  const rows = [headers.map(escapeCSV).join(',')];

  for (const r of results) {
    const row = [
      escapeCSV(r.name),
      escapeCSV(r.customerKey),
      escapeCSV(r.folderPath),
      escapeCSV(r.createdDate),
      escapeCSV(r.modifiedDate),
      escapeCSV(r.daysSinceModified),
      escapeCSV(r.estimatedLastDataLoad),
      escapeCSV(r.daysSinceLastDataLoad),
      escapeCSV(r.lastDataLoadSource),
      escapeCSV(r.hasRetention ? 'Yes' : 'No'),
      escapeCSV(r.retentionPeriod),
      escapeCSV(r.retentionUnit),
      escapeCSV(r.retainUntil),
      escapeCSV(r.deleteAtEnd ? 'Yes' : 'No'),
      escapeCSV(r.automations?.length || 0),
      escapeCSV(r.activeAutomations?.length || 0),
      joinAndEscape(r.automations),
      escapeCSV(r.mostRecentAutomationRun),
      escapeCSV(r.daysSinceLastAutomationRun),
      escapeCSV(r.queries?.length || 0),
      escapeCSV(r.queriesAsTarget?.length || 0),
      joinAndEscape(r.queries),
      escapeCSV(r.filters?.length || 0),
      joinAndEscape(r.filters),
      escapeCSV(r.imports?.length || 0),
      escapeCSV(r.journeys?.length || 0),
      joinAndEscape(r.journeys),
      escapeCSV(r.dataExtracts?.length || 0),
      escapeCSV(r.triggeredSends?.length || 0),
      escapeCSV(r.recommendation),
      joinAndEscape(r.reasons),
      escapeCSV(r.retentionFlag)
    ];
    rows.push(row.join(','));
  }

  return rows.join('\n');
}

// Run
runAnalysis().catch(error => {
  console.error(chalk.red(`\nFatal error: ${error.message}`));
  if (argv.verbose) {
    console.error(error.stack);
  }
  process.exit(1);
});
