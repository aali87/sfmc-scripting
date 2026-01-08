#!/usr/bin/env node

/**
 * Update Automation Script
 *
 * Updates the file transfer step's filename and/or the import step's target DE
 * in an automation, then optionally triggers it to run.
 *
 * Usage:
 *   node src/scripts/update-automation.js --automation "Name" --bu 123456 --filename "file.csv" --target-de "DE_Name"
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';

import config, { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import {
  getAutomations,
  getAutomationDetails,
  getFileTransferDetails,
  updateFileTransfer,
  getImportDetails,
  updateImport,
  runAutomationOnce
} from '../lib/sfmc-rest.js';
import { retrieveDataExtensions } from '../lib/sfmc-soap.js';

// Activity type IDs
const ACTIVITY_TYPES = {
  FILE_TRANSFER: 53,
  IMPORT_DEFINITION: 43
};

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('automation', {
    alias: 'a',
    describe: 'Name of the automation to update',
    type: 'string',
    demandOption: true
  })
  .option('business-unit', {
    alias: 'bu',
    describe: 'Business Unit MID',
    type: 'string',
    demandOption: true
  })
  .option('filename', {
    alias: 'f',
    describe: 'New filename for the file transfer step',
    type: 'string'
  })
  .option('target-de', {
    alias: 't',
    describe: 'Target Data Extension name for the import step',
    type: 'string'
  })
  .option('confirm', {
    describe: 'Enable actual updates (default is dry-run)',
    type: 'boolean',
    default: false
  })
  .option('run', {
    alias: 'r',
    describe: 'Trigger the automation after updating',
    type: 'boolean',
    default: false
  })
  .example('$0 -a "Daily Import" --bu 123456 -f "data.csv" -t "Staging_DE"', 'Preview changes')
  .example('$0 -a "Daily Import" --bu 123456 -f "data.csv" --confirm --run', 'Apply and run')
  .help()
  .parseSync();

// Initialize logger
const logger = createLogger('update-automation');

/**
 * Find an automation by name
 */
async function findAutomationByName(automationName, logger) {
  const automations = await getAutomations(logger);
  const nameLower = automationName.toLowerCase().trim();

  return automations.find(a =>
    a.name && a.name.toLowerCase().trim() === nameLower
  );
}

/**
 * Find activities in automation steps by type
 */
function findActivitiesByType(automation, objectTypeId) {
  const activities = [];

  if (!automation.steps) return activities;

  for (const step of automation.steps) {
    if (!step.activities) continue;

    for (const activity of step.activities) {
      if (activity.objectTypeId === objectTypeId) {
        activities.push({
          ...activity,
          stepNumber: step.stepNumber || step.step,
          stepName: step.name || step.annotation
        });
      }
    }
  }

  return activities;
}

/**
 * Find a Data Extension by name
 */
async function findDataExtensionByName(deName, logger, accountId) {
  const dataExtensions = await retrieveDataExtensions(null, logger, accountId);
  const nameLower = deName.toLowerCase().trim();

  return dataExtensions.find(de =>
    de.Name && de.Name.toLowerCase().trim() === nameLower
  );
}

/**
 * Print automation summary
 */
function printAutomationSummary(automation, details) {
  console.log('');
  console.log(chalk.cyan('Automation Found:'));
  console.log(`  Name: ${chalk.white(automation.name)}`);
  console.log(`  ID: ${chalk.gray(automation.id)}`);
  console.log(`  Status: ${automation.status}`);
  if (details.lastRunTime) {
    console.log(`  Last Run: ${details.lastRunTime}`);
  }
  console.log('');
}

/**
 * Print activity details
 */
function printActivityDetails(label, activity, details) {
  console.log(chalk.cyan(`${label}:`));
  console.log(`  Name: ${chalk.white(activity.name)}`);
  console.log(`  ID: ${chalk.gray(activity.activityObjectId)}`);
  console.log(`  Step: ${activity.stepNumber}`);

  if (details) {
    if (details.fileNamePattern) {
      console.log(`  Current Filename: ${chalk.yellow(details.fileNamePattern)}`);
    }
    if (details.destinationName) {
      console.log(`  Current Target DE: ${chalk.yellow(details.destinationName)}`);
    }
    if (details.destinationObjectKey) {
      console.log(`  Target DE Key: ${chalk.gray(details.destinationObjectKey)}`);
    }
  }
  console.log('');
}

/**
 * Main function
 */
async function main() {
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  Update Automation - File Transfer & Import Steps'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  // Validate at least one update is specified
  if (!argv.filename && !argv.targetDe) {
    console.log(chalk.red('Error: You must specify at least --filename or --target-de'));
    process.exit(1);
  }

  // Validate config
  try {
    validateConfig();
  } catch (configError) {
    console.error(chalk.red(`Configuration error: ${configError.message}`));
    process.exit(1);
  }

  // Show mode
  if (!argv.confirm) {
    console.log(chalk.yellow('DRY RUN MODE - No changes will be made'));
    console.log(chalk.gray('Use --confirm to apply changes'));
    console.log('');
  }

  // Test connection
  const spinner = ora('Connecting to SFMC...').start();
  const conn = await testConnection(logger);
  if (!conn.success) {
    spinner.fail('Connection failed');
    console.error(chalk.red(`Error: ${conn.error}`));
    process.exit(1);
  }
  spinner.succeed('Connected to SFMC');

  // Find automation by name
  spinner.start(`Searching for automation: "${argv.automation}"`);
  const automation = await findAutomationByName(argv.automation, logger);

  if (!automation) {
    spinner.fail('Automation not found');
    console.error(chalk.red(`\nError: No automation found with name "${argv.automation}"`));
    console.log(chalk.gray('Make sure the automation name is correct and you have access to it.'));
    process.exit(1);
  }
  spinner.succeed('Automation found');

  // Get full automation details
  spinner.start('Loading automation details...');
  const automationDetails = await getAutomationDetails(automation.id, logger);
  spinner.succeed('Automation details loaded');

  printAutomationSummary(automation, automationDetails);

  // Find File Transfer activities
  const fileTransferActivities = findActivitiesByType(automationDetails, ACTIVITY_TYPES.FILE_TRANSFER);

  // Find Import Definition activities
  const importActivities = findActivitiesByType(automationDetails, ACTIVITY_TYPES.IMPORT_DEFINITION);

  // Validate we have the required activities
  if (argv.filename && fileTransferActivities.length === 0) {
    console.error(chalk.red('Error: No File Transfer activity found in this automation'));
    console.log(chalk.gray('The automation must have a File Transfer activity to update the filename.'));
    process.exit(1);
  }

  if (argv.targetDe && importActivities.length === 0) {
    console.error(chalk.red('Error: No Import activity found in this automation'));
    console.log(chalk.gray('The automation must have an Import activity to update the target DE.'));
    process.exit(1);
  }

  // Get current details for File Transfer
  let fileTransferDetails = null;
  let fileTransferActivity = null;
  if (argv.filename && fileTransferActivities.length > 0) {
    fileTransferActivity = fileTransferActivities[0]; // Use first one
    spinner.start('Loading File Transfer details...');
    fileTransferDetails = await getFileTransferDetails(fileTransferActivity.activityObjectId, logger);
    spinner.succeed('File Transfer details loaded');

    if (!fileTransferDetails) {
      console.error(chalk.red('Error: Could not retrieve File Transfer activity details'));
      process.exit(1);
    }

    printActivityDetails('File Transfer Activity', fileTransferActivity, fileTransferDetails);
  }

  // Get current details for Import
  let importDetails = null;
  let importActivity = null;
  if (argv.targetDe && importActivities.length > 0) {
    importActivity = importActivities[0]; // Use first one
    spinner.start('Loading Import Definition details...');
    importDetails = await getImportDetails(importActivity.activityObjectId, logger);
    spinner.succeed('Import Definition details loaded');

    if (!importDetails) {
      console.error(chalk.red('Error: Could not retrieve Import Definition details'));
      process.exit(1);
    }

    printActivityDetails('Import Definition Activity', importActivity, importDetails);
  }

  // Resolve target DE name to CustomerKey if needed
  let targetDe = null;
  if (argv.targetDe) {
    spinner.start(`Looking up Data Extension: "${argv.targetDe}"`);
    targetDe = await findDataExtensionByName(argv.targetDe, logger, argv.businessUnit);

    if (!targetDe) {
      spinner.fail('Data Extension not found');
      console.error(chalk.red(`\nError: No Data Extension found with name "${argv.targetDe}"`));
      console.log(chalk.gray('Make sure the DE name is correct and exists in this Business Unit.'));
      process.exit(1);
    }
    spinner.succeed(`Data Extension found: ${targetDe.Name} (Key: ${targetDe.CustomerKey})`);
  }

  // Show planned changes
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  Planned Changes'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  if (argv.filename && fileTransferDetails) {
    console.log(chalk.white('File Transfer:'));
    console.log(`  Current filename: ${chalk.yellow(fileTransferDetails.fileNamePattern || '(not set)')}`);
    console.log(`  New filename:     ${chalk.green(argv.filename)}`);
    console.log('');
  }

  if (argv.targetDe && importDetails && targetDe) {
    console.log(chalk.white('Import Definition:'));
    console.log(`  Current target DE: ${chalk.yellow(importDetails.destinationName || '(not set)')}`);
    console.log(`  New target DE:     ${chalk.green(targetDe.Name)} (Key: ${targetDe.CustomerKey})`);
    console.log('');
  }

  // Dry-run mode - stop here
  if (!argv.confirm) {
    console.log(chalk.yellow('─'.repeat(65)));
    console.log(chalk.yellow('DRY RUN - No changes were made'));
    console.log(chalk.gray('Run with --confirm to apply these changes'));
    console.log('');
    return;
  }

  // Apply changes
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  Applying Changes'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  let updateSuccess = true;

  // Update File Transfer
  if (argv.filename && fileTransferActivity) {
    spinner.start('Updating File Transfer activity...');
    const result = await updateFileTransfer(
      fileTransferActivity.activityObjectId,
      { fileNamePattern: argv.filename },
      logger
    );

    if (result.success) {
      spinner.succeed('File Transfer updated successfully');
    } else {
      spinner.fail(`File Transfer update failed: ${result.error}`);
      updateSuccess = false;
    }
  }

  // Update Import Definition
  if (argv.targetDe && importActivity && targetDe) {
    spinner.start('Updating Import Definition...');
    const result = await updateImport(
      importActivity.activityObjectId,
      {
        destinationObjectKey: targetDe.CustomerKey,
        destinationObjectId: targetDe.ObjectID
      },
      logger
    );

    if (result.success) {
      spinner.succeed('Import Definition updated successfully');
    } else {
      spinner.fail(`Import Definition update failed: ${result.error}`);
      updateSuccess = false;
    }
  }

  console.log('');

  // Trigger automation if requested
  if (argv.run && updateSuccess) {
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('  Triggering Automation'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
    console.log('');

    spinner.start('Triggering automation to run...');
    const runResult = await runAutomationOnce(automation.id, logger);

    if (runResult.success) {
      spinner.succeed('Automation triggered successfully');
      console.log(chalk.green('\nThe automation has been queued to run.'));
      console.log(chalk.gray('Check Automation Studio for execution status.'));
    } else {
      spinner.fail(`Failed to trigger automation: ${runResult.error}`);
    }
  } else if (argv.run && !updateSuccess) {
    console.log(chalk.yellow('\nAutomation was not triggered due to update failures.'));
  }

  // Summary
  console.log('');
  if (updateSuccess) {
    console.log(chalk.green('All updates completed successfully.'));
  } else {
    console.log(chalk.red('Some updates failed. Check the errors above.'));
    process.exit(1);
  }
}

// Run
main().catch(err => {
  console.error(chalk.red(`\nError: ${err.message}`));
  if (logger) {
    logger.error(`Script failed: ${err.message}`, { stack: err.stack });
  }
  process.exit(1);
});
