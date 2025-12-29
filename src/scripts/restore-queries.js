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
import { createQueryActivity } from '../lib/sfmc-soap.js';

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

      // Match recovery queries to cached data
      for (const rq of recoveryData.queries || []) {
        const cached = cachedByName.get(rq.name);
        if (cached && cached.QueryText) {
          queriesToRestore.push(cached);
        }
      }

      spinner.succeed(`Loaded ${queriesToRestore.length} queries from recovery file`);
    } else {
      spinner.fail(`Recovery file not found: ${argv.input}`);
      console.log(chalk.yellow('\nRun the deletion audit first to generate the recovery file.'));
      process.exit(1);
    }

    if (queriesToRestore.length === 0) {
      console.log(chalk.yellow('No queries found to restore.'));
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
      withTarget: queriesToRestore.filter(q => q.DataExtensionTarget?.CustomerKey).length
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

        // Add target DE if available
        if (query.DataExtensionTarget?.CustomerKey) {
          queryData.DataExtensionTargetKey = query.DataExtensionTarget.CustomerKey;
        }

        const result = await createQueryActivity(queryData, logger);

        if (result.success) {
          spinner.succeed(`${progress} Created: ${query.Name}`);
          results.successful++;
          results.successfulItems.push({
            name: query.Name,
            customerKey: queryData.CustomerKey,
            newObjectId: result.objectId,
            targetDE: query.DataExtensionTarget?.CustomerKey || 'N/A',
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
