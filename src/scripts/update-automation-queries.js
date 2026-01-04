#!/usr/bin/env node

/**
 * SFMC Automation Query Activity Updater
 *
 * Updates query activities in an automation to point to newly restored queries.
 * This fixes automations that were broken when query activities were deleted.
 *
 * Usage:
 *   node src/scripts/update-automation-queries.js --automation "AutomationName" [options]
 *   node src/scripts/update-automation-queries.js --automation-id "guid" [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

import config, { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { getAccessToken, testConnection } from '../lib/sfmc-auth.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('automation', {
    alias: 'a',
    describe: 'Automation name to update',
    type: 'string'
  })
  .option('automation-id', {
    describe: 'Automation ID (GUID) to update',
    type: 'string'
  })
  .option('restoration-report', {
    alias: 'r',
    describe: 'Path to query restoration report JSON',
    type: 'string'
  })
  .option('dry-run', {
    describe: 'Preview only, no updates (DEFAULT)',
    type: 'boolean',
    default: true
  })
  .option('confirm', {
    describe: 'Enable actual update mode',
    type: 'boolean',
    default: false
  })
  .check((argv) => {
    if (!argv.automation && !argv.automationId) {
      throw new Error('Must specify either --automation or --automation-id');
    }
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
const logger = createLogger('update-automation-queries');

/**
 * Get automation by ID via REST API
 */
async function getAutomation(automationId) {
  const tokenInfo = await getAccessToken(logger);
  const url = `${tokenInfo.restInstanceUrl}automation/v1/automations/${automationId}`;

  logger.debug(`GET ${url}`);

  const response = await axios.get(url, {
    headers: {
      'Authorization': `Bearer ${tokenInfo.accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

/**
 * Update automation via REST API PATCH
 */
async function updateAutomation(automationId, payload) {
  const tokenInfo = await getAccessToken(logger);
  const url = `${tokenInfo.restInstanceUrl}automation/v1/automations/${automationId}`;

  logger.debug(`PATCH ${url}`);
  logger.debug(`Payload: ${JSON.stringify(payload, null, 2)}`);

  const response = await axios.patch(url, payload, {
    headers: {
      'Authorization': `Bearer ${tokenInfo.accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

/**
 * Load restored queries mapping from report or cache
 */
function loadRestoredQueriesMap(reportPath) {
  const restoredQueries = new Map();

  if (reportPath && fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    (report.successfulRestorations || []).forEach(item => {
      restoredQueries.set(item.name, item.newObjectId);
    });
    return restoredQueries;
  }

  // Find the most recent restoration report
  const auditDir = path.join(config.paths.root, 'audit');
  if (fs.existsSync(auditDir)) {
    const reports = fs.readdirSync(auditDir)
      .filter(f => f.startsWith('query-restoration-report-'))
      .sort()
      .reverse();

    if (reports.length > 0) {
      const latestReport = path.join(auditDir, reports[0]);
      console.log(chalk.gray(`Using restoration report: ${reports[0]}`));
      const report = JSON.parse(fs.readFileSync(latestReport, 'utf8'));
      (report.successfulRestorations || []).forEach(item => {
        restoredQueries.set(item.name, item.newObjectId);
      });
    }
  }

  return restoredQueries;
}

/**
 * Find automation by name in cache
 */
function findAutomationInCache(name) {
  const cachePath = path.join(config.paths.root, 'cache', `bulk-data-${config.sfmc.accountId}.json`);

  if (!fs.existsSync(cachePath)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const automations = data.data?.automations || [];

  return automations.find(a => a.name === name);
}

/**
 * Main function
 */
async function main() {
  console.log(chalk.bold.cyan('\nSFMC Automation Query Activity Updater'));
  console.log(chalk.cyan('─'.repeat(50)));
  console.log(`MODE: ${argv.dryRun ? chalk.yellow('DRY RUN (Preview Only)') : chalk.red.bold('LIVE UPDATE')}`);
  if (argv.dryRun) {
    console.log(chalk.gray('Use --confirm to enable actual updates\n'));
  }

  try {
    // Validate config
    const validationErrors = validateConfig();
    if (validationErrors.length > 0) {
      console.error(chalk.red('Configuration errors:'));
      validationErrors.forEach(err => console.error(chalk.red(`  - ${err}`)));
      process.exit(1);
    }

    // Test connection
    const spinner = ora('Testing SFMC connection...').start();
    const connected = await testConnection(logger);
    if (!connected) {
      spinner.fail('SFMC connection failed');
      process.exit(1);
    }
    spinner.succeed('SFMC connection successful');

    // Find automation ID
    let automationId = argv.automationId;
    let automationName = argv.automation;

    if (!automationId && automationName) {
      spinner.start(`Finding automation: ${automationName}`);
      const cachedAuto = findAutomationInCache(automationName);
      if (cachedAuto) {
        automationId = cachedAuto.id;
        spinner.succeed(`Found automation ID: ${automationId}`);
      } else {
        spinner.fail(`Automation not found in cache: ${automationName}`);
        process.exit(1);
      }
    }

    // Get current automation from API
    spinner.start('Fetching automation from SFMC...');
    const automation = await getAutomation(automationId);
    automationName = automation.name;
    spinner.succeed(`Loaded automation: ${automationName}`);

    console.log(chalk.gray(`  Status: ${automation.status}`));
    console.log(chalk.gray(`  Steps: ${automation.steps?.length || 0}`));

    // Load restored queries mapping
    spinner.start('Loading restored queries mapping...');
    const restoredQueries = loadRestoredQueriesMap(argv.restorationReport);
    spinner.succeed(`Loaded ${restoredQueries.size} restored queries`);

    // Find query activities and map updates
    console.log(chalk.bold('\n📋 Query Activity Updates:'));
    console.log('─'.repeat(70));

    const updates = [];
    let stepIndex = 0;

    for (const step of automation.steps || []) {
      stepIndex++;
      for (const activity of step.activities || []) {
        // Query Activity = objectTypeId 300
        if (activity.objectTypeId === 300) {
          const newObjectId = restoredQueries.get(activity.name);
          const needsUpdate = newObjectId && newObjectId !== activity.activityObjectId;

          if (newObjectId) {
            updates.push({
              stepIndex: stepIndex - 1,
              stepId: step.id,
              activityName: activity.name,
              oldObjectId: activity.activityObjectId,
              newObjectId: newObjectId,
              needsUpdate
            });

            if (needsUpdate) {
              console.log(chalk.green(`✓ Step ${stepIndex}: ${activity.name}`));
              console.log(chalk.gray(`    ${activity.activityObjectId} → ${newObjectId}`));
            } else {
              console.log(chalk.gray(`○ Step ${stepIndex}: ${activity.name} (already up to date)`));
            }
          } else {
            console.log(chalk.yellow(`⚠ Step ${stepIndex}: ${activity.name} (no restored query found)`));
          }
        }
      }
    }

    const needsUpdateCount = updates.filter(u => u.needsUpdate).length;
    console.log('─'.repeat(70));
    console.log(`Total query activities: ${updates.length}`);
    console.log(`Need update: ${needsUpdateCount}`);

    if (needsUpdateCount === 0) {
      console.log(chalk.green('\n✓ All query activities are already up to date!'));
      process.exit(0);
    }

    // Dry run - don't make changes
    if (argv.dryRun) {
      console.log(chalk.yellow('\n⚠ DRY RUN - No changes made'));
      console.log(chalk.gray('Use --confirm to apply these updates'));
      process.exit(0);
    }

    // Build the update payload
    // The PATCH endpoint requires a specific structure for steps
    spinner.start('Building update payload...');

    // Clone the automation steps and update activityObjectId values
    const updatedSteps = automation.steps.map((step, stepIdx) => {
      const updatedActivities = step.activities.map(activity => {
        const update = updates.find(u =>
          u.stepIndex === stepIdx &&
          u.activityName === activity.name &&
          u.needsUpdate
        );

        if (update) {
          // Return activity with updated activityObjectId
          // Remove targetDataExtensions as per API requirements
          const { targetDataExtensions, ...activityWithoutTargetDE } = activity;
          return {
            ...activityWithoutTargetDE,
            activityObjectId: update.newObjectId
          };
        }

        // Return activity without targetDataExtensions
        const { targetDataExtensions, ...activityWithoutTargetDE } = activity;
        return activityWithoutTargetDE;
      });

      return {
        annotation: step.annotation || '',
        stepNumber: stepIdx,
        activities: updatedActivities
      };
    });

    // Build the payload
    // For PATCH, we try without startSource first - the API may not require it
    // if we're only updating activities within existing steps
    const payload = {
      name: automation.name,
      key: automation.key,
      steps: updatedSteps
    };

    // Only include startSource if the automation has a proper schedule
    // For triggered automations or those with scheduleStatus: "none", we omit it
    if (automation.startSource && automation.startSource.schedule) {
      const sched = automation.startSource.schedule;
      // Only include if it has required fields
      if (sched.startDate && sched.iCalRecur) {
        payload.startSource = automation.startSource;
      }
    }

    spinner.succeed('Update payload ready');

    // Apply the update
    spinner.start('Updating automation...');

    try {
      const result = await updateAutomation(automationId, payload);
      spinner.succeed('Automation updated successfully!');

      console.log(chalk.green('\n✓ Updated query activities:'));
      updates.filter(u => u.needsUpdate).forEach(u => {
        console.log(chalk.green(`  • ${u.activityName}`));
      });

      // Save the result
      const resultPath = path.join(config.paths.root, 'audit', `automation-update-${Date.now()}.json`);
      fs.writeFileSync(resultPath, JSON.stringify({
        automationId,
        automationName,
        updatedAt: new Date().toISOString(),
        updatesApplied: updates.filter(u => u.needsUpdate),
        result
      }, null, 2));

      console.log(chalk.gray(`\nResult saved to: ${resultPath}`));

    } catch (error) {
      spinner.fail('Failed to update automation');

      if (error.response) {
        console.error(chalk.red(`Status: ${error.response.status}`));
        console.error(chalk.red(`Response: ${JSON.stringify(error.response.data, null, 2)}`));
      } else {
        console.error(chalk.red(error.message));
      }

      // Save the failed payload for debugging
      const debugPath = path.join(config.paths.root, 'audit', `automation-update-failed-${Date.now()}.json`);
      fs.writeFileSync(debugPath, JSON.stringify({
        automationId,
        automationName,
        attemptedAt: new Date().toISOString(),
        payload,
        error: error.response?.data || error.message
      }, null, 2));

      console.log(chalk.gray(`Debug info saved to: ${debugPath}`));
      process.exit(1);
    }

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run
main();
