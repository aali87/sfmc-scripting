#!/usr/bin/env node

/**
 * SFMC Automation Query ObjectID Updater
 *
 * Updates query activities in automations to point to new ObjectIDs.
 * Uses a direct ObjectID mapping (old -> new) rather than a restoration report.
 *
 * Usage:
 *   node src/scripts/update-automation-query-objectids.js --automation-id "guid" --bu 1079060 [options]
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
  .option('automation-id', {
    describe: 'Automation ID (GUID) to update',
    type: 'string',
    demandOption: true
  })
  .option('bu', {
    describe: 'Business Unit MID',
    type: 'string',
    demandOption: true
  })
  .option('mapping-file', {
    describe: 'Path to JSON file with old->new ObjectID mapping',
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
const logger = createLogger('update-automation-query-objectids');

/**
 * Get automation by ID via REST API
 */
async function getAutomation(automationId, accountId) {
  const tokenInfo = await getAccessToken(logger, accountId);
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
async function updateAutomation(automationId, payload, accountId) {
  const tokenInfo = await getAccessToken(logger, accountId);
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
 * Main function
 */
async function main() {
  console.log(chalk.bold.cyan('\nSFMC Automation Query ObjectID Updater'));
  console.log(chalk.cyan('-'.repeat(50)));
  console.log(`MODE: ${argv.dryRun ? chalk.yellow('DRY RUN (Preview Only)') : chalk.red.bold('LIVE UPDATE')}`);
  console.log(`Business Unit: ${chalk.white(argv.bu)}`);
  console.log(`Automation ID: ${chalk.white(argv.automationId)}`);
  if (argv.dryRun) {
    console.log(chalk.gray('Use --confirm to enable actual updates\n'));
  }

  try {
    // Validate config
    validateConfig();

    // Test connection
    const spinner = ora('Testing SFMC connection...').start();
    const connected = await testConnection(logger, argv.bu);
    if (!connected.success) {
      spinner.fail(`SFMC connection failed: ${connected.error}`);
      process.exit(1);
    }
    spinner.succeed('SFMC connection successful');

    // Get current automation from API
    spinner.start('Fetching automation from SFMC...');
    const automation = await getAutomation(argv.automationId, argv.bu);
    spinner.succeed(`Loaded automation: ${automation.name}`);

    console.log(chalk.gray(`  Status: ${automation.status}`));
    console.log(chalk.gray(`  Steps: ${automation.steps?.length || 0}`));

    // Load ObjectID mapping
    // Hardcoded mapping from the user's request
    const objectIdMapping = {
      // Query name -> { oldId, newId }
      '10567SmallBusinessSmartCapture_ImportCounts': {
        old: '072a5c03-6c97-4034-8107-271545f77dbb',
        new: '8ce80226-1088-415f-a403-32ef7cf7d11b'
      },
      '10567SmallBusinessSmartCapture_DailySeeds': {
        old: '79455248-7fc8-4c59-8960-56bac9f848de',
        new: 'c9c33347-e98d-496a-9cd9-899f016ec739'
      },
      '10567SmallBusinessSmartCapture_AddSeedsToTrigger': {
        old: 'b9df1f07-6755-47b9-bdfa-a4de743202bd',
        new: 'cc8c9208-9d53-4cfb-be18-f45e24f5d311'
      },
      '10567SmallBusinessSmartCapture_AddTriggerToMaster': {
        old: 'bd8aee4b-7501-4bff-96a2-8a726e16464b',
        new: 'ab43bee2-fee7-4516-bb69-7a00af1e4231'
      },
      '10567SmallBusinessSmartCapture_AB_Counts': {
        old: '94bb35f3-f1ed-475c-80a9-53deae173fa8',
        new: '292ee881-4548-43af-8acc-1954cd8ea3cc'
      },
      '10567SmallBusinessSmartCapture_AB_Significance': {
        old: 'd36906ea-b7c5-4fcb-ab15-2e16da8ea6b3',
        new: '5d63f4a2-7a18-43b2-9ed8-8f15445ac10d'
      },
      '10567SmallBusinessSmartCapture_UpdateMaster': {
        old: 'bbc5c232-9c33-49b2-b5ff-e223631da30b',
        new: '4246f376-24b8-4188-a4c3-6e4a699c7b2f'
      },
      '10567SmallBusinessSmartCapture_FormatJourneyLog': {
        old: 'f9b22909-f581-406f-b137-f09c0202550b',
        new: 'e7d7e61b-3fb2-4d91-a87f-82332500f246'
      },
      '10567SmallBusinessSmartCapture_FillInUpsertDE': {
        old: 'b4c82229-cc8b-4a28-86f9-5eac3a020189',
        new: 'fcb3c3ac-caaa-4620-9b61-1a7ef5bf2f97'
      },
      '10567SmallBusinessSmartCapture_SendSummary': {
        old: '771778a8-4d2c-46b9-932e-e3e595151772',
        new: 'd3d38f9c-4eee-4722-b31a-1617604e7a99'
      },
      // NOTE: This one could NOT be recreated - DO NOT update
      '10567SmallBusinessSmartCapture_Trigger': {
        old: 'c7c0a2bc-dd7d-4a63-b40f-6498324b3187',
        new: 'f07af12e-e7a4-40db-83ff-dfa35febebf4'
        
      }
    };

    console.log(chalk.bold('\nQuery Activity Analysis:'));
    console.log('-'.repeat(70));

    const updates = [];
    let stepIndex = 0;

    for (const step of automation.steps || []) {
      stepIndex++;
      for (const activity of step.activities || []) {
        // Query Activity = objectTypeId 300
        if (activity.objectTypeId === 300) {
          const mapping = objectIdMapping[activity.name];

          if (mapping) {
            if (mapping.new === null) {
              // This query should be skipped
              console.log(chalk.yellow(`! Step ${stepIndex}: ${activity.name}`));
              console.log(chalk.yellow(`    SKIPPED: ${mapping.skipReason}`));
              console.log(chalk.gray(`    Current: ${activity.activityObjectId}`));
            } else if (activity.activityObjectId === mapping.old) {
              // Found a match that needs updating
              updates.push({
                stepIndex: stepIndex - 1,
                stepId: step.id,
                activityName: activity.name,
                oldObjectId: mapping.old,
                newObjectId: mapping.new
              });
              console.log(chalk.green(`+ Step ${stepIndex}: ${activity.name}`));
              console.log(chalk.gray(`    ${mapping.old} -> ${mapping.new}`));
            } else if (activity.activityObjectId === mapping.new) {
              // Already updated
              console.log(chalk.gray(`= Step ${stepIndex}: ${activity.name} (already up to date)`));
            } else {
              // Unknown state
              console.log(chalk.yellow(`? Step ${stepIndex}: ${activity.name}`));
              console.log(chalk.yellow(`    Current: ${activity.activityObjectId}`));
              console.log(chalk.yellow(`    Expected old: ${mapping.old}`));
            }
          } else {
            // Query not in our mapping
            console.log(chalk.gray(`- Step ${stepIndex}: ${activity.name} (not in mapping)`));
          }
        }
      }
    }

    console.log('-'.repeat(70));
    console.log(`Activities to update: ${updates.length}`);

    if (updates.length === 0) {
      console.log(chalk.green('\nNo updates needed - all query activities are already up to date!'));
      process.exit(0);
    }

    // Dry run - don't make changes
    if (argv.dryRun) {
      console.log(chalk.yellow('\nDRY RUN - No changes made'));
      console.log(chalk.gray('Use --confirm to apply these updates'));
      process.exit(0);
    }

    // Build the update payload
    spinner.start('Building update payload...');

    // Clone the automation steps and update activityObjectId values
    const updatedSteps = automation.steps.map((step, stepIdx) => {
      const updatedActivities = step.activities.map(activity => {
        const update = updates.find(u =>
          u.stepIndex === stepIdx &&
          u.activityName === activity.name
        );

        // Remove targetDataExtensions as per API requirements
        const { targetDataExtensions, ...activityWithoutTargetDE } = activity;

        if (update) {
          return {
            ...activityWithoutTargetDE,
            activityObjectId: update.newObjectId
          };
        }

        return activityWithoutTargetDE;
      });

      return {
        annotation: step.annotation || '',
        stepNumber: stepIdx,
        activities: updatedActivities
      };
    });

    // Build the payload
    const payload = {
      name: automation.name,
      key: automation.key,
      steps: updatedSteps
    };

    // Only include startSource if the automation has a proper schedule
    if (automation.startSource && automation.startSource.schedule) {
      const sched = automation.startSource.schedule;
      if (sched.startDate && sched.iCalRecur) {
        payload.startSource = automation.startSource;
      }
    }

    spinner.succeed('Update payload ready');

    // Apply the update
    spinner.start('Updating automation...');

    try {
      const result = await updateAutomation(argv.automationId, payload, argv.bu);
      spinner.succeed('Automation updated successfully!');

      console.log(chalk.green('\nUpdated query activities:'));
      updates.forEach(u => {
        console.log(chalk.green(`  - ${u.activityName}`));
      });

      // Save the result
      const auditDir = path.join(config.paths.root, 'audit');
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }

      const resultPath = path.join(auditDir, `automation-objectid-update-${argv.automationId}-${Date.now()}.json`);
      fs.writeFileSync(resultPath, JSON.stringify({
        automationId: argv.automationId,
        automationName: automation.name,
        businessUnit: argv.bu,
        updatedAt: new Date().toISOString(),
        updatesApplied: updates,
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
      const auditDir = path.join(config.paths.root, 'audit');
      if (!fs.existsSync(auditDir)) {
        fs.mkdirSync(auditDir, { recursive: true });
      }

      const debugPath = path.join(auditDir, `automation-objectid-update-failed-${argv.automationId}-${Date.now()}.json`);
      fs.writeFileSync(debugPath, JSON.stringify({
        automationId: argv.automationId,
        automationName: automation.name,
        businessUnit: argv.bu,
        attemptedAt: new Date().toISOString(),
        payload,
        error: error.response?.data || error.message
      }, null, 2));

      console.log(chalk.gray(`Debug info saved to: ${debugPath}`));
      process.exit(1);
    }

  } catch (error) {
    console.error(chalk.red(`\nError: ${error.message}`));
    logger.error(error.stack);
    process.exit(1);
  }
}

// Run
main();
