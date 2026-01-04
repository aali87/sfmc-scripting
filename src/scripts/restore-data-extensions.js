#!/usr/bin/env node

/**
 * SFMC Data Extension Restoration Script
 *
 * Restores Data Extensions from backup files using SOAP API.
 * Preserves original CustomerKey which is critical for maintaining
 * references from Query Activities, Import Activities, and Automations.
 *
 * IMPORTANT: Defaults to DRY RUN mode. Use --confirm to enable actual creation.
 *
 * Usage:
 *   node src/scripts/restore-data-extensions.js [options]
 *   node src/scripts/restore-data-extensions.js --filter "^9876" --folder "Data Extensions/9876_Indigo" --confirm
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
import { createDataExtension } from '../lib/sfmc-soap.js';
import { getFolderByPath, getFolderByName } from '../lib/folder-service.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('backup-dir', {
    alias: 'b',
    describe: 'Specific backup directory to use (e.g., "20251228-191408")',
    type: 'string'
  })
  .option('filter', {
    alias: 'f',
    describe: 'Filter DE names by regex pattern (e.g., "^9876")',
    type: 'string'
  })
  .option('folder', {
    describe: 'Target folder path for restored DEs (e.g., "Data Extensions/9876_Indigo")',
    type: 'string'
  })
  .option('folder-id', {
    describe: 'Target folder ID (alternative to --folder)',
    type: 'number'
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
    describe: 'Maximum number of DEs to restore (for testing)',
    type: 'number'
  })
  .option('batch-size', {
    describe: 'Number of DEs to create before pausing',
    type: 'number',
    default: 25
  })
  .option('use-original-folder', {
    describe: 'Use original folder IDs from backup (may fail if folders deleted)',
    type: 'boolean',
    default: false
  })
  .check((argv) => {
    if (argv.confirm) {
      argv.dryRun = false;
    }
    if (!argv.folder && !argv.folderId && !argv.useOriginalFolder) {
      throw new Error('Must specify --folder, --folder-id, or --use-original-folder');
    }
    return true;
  })
  .help()
  .alias('help', 'h')
  .version(config.version)
  .parseSync();

// Initialize logger
const logger = createLogger('restore-data-extensions');
const auditLogger = createAuditLogger('restore-data-extensions');

/**
 * Sleep helper
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find all backup files matching filter
 */
function findBackupFiles(backupDir, filter) {
  const backupPath = path.join(config.paths.root, 'backup');

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup directory not found: ${backupPath}`);
  }

  // Get directories to search
  let dirsToSearch = [];

  if (backupDir) {
    const specificDir = path.join(backupPath, backupDir);
    if (!fs.existsSync(specificDir)) {
      throw new Error(`Specified backup directory not found: ${specificDir}`);
    }
    dirsToSearch = [backupDir];
  } else {
    // Get all backup directories sorted by date (newest first)
    dirsToSearch = fs.readdirSync(backupPath)
      .filter(d => fs.statSync(path.join(backupPath, d)).isDirectory())
      .sort((a, b) => b.localeCompare(a));
  }

  const backups = [];
  const filterRegex = filter ? new RegExp(filter, 'i') : null;
  const seenCustomerKeys = new Set();

  // Search through directories (newest first) and collect unique DEs by CustomerKey
  for (const dir of dirsToSearch) {
    const dirPath = path.join(backupPath, dir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if not a DE backup
        if (!data.dataExtension || !data.fields) {
          continue;
        }

        const deName = data.dataExtension.name;
        const customerKey = data.dataExtension.customerKey;

        // Skip if we already have a newer backup of this DE
        if (seenCustomerKeys.has(customerKey)) {
          continue;
        }

        // Apply filter
        if (filterRegex && !filterRegex.test(deName)) {
          continue;
        }

        seenCustomerKeys.add(customerKey);
        backups.push({
          filePath,
          backupDir: dir,
          ...data
        });
      } catch (err) {
        // Skip invalid files
      }
    }
  }

  return backups;
}

/**
 * Print restoration preview
 */
function printPreview(backups, targetFolder, summary) {
  const width = 80;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.cyan(`┌${line}┐`));
  console.log(chalk.cyan(`│`) + chalk.bold.cyan('              DATA EXTENSION RESTORATION PREVIEW').padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ` Business Unit: ${config.sfmc.accountId}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` DEs to Restore: ${backups.length}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Target Folder: ${targetFolder.name} (ID: ${targetFolder.id})`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Total Fields: ${summary.totalFields}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Sendable DEs: ${summary.sendable}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ' Sample Data Extensions:'.padEnd(width) + chalk.cyan(`│`));

  backups.slice(0, 15).forEach((backup, i) => {
    const name = backup.dataExtension.name.substring(0, 55);
    const fields = backup.fields.length;
    const lineText = `   ${i + 1}. ${name} (${fields} fields)`;
    console.log(chalk.cyan(`│`) + lineText.substring(0, width).padEnd(width) + chalk.cyan(`│`));
  });

  if (backups.length > 15) {
    console.log(chalk.cyan(`│`) + `   ... and ${backups.length - 15} more`.padEnd(width) + chalk.cyan(`│`));
  }

  console.log(chalk.cyan(`└${line}┘`));
}

/**
 * Print final report
 */
function printReport(results, reportPath) {
  const width = 80;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.green(`┌${line}┐`));
  console.log(chalk.green(`│`) + chalk.bold.white('              DATA EXTENSION RESTORATION COMPLETE').padEnd(width) + chalk.green(`│`));
  console.log(chalk.green(`├${line}┤`));
  console.log(chalk.green(`│`) + ` Successfully Created: ${chalk.green(results.successful)}`.padEnd(width + 10) + chalk.green(`│`));
  console.log(chalk.green(`│`) + ` Failed: ${chalk.red(results.failed)}`.padEnd(width + 10) + chalk.green(`│`));
  console.log(chalk.green(`│`) + ` Skipped: ${results.skipped}`.padEnd(width) + chalk.green(`│`));

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
function saveReport(results, backups, outputDir) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const filename = `de-restoration-report-${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const report = {
    reportMetadata: {
      generatedAt: new Date().toISOString(),
      businessUnitId: config.sfmc.accountId,
      totalAttempted: backups.length,
      successful: results.successful,
      failed: results.failed,
      skipped: results.skipped
    },
    successfulRestorations: results.successfulItems.map(item => ({
      name: item.name,
      customerKey: item.customerKey,
      newObjectId: item.newObjectId,
      fieldCount: item.fieldCount,
      folderId: item.folderId,
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
  console.log(chalk.cyan.bold('SFMC Data Extension Restoration Tool'));
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
      backupDir: argv.backupDir,
      filter: argv.filter,
      folder: argv.folder,
      folderId: argv.folderId,
      dryRun: argv.dryRun,
      confirm: argv.confirm,
      limit: argv.limit,
      useOriginalFolder: argv.useOriginalFolder
    });

    // Find backup files
    const spinner = ora('Searching backup files...').start();

    const backups = findBackupFiles(argv.backupDir, argv.filter);

    if (backups.length === 0) {
      spinner.fail('No matching backup files found');
      console.log(chalk.yellow('\nCheck your --filter pattern and --backup-dir options.'));
      process.exit(0);
    }

    spinner.succeed(`Found ${backups.length} Data Extension backups`);

    // Apply limit if specified
    let backupsToRestore = backups;
    if (argv.limit && argv.limit < backups.length) {
      backupsToRestore = backups.slice(0, argv.limit);
      console.log(chalk.gray(`Limited to: ${backupsToRestore.length} DEs`));
    }

    // Resolve target folder
    spinner.start('Resolving target folder...');

    let targetFolder;

    if (argv.folderId) {
      targetFolder = { id: argv.folderId, name: `Folder ID ${argv.folderId}` };
    } else if (argv.folder) {
      targetFolder = await getFolderByPath(argv.folder, logger);

      if (!targetFolder) {
        // Try by name as fallback
        const folderName = argv.folder.split('/').pop();
        targetFolder = await getFolderByName(folderName, logger);
      }

      if (!targetFolder) {
        spinner.fail(`Target folder not found: ${argv.folder}`);
        console.log(chalk.yellow('\nMake sure the folder exists in SFMC.'));
        console.log(chalk.gray('You can also use --folder-id to specify the folder ID directly.'));
        process.exit(1);
      }
    } else if (argv.useOriginalFolder) {
      // Will use each DE's original folder ID
      targetFolder = { id: null, name: 'Original folders (from backup)' };
    }

    spinner.succeed(`Target folder: ${targetFolder.name}${targetFolder.id ? ` (ID: ${targetFolder.id})` : ''}`);

    // Calculate summary
    const summary = {
      totalFields: backupsToRestore.reduce((sum, b) => sum + b.fields.length, 0),
      sendable: backupsToRestore.filter(b => b.dataExtension.isSendable).length
    };

    // Show preview
    printPreview(backupsToRestore, targetFolder, summary);

    // Dry run exit
    if (argv.dryRun) {
      console.log('');
      console.log(chalk.yellow('DRY RUN COMPLETE - No Data Extensions were created.'));
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
    console.log(chalk.green.bold('Starting Data Extension restoration...'));
    console.log('');

    const results = {
      successful: 0,
      failed: 0,
      skipped: 0,
      successfulItems: [],
      failedItems: [],
      skippedItems: []
    };

    for (let i = 0; i < backupsToRestore.length; i++) {
      const backup = backupsToRestore[i];
      const de = backup.dataExtension;
      const progress = `[${i + 1}/${backupsToRestore.length}]`;

      spinner.start(`${progress} Creating: ${de.name}`);

      try {
        // Determine folder ID
        const folderId = argv.useOriginalFolder ? de.folderId : targetFolder.id;

        // Prepare DE data for creation
        const deData = {
          Name: de.name,
          CustomerKey: de.customerKey,
          Description: de.description || '',
          CategoryID: folderId,
          IsSendable: de.isSendable || false,
          IsTestable: de.isTestable || false,
          Fields: backup.fields
        };

        // Add sendable configuration if applicable
        if (de.isSendable && de.sendableSubscriberField && de.sendableDataExtensionField) {
          deData.SendableSubscriberField = de.sendableSubscriberField;
          deData.SendableDataExtensionField = de.sendableDataExtensionField;
        }

        const result = await createDataExtension(deData, logger);

        if (result.success) {
          spinner.succeed(`${progress} Created: ${de.name} (${backup.fields.length} fields)`);
          results.successful++;
          results.successfulItems.push({
            name: de.name,
            customerKey: de.customerKey,
            newObjectId: result.objectId,
            fieldCount: backup.fields.length,
            folderId: folderId,
            restoredAt: new Date().toISOString()
          });

          auditLogger.addSuccess({
            name: de.name,
            customerKey: de.customerKey,
            newObjectId: result.objectId
          });
        } else {
          spinner.fail(`${progress} Failed: ${de.name} - ${result.error}`);
          results.failed++;
          results.failedItems.push({
            name: de.name,
            customerKey: de.customerKey,
            error: result.error,
            attemptedAt: new Date().toISOString()
          });

          auditLogger.addFailure({
            name: de.name,
            customerKey: de.customerKey
          }, result.error);
        }
      } catch (error) {
        spinner.fail(`${progress} Error: ${de.name} - ${error.message}`);
        results.failed++;
        results.failedItems.push({
          name: de.name,
          customerKey: de.customerKey,
          error: error.message,
          attemptedAt: new Date().toISOString()
        });

        auditLogger.addFailure({
          name: de.name,
          customerKey: de.customerKey
        }, error.message);
      }

      // Rate limiting
      await sleep(config.safety.apiRateLimitDelayMs);

      // Batch progress
      if ((i + 1) % argv.batchSize === 0 && i + 1 < backupsToRestore.length) {
        console.log(chalk.cyan(`\n--- Batch complete: ${i + 1}/${backupsToRestore.length} ---\n`));
      }
    }

    // Save detailed report
    const reportPath = saveReport(results, backupsToRestore, config.paths.audit);

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
