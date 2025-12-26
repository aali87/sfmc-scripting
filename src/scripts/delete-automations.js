#!/usr/bin/env node

/**
 * SFMC Automation Deletion Script
 *
 * Deletes automations based on a provided list of automation names,
 * with comprehensive safety checks, backup, and audit logging.
 *
 * IMPORTANT: Defaults to DRY RUN mode. Use --confirm to enable actual deletion.
 *
 * Usage:
 *   node src/scripts/delete-automations.js --file "automations.txt" [options]
 *   node src/scripts/delete-automations.js --names "Auto1,Auto2,Auto3" [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import config from '../config/index.js';
import { createLogger, createAuditLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import {
  getAutomations,
  getAutomationByName,
  getAutomationWithMetadata,
  deleteAutomation,
  createAutomationBackup
} from '../lib/sfmc-rest.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --file <path> OR --names <list> [options]')
  .option('file', {
    alias: 'f',
    describe: 'Path to file containing automation names (one per line)',
    type: 'string'
  })
  .option('names', {
    alias: 'n',
    describe: 'Comma-separated list of automation names',
    type: 'string'
  })
  .option('dry-run', {
    describe: 'Preview only, no deletions (DEFAULT)',
    type: 'boolean',
    default: true
  })
  .option('confirm', {
    describe: 'Enable actual deletion mode (still requires confirmation)',
    type: 'boolean',
    default: false
  })
  .option('backup', {
    describe: 'Backup automation configurations before deletion',
    type: 'boolean',
    default: true
  })
  .option('skip-running', {
    describe: 'Skip automations that are currently running',
    type: 'boolean',
    default: true
  })
  .option('force-delete-running', {
    describe: 'Delete automations even if they are running (DANGEROUS)',
    type: 'boolean',
    default: false
  })
  .option('batch-size', {
    describe: 'Number of automations to delete before pausing',
    type: 'number',
    default: 5
  })
  .option('interactive', {
    alias: 'i',
    describe: 'Interactively select which automations to delete',
    type: 'boolean',
    default: false
  })
  .option('non-interactive', {
    describe: 'Non-interactive mode for scheduled execution',
    type: 'boolean',
    default: false
  })
  .option('confirm-phrase', {
    describe: 'Confirmation phrase for non-interactive mode',
    type: 'string'
  })
  .check((argv) => {
    // Must provide either file or names
    if (!argv.file && !argv.names) {
      throw new Error('You must provide either --file or --names');
    }

    // If --confirm is used, dry-run should be false
    if (argv.confirm) {
      argv.dryRun = false;
    }

    // Non-interactive mode requires confirm-phrase
    if (argv.nonInteractive && argv.confirm && !argv.confirmPhrase) {
      throw new Error('--non-interactive with --confirm requires --confirm-phrase');
    }

    return true;
  })
  .help()
  .alias('help', 'h')
  .version(config.version)
  .parseSync();

// Initialize logger
const logger = createLogger('delete-automations');
const auditLogger = createAuditLogger('delete-automations');

/**
 * Sleep helper
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  return dayjs(dateStr).format('YYYY-MM-DD HH:mm:ss');
}

/**
 * Get automation status display
 */
function getStatusDisplay(status) {
  const statusMap = {
    0: chalk.gray('Building'),
    1: chalk.green('Ready'),
    2: chalk.blue('Running'),
    3: chalk.red('Paused'),
    4: chalk.red('Stopped'),
    5: chalk.yellow('Scheduled'),
    6: chalk.red('Error'),
    7: chalk.cyan('Running (Waiting)'),
    8: chalk.gray('Inactive')
  };
  return statusMap[status] || chalk.gray(`Unknown (${status})`);
}

/**
 * Parse automation names from input
 */
function parseAutomationNames() {
  let names = [];

  if (argv.file) {
    // Read from file
    if (!fs.existsSync(argv.file)) {
      console.error(chalk.red(`File not found: ${argv.file}`));
      process.exit(1);
    }

    const content = fs.readFileSync(argv.file, 'utf-8');
    names = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Skip empty lines and comments
  } else if (argv.names) {
    // Parse from comma-separated list
    names = argv.names
      .split(',')
      .map(name => name.trim())
      .filter(name => name);
  }

  return [...new Set(names)]; // Deduplicate
}

/**
 * Print automation preview
 */
function printPreview(automations, backupDir) {
  const width = 80;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.yellow(`┌${line}┐`));
  console.log(chalk.yellow(`│`) + chalk.bold.yellow('                      AUTOMATION DELETION PREVIEW').padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`├${line}┤`));
  console.log(chalk.yellow(`│`) + ` Business Unit: ${config.sfmc.accountId}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` Total Automations to Delete: ${automations.length}`.padEnd(width) + chalk.yellow(`│`));

  if (backupDir) {
    console.log(chalk.yellow(`│`) + ` Backups: ${backupDir}`.padEnd(width) + chalk.yellow(`│`));
  }

  console.log(chalk.yellow(`├${line}┤`));
  console.log(chalk.yellow(`│`) + ' Automations:'.padEnd(width) + chalk.yellow(`│`));

  for (const auto of automations) {
    const statusText = getStatusDisplay(auto.statusId);
    const name = auto.name.length > 35 ? auto.name.substring(0, 32) + '...' : auto.name;
    console.log(chalk.yellow(`│`) + `   - ${name.padEnd(38)} ${statusText}`.padEnd(width) + chalk.yellow(`│`));
  }

  console.log(chalk.yellow(`└${line}┘`));
  console.log('');
}

/**
 * Print detailed automation info
 */
function printAutomationDetails(automations) {
  console.log('');
  console.log(chalk.cyan('Automation Details:'));
  console.log(chalk.gray('─'.repeat(100)));

  for (const auto of automations) {
    console.log(`  ${chalk.bold(auto.name)}`);
    console.log(`    ID: ${auto.id}`);
    console.log(`    Key: ${auto.key || 'N/A'}`);
    console.log(`    Status: ${getStatusDisplay(auto.statusId)}`);
    console.log(`    Created: ${formatDate(auto.createdDate)}`);
    console.log(`    Last Modified: ${formatDate(auto.modifiedDate)}`);
    console.log(`    Last Run: ${formatDate(auto.lastRunTime)}`);
    console.log('');
  }
}

/**
 * Backup automations to JSON files
 */
async function backupAutomations(automations, spinner) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const backupDir = path.join(config.paths.backup, `automations-${timestamp}`);

  fs.mkdirSync(backupDir, { recursive: true });

  for (let i = 0; i < automations.length; i++) {
    const auto = automations[i];
    spinner.text = `Backing up automation ${i + 1}/${automations.length}: ${auto.name}`;

    try {
      const backup = createAutomationBackup(auto);
      const filename = `${auto.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${auto.id}.json`;
      const filepath = path.join(backupDir, filename);

      fs.writeFileSync(filepath, JSON.stringify(backup, null, 2));
      logger.debug(`Backed up automation: ${auto.name} to ${filepath}`);
    } catch (error) {
      logger.warn(`Failed to backup automation ${auto.name}: ${error.message}`);
    }
  }

  return backupDir;
}

/**
 * Main execution
 */
async function main() {
  const startTime = Date.now();

  console.log('');
  console.log(chalk.cyan.bold('SFMC Automation Deletion Tool'));
  console.log(chalk.gray('─'.repeat(50)));

  // Log mode
  if (argv.dryRun || !argv.confirm) {
    console.log(chalk.yellow.bold('MODE: DRY RUN (Preview Only)'));
    console.log(chalk.gray('Use --confirm to enable actual deletion'));
  } else {
    console.log(chalk.red.bold('MODE: LIVE DELETION'));
  }
  console.log('');

  // Set audit options
  auditLogger.setOptions({
    file: argv.file || null,
    names: argv.names || null,
    dryRun: argv.dryRun,
    confirm: argv.confirm,
    backup: argv.backup,
    skipRunning: argv.skipRunning,
    forceDeleteRunning: argv.forceDeleteRunning,
    interactive: argv.interactive
  });

  // Parse automation names
  const requestedNames = parseAutomationNames();

  if (requestedNames.length === 0) {
    console.log(chalk.yellow('No automation names provided.'));
    auditLogger.save(0);
    process.exit(0);
  }

  console.log(chalk.cyan(`Requested automations to delete: ${requestedNames.length}`));
  logger.info(`Processing ${requestedNames.length} automation names`);

  // Test connection
  const spinner = ora('Testing SFMC connection...').start();

  try {
    await testConnection();
    spinner.succeed('SFMC connection successful');
  } catch (error) {
    spinner.fail('SFMC connection failed');
    logger.error('Connection failed:', error);
    auditLogger.save(1);
    process.exit(1);
  }

  // Fetch all automations
  spinner.start('Fetching automations from SFMC...');

  let allAutomations;
  try {
    allAutomations = await getAutomations(logger);
    spinner.succeed(`Found ${allAutomations.length} automations in SFMC`);
  } catch (error) {
    spinner.fail('Failed to fetch automations');
    logger.error('Failed to fetch automations:', error);
    auditLogger.save(1);
    process.exit(1);
  }

  // Match requested names to actual automations
  spinner.start('Matching automation names...');

  const automationsToDelete = [];
  const notFound = [];
  const runningSkipped = [];

  for (const name of requestedNames) {
    const automation = await getAutomationByName(name, allAutomations, logger);

    if (!automation) {
      notFound.push(name);
      auditLogger.addSkipped({ name }, 'Automation not found');
      continue;
    }

    // Get full metadata
    let fullAutomation;
    try {
      fullAutomation = await getAutomationWithMetadata(automation.id, logger);
    } catch (error) {
      logger.warn(`Could not get full metadata for ${name}, using basic info`);
      fullAutomation = automation;
    }

    // Check if running
    if (fullAutomation.statusId === 2 || fullAutomation.statusId === 7) {
      if (argv.skipRunning && !argv.forceDeleteRunning) {
        runningSkipped.push(fullAutomation);
        auditLogger.addSkipped({
          id: fullAutomation.id,
          name: fullAutomation.name,
          status: fullAutomation.statusId
        }, 'Automation is currently running');
        continue;
      }
    }

    automationsToDelete.push(fullAutomation);
  }

  spinner.succeed('Automation matching complete');

  // Report not found
  if (notFound.length > 0) {
    console.log('');
    console.log(chalk.yellow(`Automations not found (${notFound.length}):`));
    for (const name of notFound.slice(0, 10)) {
      console.log(chalk.yellow(`  - ${name}`));
    }
    if (notFound.length > 10) {
      console.log(chalk.yellow(`  ... and ${notFound.length - 10} more`));
    }
  }

  // Report running skipped
  if (runningSkipped.length > 0) {
    console.log('');
    console.log(chalk.yellow(`Running automations skipped (${runningSkipped.length}):`));
    for (const auto of runningSkipped.slice(0, 5)) {
      console.log(chalk.yellow(`  - ${auto.name} (${getStatusDisplay(auto.statusId)})`));
    }
    if (runningSkipped.length > 5) {
      console.log(chalk.yellow(`  ... and ${runningSkipped.length - 5} more`));
    }
  }

  // Check if anything to delete
  if (automationsToDelete.length === 0) {
    console.log('');
    console.log(chalk.yellow('No automations to delete.'));
    auditLogger.save(0);
    process.exit(0);
  }

  // Set pre-execution state
  auditLogger.setPreExecutionState({
    requestedCount: requestedNames.length,
    foundCount: automationsToDelete.length,
    notFoundCount: notFound.length,
    runningSkippedCount: runningSkipped.length,
    automations: automationsToDelete.map(a => ({
      id: a.id,
      name: a.name,
      key: a.key,
      status: a.statusId,
      createdDate: a.createdDate,
      lastRunTime: a.lastRunTime
    }))
  });

  // Interactive selection
  if (argv.interactive && !argv.nonInteractive) {
    const { selected } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selected',
      message: 'Select automations to delete:',
      choices: automationsToDelete.map(auto => ({
        name: `${auto.name} (${getStatusDisplay(auto.statusId)}) - Last Run: ${formatDate(auto.lastRunTime)}`,
        value: auto.id,
        checked: true
      })),
      pageSize: 20
    }]);

    const selectedSet = new Set(selected);
    const filteredOut = automationsToDelete.filter(a => !selectedSet.has(a.id));

    // Mark filtered out as skipped
    for (const auto of filteredOut) {
      auditLogger.addSkipped({
        id: auto.id,
        name: auto.name
      }, 'Deselected in interactive mode');
    }

    // Update list
    automationsToDelete.length = 0;
    automationsToDelete.push(...automationsToDelete.filter(a => selectedSet.has(a.id)));

    if (automationsToDelete.length === 0) {
      console.log(chalk.yellow('No automations selected. Exiting.'));
      auditLogger.save(0);
      process.exit(0);
    }
  }

  // Backup automations
  let backupDir = null;
  if (argv.backup) {
    spinner.start('Backing up automation configurations...');
    try {
      backupDir = await backupAutomations(automationsToDelete, spinner);
      spinner.succeed(`Backed up ${automationsToDelete.length} automations to ${backupDir}`);
      auditLogger.setMetadata('backupDirectory', backupDir);
    } catch (error) {
      spinner.warn('Some backups failed, continuing...');
      logger.warn('Backup error:', error);
    }
  }

  // Print preview
  printPreview(automationsToDelete, backupDir);
  printAutomationDetails(automationsToDelete);

  // Dry run exit
  if (argv.dryRun || !argv.confirm) {
    console.log('');
    console.log(chalk.yellow('DRY RUN COMPLETE - No automations were deleted.'));
    console.log(chalk.gray('Use --confirm to enable actual deletion.'));

    // Save audit log
    const auditPath = auditLogger.save(0);
    console.log(chalk.gray(`Audit log: ${auditPath}`));
    console.log(chalk.gray(`Operation log: ${logger.logFilePath}`));

    process.exit(0);
  }

  // Confirmation for live deletion
  console.log('');
  console.log(chalk.red.bold('WARNING: This will PERMANENTLY delete the above automations!'));
  console.log(chalk.red('This action cannot be undone (backups are for reference only).'));
  console.log('');

  let proceed = false;

  if (argv.nonInteractive) {
    // Check confirmation phrase
    const expectedPhrase = `DELETE ${automationsToDelete.length} AUTOMATIONS`;
    if (argv.confirmPhrase === expectedPhrase) {
      proceed = true;
    } else {
      console.log(chalk.red('Confirmation phrase does not match. Aborting.'));
      console.log(chalk.gray(`Expected: ${expectedPhrase}`));
      auditLogger.save(1);
      process.exit(1);
    }
  } else {
    // Interactive confirmation
    const { confirmDelete } = await inquirer.prompt([{
      type: 'input',
      name: 'confirmDelete',
      message: `Type "DELETE ${automationsToDelete.length} AUTOMATIONS" to confirm:`
    }]);

    proceed = confirmDelete === `DELETE ${automationsToDelete.length} AUTOMATIONS`;
  }

  if (!proceed) {
    console.log(chalk.yellow('Deletion cancelled.'));
    auditLogger.save(0);
    process.exit(0);
  }

  // Execute deletion
  console.log('');
  console.log(chalk.red.bold('Starting automation deletion...'));
  console.log('');

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < automationsToDelete.length; i++) {
    const auto = automationsToDelete[i];
    const progress = `[${i + 1}/${automationsToDelete.length}]`;

    spinner.start(`${progress} Deleting: ${auto.name}`);

    try {
      const result = await deleteAutomation(auto.id, logger);

      if (result.success) {
        spinner.succeed(`${progress} Deleted: ${auto.name}`);
        successCount++;

        auditLogger.addSuccess({
          id: auto.id,
          name: auto.name,
          key: auto.key,
          status: auto.statusId,
          createdDate: auto.createdDate,
          lastRunTime: auto.lastRunTime
        });
      } else {
        spinner.fail(`${progress} Failed to delete: ${auto.name} - ${result.error}`);
        failCount++;

        auditLogger.addFailure({
          id: auto.id,
          name: auto.name
        }, result.error);
      }
    } catch (error) {
      spinner.fail(`${progress} Error deleting: ${auto.name} - ${error.message}`);
      failCount++;

      auditLogger.addFailure({
        id: auto.id,
        name: auto.name
      }, error.message);
    }

    // Batch pause
    if ((i + 1) % argv.batchSize === 0 && i < automationsToDelete.length - 1) {
      if (!argv.nonInteractive) {
        console.log('');
        const { continueDelete } = await inquirer.prompt([{
          type: 'confirm',
          name: 'continueDelete',
          message: `Deleted ${i + 1}/${automationsToDelete.length}. Continue?`,
          default: true
        }]);

        if (!continueDelete) {
          console.log(chalk.yellow('Deletion stopped by user.'));
          break;
        }
        console.log('');
      }
    }

    // Small delay between deletions
    await sleep(500);
  }

  // Print summary
  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log('');
  console.log(chalk.cyan('═'.repeat(60)));
  console.log(chalk.cyan.bold('DELETION COMPLETE'));
  console.log(chalk.cyan('═'.repeat(60)));
  console.log(`  Successful: ${chalk.green(successCount)}`);
  console.log(`  Failed: ${failCount > 0 ? chalk.red(failCount) : '0'}`);
  console.log(`  Skipped: ${chalk.yellow(notFound.length + runningSkipped.length)}`);
  console.log(`  Duration: ${duration} seconds`);

  if (backupDir) {
    console.log(`  Backups: ${backupDir}`);
  }

  // Save audit log
  const exitCode = failCount > 0 ? 1 : 0;
  const auditPath = auditLogger.save(exitCode);
  console.log('');
  console.log(chalk.gray(`Audit log: ${auditPath}`));
  console.log(chalk.gray(`Operation log: ${logger.logFilePath}`));

  process.exit(exitCode);
}

// Run main
main().catch(error => {
  logger.error('Unexpected error:', error);
  console.error(chalk.red('Unexpected error:'), error.message);
  auditLogger.save(1);
  process.exit(1);
});
