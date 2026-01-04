#!/usr/bin/env node

/**
 * SFMC Query Activity Restoration Script
 *
 * Restores deleted Query Activities from cached data.
 * Reads the recovery file and recreates queries via SOAP API.
 *
 * IMPORTANT: Defaults to DRY RUN mode. Use --confirm to enable actual creation.
 *
 * Usage:
 *   node src/scripts/restore-queries.js [options]
 *   node src/scripts/restore-queries.js --input "audit/deleted-queries-recovery.json" --confirm
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import config, { validateConfig } from '../config/index.js';
import { createLogger, createAuditLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { createQueryActivity, retrieveDataExtensions, escapeXml } from '../lib/sfmc-soap.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('input', {
    alias: 'i',
    describe: 'Path to recovery JSON file',
    type: 'string',
    default: 'audit/deleted-queries-recovery.json'
  })
  .option('dry-run', {
    describe: 'Preview only, no creations (DEFAULT)',
    type: 'boolean',
    default: true
  })
  .option('confirm', {
    describe: 'Enable actual creation mode',
    type: 'boolean',
    default: false
  })
  .option('limit', {
    describe: 'Maximum number of queries to restore (for testing)',
    type: 'number'
  })
  .option('filter', {
    describe: 'Only restore queries matching this pattern (regex)',
    type: 'string'
  })
  .option('batch-size', {
    describe: 'Number of queries to create before pausing',
    type: 'number',
    default: 50
  })
  .option('skip-existing', {
    describe: 'Skip queries that already exist (by name)',
    type: 'boolean',
    default: true
  })
  .check((argv) => {
    if (argv.confirm) {
      argv.dryRun = false;
    }
    return true;
  })
  .help()
  .alias('help', 'h')
  .version(config.version)
  .parseSync();

// Initialize logger
const logger = createLogger('restore-queries');
const auditLogger = createAuditLogger('restore-queries');

/**
 * Sleep helper
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load recovery data from file
 */
function loadRecoveryData(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recovery file not found: ${filePath}`);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data;
}

/**
 * Load cached query data with full details
 */
function loadCachedQueries() {
  const cachePath = path.join(config.paths.root, 'cache', `bulk-data-${config.sfmc.accountId}.json`);

  if (!fs.existsSync(cachePath)) {
    throw new Error(`Cache file not found: ${cachePath}. Cannot restore queries without cached data.`);
  }

  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  return data.data?.queryActivities || [];
}

/**
 * Build a map of query activity name -> target DE from automation steps
 * This extracts target DE info that isn't available in the QueryDefinition SOAP response
 */
function buildQueryTargetDEMap() {
  const cachePath = path.join(config.paths.root, 'cache', `bulk-data-${config.sfmc.accountId}.json`);

  if (!fs.existsSync(cachePath)) {
    return new Map();
  }

  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const automations = data.data?.automations || [];
  const queryToTargetDE = new Map();

  for (const auto of automations) {
    if (auto.steps) {
      for (const step of auto.steps) {
        if (step.activities) {
          for (const activity of step.activities) {
            // objectTypeId 300 = Query Activity
            if (activity.objectTypeId === 300 && activity.targetDataExtensions && activity.targetDataExtensions.length > 0) {
              const targetDE = activity.targetDataExtensions[0];
              queryToTargetDE.set(activity.name, {
                targetDEName: targetDE.name,
                targetDEKey: targetDE.key,
                activityObjectId: activity.activityObjectId
              });
            }
          }
        }
      }
    }
  }

  return queryToTargetDE;
}

/**
 * Check if a DE key looks like an internal clone key
 * Internal clone keys have pattern: __GUID_GUID_1 or similar
 */
function isInternalCloneKey(key) {
  return key && key.startsWith('__') && key.endsWith('_1');
}

/**
 * Extract base name from internal clone DE name
 * Internal clone names have pattern: ___BaseName_1
 */
function extractBaseNameFromClone(name) {
  if (!name) return null;
  // Check for ___Name_1 pattern
  if (name.startsWith('___') && name.endsWith('_1')) {
    return name.slice(3, -2); // Remove ___ prefix and _1 suffix
  }
  return null;
}

/**
 * Look up DE by name in SFMC
 * @param {string} name - DE name to search for
 * @param {object} logger - Logger instance
 * @returns {Promise<{CustomerKey: string, Name: string}|null>}
 */
async function lookupDEByName(name, logger = null) {
  try {
    const filter = `
      <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
        <Property>Name</Property>
        <SimpleOperator>equals</SimpleOperator>
        <Value>${escapeXml(name)}</Value>
      </Filter>`;

    const results = await retrieveDataExtensions(filter, logger);
    if (results && results.length > 0) {
      return results[0];
    }
    return null;
  } catch (error) {
    if (logger) logger.debug(`Error looking up DE by name "${name}": ${error.message}`);
    return null;
  }
}

/**
 * Print restoration preview
 */
function printPreview(queries, summary) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.cyan(`┌${line}┐`));
  console.log(chalk.cyan(`│`) + chalk.bold.cyan('              QUERY ACTIVITY RESTORATION PREVIEW').padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ` Business Unit: ${config.sfmc.accountId}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Queries to Restore: ${queries.length}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` With SQL Text: ${summary.withSql}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` With Target DE: ${summary.withTarget}`.padEnd(width) + chalk.cyan(`│`));
  if (summary.skippedNoTarget > 0) {
    console.log(chalk.cyan(`│`) + chalk.yellow(` Skipped (no target DE): ${summary.skippedNoTarget}`).padEnd(width + 10) + chalk.cyan(`│`));
  }
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ' Sample Queries:'.padEnd(width) + chalk.cyan(`│`));

  queries.slice(0, 15).forEach((q, i) => {
    const name = q.Name?.substring(0, 50) || q.name?.substring(0, 50) || 'Unknown';
    const lineText = `   ${i + 1}. ${name}`;
    console.log(chalk.cyan(`│`) + lineText.substring(0, width).padEnd(width) + chalk.cyan(`│`));
  });

  if (queries.length > 15) {
    console.log(chalk.cyan(`│`) + `   ... and ${queries.length - 15} more`.padEnd(width) + chalk.cyan(`│`));
  }

  console.log(chalk.cyan(`└${line}┘`));
}

/**
 * Print final report
 */
function printReport(results, reportPath) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.green(`┌${line}┐`));
  console.log(chalk.green(`│`) + chalk.bold.white('              QUERY RESTORATION COMPLETE').padEnd(width) + chalk.green(`│`));
  console.log(chalk.green(`├${line}┤`));
  console.log(chalk.green(`│`) + ` Successfully Created: ${chalk.green(results.successful)}`.padEnd(width + 10) + chalk.green(`│`));
  console.log(chalk.green(`│`) + ` Failed: ${chalk.red(results.failed)}`.padEnd(width + 10) + chalk.green(`│`));
  console.log(chalk.green(`│`) + ` Skipped (already exist): ${results.skipped}`.padEnd(width) + chalk.green(`│`));

  if (results.failedItems && results.failedItems.length > 0) {
    console.log(chalk.green(`│`) + ''.padEnd(width) + chalk.green(`│`));
    console.log(chalk.green(`│`) + ' Failed Items:'.padEnd(width) + chalk.green(`│`));
    results.failedItems.slice(0, 10).forEach(item => {
      const lineText = `   • ${item.name}: ${item.error}`.substring(0, width - 2);
      console.log(chalk.green(`│`) + chalk.red(lineText.padEnd(width)) + chalk.green(`│`));
    });
    if (results.failedItems.length > 10) {
      console.log(chalk.green(`│`) + `   ... and ${results.failedItems.length - 10} more failures`.padEnd(width) + chalk.green(`│`));
    }
  }

  console.log(chalk.green(`│`) + ''.padEnd(width) + chalk.green(`│`));
  console.log(chalk.green(`│`) + ` Full Report: ${reportPath}`.padEnd(width) + chalk.green(`│`));
  console.log(chalk.green(`└${line}┘`));
}

/**
 * Save detailed restoration report
 */
function saveReport(results, queries, outputDir) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const filename = `query-restoration-report-${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const report = {
    reportMetadata: {
      generatedAt: new Date().toISOString(),
      businessUnitId: config.sfmc.accountId,
      totalAttempted: queries.length,
      successful: results.successful,
      failed: results.failed,
      skipped: results.skipped
    },
    successfulRestorations: results.successfulItems.map(item => ({
      name: item.name,
      customerKey: item.customerKey,
      newObjectId: item.newObjectId,
      targetDE: item.targetDE,
      restoredAt: item.restoredAt
    })),
    failedRestorations: results.failedItems.map(item => ({
      name: item.name,
      customerKey: item.customerKey,
      error: item.error,
      attemptedAt: item.attemptedAt
    })),
    skippedRestorations: results.skippedItems.map(item => ({
      name: item.name,
      reason: item.reason
    }))
  };

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

/**
 * Main restoration function
 */
async function runRestoration() {
  const startTime = Date.now();

  console.log('');
  console.log(chalk.cyan.bold('SFMC Query Activity Restoration Tool'));
  console.log(chalk.gray('─'.repeat(50)));

  // Log mode
  if (argv.dryRun || !argv.confirm) {
    console.log(chalk.yellow.bold('MODE: DRY RUN (Preview Only)'));
    console.log(chalk.gray('Use --confirm to enable actual creation'));
  } else {
    console.log(chalk.green.bold('MODE: LIVE CREATION'));
  }
  console.log('');

  try {
    // Validate configuration
    validateConfig();

    // Set audit options
    auditLogger.setOptions({
      input: argv.input,
      dryRun: argv.dryRun,
      confirm: argv.confirm,
      limit: argv.limit,
      filter: argv.filter,
      skipExisting: argv.skipExisting
    });

    // Load recovery data
    const spinner = ora('Loading recovery data...').start();

    let queriesToRestore = [];
    let queryTargetDEMap = new Map();

    // Try to load from recovery file first
    if (fs.existsSync(argv.input)) {
      const recoveryData = loadRecoveryData(argv.input);
      spinner.text = 'Loading cached query details...';

      // Load full cached data to get complete query info
      const cachedQueries = loadCachedQueries();
      const cachedByName = new Map();
      cachedQueries.forEach(q => {
        if (q.Name) cachedByName.set(q.Name, q);
      });

      // Build target DE map from automation steps
      spinner.text = 'Extracting target DEs from automation steps...';
      queryTargetDEMap = buildQueryTargetDEMap();

      // Match recovery queries to cached data and enrich with target DE
      for (const rq of recoveryData.queries || []) {
        const cached = cachedByName.get(rq.name);
        if (cached && cached.QueryText) {
          // Enrich with target DE from automation steps
          const targetInfo = queryTargetDEMap.get(cached.Name);
          if (targetInfo) {
            cached._targetDEKey = targetInfo.targetDEKey;
            cached._targetDEName = targetInfo.targetDEName;
          }
          queriesToRestore.push(cached);
        }
      }

      const withTargetDE = queriesToRestore.filter(q => q._targetDEKey).length;
      spinner.succeed(`Loaded ${queriesToRestore.length} queries (${withTargetDE} with target DE from automations)`);
    } else {
      spinner.fail(`Recovery file not found: ${argv.input}`);
      console.log(chalk.yellow('\nRun the deletion audit first to generate the recovery file.'));
      process.exit(1);
    }

    if (queriesToRestore.length === 0) {
      console.log(chalk.yellow('No queries found to restore.'));
      process.exit(0);
    }

    // Filter to only queries with target DE (required for creation)
    const queriesWithTarget = queriesToRestore.filter(q => q._targetDEKey);
    const queriesWithoutTarget = queriesToRestore.filter(q => !q._targetDEKey);

    if (queriesWithoutTarget.length > 0) {
      console.log(chalk.yellow(`\n⚠ ${queriesWithoutTarget.length} queries have no target DE and will be skipped.`));
      console.log(chalk.gray('  (Target DE is required to create a Query Activity)'));
    }

    // Only restore queries that have a target DE
    queriesToRestore = queriesWithTarget;

    if (queriesToRestore.length === 0) {
      console.log(chalk.yellow('\nNo queries with target DE found to restore.'));
      console.log(chalk.gray('Target DE info is extracted from automation steps.'));
      console.log(chalk.gray('Queries not used in automations cannot be auto-restored.'));
      process.exit(0);
    }

    // Apply filter if specified
    if (argv.filter) {
      const filterRegex = new RegExp(argv.filter, 'i');
      queriesToRestore = queriesToRestore.filter(q => filterRegex.test(q.Name));
      console.log(chalk.gray(`After filter: ${queriesToRestore.length} queries`));
    }

    // Apply limit if specified
    if (argv.limit && argv.limit < queriesToRestore.length) {
      queriesToRestore = queriesToRestore.slice(0, argv.limit);
      console.log(chalk.gray(`Limited to: ${queriesToRestore.length} queries`));
    }

    // Calculate summary
    const summary = {
      withSql: queriesToRestore.filter(q => q.QueryText).length,
      withTarget: queriesToRestore.filter(q => q._targetDEKey).length,
      skippedNoTarget: queriesWithoutTarget.length
    };

    // Show preview
    printPreview(queriesToRestore, summary);

    // Dry run exit
    if (argv.dryRun) {
      console.log('');
      console.log(chalk.yellow('DRY RUN COMPLETE - No queries were created.'));
      console.log(chalk.gray('Use --confirm to enable actual creation.'));
      process.exit(0);
    }

    // Test connection
    spinner.start('Testing SFMC connection...');
    const connectionResult = await testConnection(logger);

    if (!connectionResult.success) {
      spinner.fail('Connection failed');
      logger.error(connectionResult.error);
      process.exit(1);
    }

    spinner.succeed('SFMC connection successful');

    // Execute restoration
    console.log('');
    console.log(chalk.green.bold('Starting query restoration...'));
    console.log('');

    const results = {
      successful: 0,
      failed: 0,
      skipped: 0,
      successfulItems: [],
      failedItems: [],
      skippedItems: []
    };

    for (let i = 0; i < queriesToRestore.length; i++) {
      const query = queriesToRestore[i];
      const progress = `[${i + 1}/${queriesToRestore.length}]`;

      spinner.start(`${progress} Creating: ${query.Name}`);

      try {
        // Prepare query data for creation
        const queryData = {
          Name: query.Name,
          CustomerKey: query.CustomerKey || query.Name.replace(/[^a-zA-Z0-9_-]/g, '_'),
          QueryText: query.QueryText,
          TargetType: query.TargetType || 'DE',
          TargetUpdateType: query.TargetUpdateType || 'Overwrite',
          CategoryID: query.CategoryID
        };

        // Add target DE from automation steps (enriched earlier)
        let targetDEKey = query._targetDEKey || query.DataExtensionTarget?.CustomerKey;
        let resolvedDEName = query._targetDEName;

        // Check if target DE key is an internal clone key (e.g., __GUID_GUID_1)
        // If so, try to look up the actual DE by extracting the base name
        if (targetDEKey && isInternalCloneKey(targetDEKey) && query._targetDEName) {
          const baseName = extractBaseNameFromClone(query._targetDEName);
          if (baseName) {
            spinner.text = `${progress} Looking up DE: ${baseName}`;
            const foundDE = await lookupDEByName(baseName, logger);
            if (foundDE) {
              targetDEKey = foundDE.CustomerKey;
              resolvedDEName = foundDE.Name;
              spinner.text = `${progress} Creating: ${query.Name} -> ${resolvedDEName}`;
            } else {
              // Could not find the restored DE
              spinner.fail(`${progress} Failed: ${query.Name} - Could not find restored DE "${baseName}"`);
              results.failed++;
              results.failedItems.push({
                name: query.Name,
                customerKey: queryData.CustomerKey,
                error: `Could not find restored DE "${baseName}" (original: ${query._targetDEName})`,
                attemptedAt: new Date().toISOString()
              });
              auditLogger.addFailure({
                name: query.Name,
                customerKey: queryData.CustomerKey
              }, `Could not find restored DE "${baseName}"`);
              await sleep(config.safety.apiRateLimitDelayMs);
              continue;
            }
          }
        }

        if (targetDEKey) {
          queryData.DataExtensionTargetKey = targetDEKey;
        }

        const result = await createQueryActivity(queryData, logger);

        if (result.success) {
          spinner.succeed(`${progress} Created: ${query.Name} -> ${resolvedDEName || 'N/A'}`);
          results.successful++;
          results.successfulItems.push({
            name: query.Name,
            customerKey: queryData.CustomerKey,
            newObjectId: result.objectId,
            targetDE: targetDEKey || 'N/A',
            targetDEName: resolvedDEName || 'N/A',
            restoredAt: new Date().toISOString()
          });

          auditLogger.addSuccess({
            name: query.Name,
            customerKey: queryData.CustomerKey,
            newObjectId: result.objectId
          });
        } else {
          spinner.fail(`${progress} Failed: ${query.Name} - ${result.error}`);
          results.failed++;
          results.failedItems.push({
            name: query.Name,
            customerKey: queryData.CustomerKey,
            error: result.error,
            attemptedAt: new Date().toISOString()
          });

          auditLogger.addFailure({
            name: query.Name,
            customerKey: queryData.CustomerKey
          }, result.error);
        }
      } catch (error) {
        spinner.fail(`${progress} Error: ${query.Name} - ${error.message}`);
        results.failed++;
        results.failedItems.push({
          name: query.Name,
          customerKey: query.CustomerKey,
          error: error.message,
          attemptedAt: new Date().toISOString()
        });

        auditLogger.addFailure({
          name: query.Name,
          customerKey: query.CustomerKey
        }, error.message);
      }

      // Rate limiting
      await sleep(config.safety.apiRateLimitDelayMs);

      // Batch progress
      if ((i + 1) % argv.batchSize === 0 && i + 1 < queriesToRestore.length) {
        console.log(chalk.cyan(`\n--- Batch complete: ${i + 1}/${queriesToRestore.length} ---\n`));
      }
    }

    // Save detailed report
    const reportPath = saveReport(results, queriesToRestore, config.paths.audit);

    // Save audit log
    const exitCode = results.failed > 0 ? 1 : 0;
    auditLogger.save(exitCode);

    // Print summary
    printReport(results, reportPath);

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log('');
    console.log(chalk.green(`✓ Restoration complete in ${duration} seconds`));
    console.log(chalk.gray(`  Log file: ${logger.logFilePath}`));

    process.exit(exitCode);

  } catch (error) {
    logger.error(`Restoration failed: ${error.message}`);
    logger.debug(error.stack);
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    auditLogger.save(1);
    process.exit(1);
  }
}

// Run restoration
runRestoration();
