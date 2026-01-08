#!/usr/bin/env node

/**
 * SFMC Folder Deletion Script
 *
 * Deletes a folder and all its subfolders after verifying they are empty.
 *
 * IMPORTANT: Defaults to DRY RUN mode. Use --confirm to enable actual deletion.
 * Folders must be empty (no Data Extensions) before deletion unless --force is used.
 *
 * Usage:
 *   node src/scripts/delete-folders.js --folder "Path/To/Folder" [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import dayjs from 'dayjs';

import config, { validateConfig, isFolderProtected } from '../config/index.js';
import { createLogger, createAuditLogger, createStateManager } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import {
  getSubfolders,
  getDeletionOrder,
  isFolderEmpty,
  deleteFolder,
  findSimilarFolders,
  clearFolderCache,
  findFolder
} from '../lib/folder-service.js';
import { getDataExtensionsInFolder, deleteDataExtension } from '../lib/data-extension-service.js';
import { sendWebhook } from '../lib/sfmc-rest.js';
import { sleep } from '../lib/utils.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --folder <path> [options]')
  .option('folder', {
    alias: 'f',
    describe: 'Folder path or name to delete',
    type: 'string',
    demandOption: true
  })
  .option('dry-run', {
    describe: 'Preview only, no deletions (DEFAULT)',
    type: 'boolean',
    default: true
  })
  .option('confirm', {
    describe: 'Enable actual deletion mode',
    type: 'boolean',
    default: false
  })
  .option('force', {
    describe: 'Delete folders even if they contain items (deletes contents first)',
    type: 'boolean',
    default: false
  })
  .option('skip-protected', {
    describe: 'Skip protected folders instead of aborting',
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
  .option('webhook-url', {
    describe: 'URL to POST results to when complete',
    type: 'string'
  })
  .option('refresh-cache', {
    describe: 'Force refresh folder cache from SFMC API',
    type: 'boolean',
    default: false
  })
  .check((argv) => {
    if (argv.confirm) {
      argv.dryRun = false;
    }

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
const logger = createLogger('delete-folders');
const auditLogger = createAuditLogger('delete-folders');

/**
 * Print folder deletion preview
 */
function printPreview(folders, nonEmptyFolders, hasForce) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.yellow(`┌${line}┐`));
  console.log(chalk.yellow(`│`) + chalk.bold.yellow('                    ⚠️  FOLDER DELETION PREVIEW').padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`├${line}┤`));
  console.log(chalk.yellow(`│`) + ' Folders to Delete (deletion order - deepest first):'.padEnd(width) + chalk.yellow(`│`));

  folders.slice(0, 20).forEach((f, i) => {
    let status = '';
    if (f.isProtected) {
      status = chalk.red(' [PROTECTED]');
    } else if (f.hasContents) {
      status = hasForce ? chalk.yellow(' [WILL DELETE CONTENTS]') : chalk.red(' [NOT EMPTY]');
    }
    const line = `   ${i + 1}. ${f.path || f.name}${status}`;
    console.log(chalk.yellow(`│`) + line.substring(0, width).padEnd(width) + chalk.yellow(`│`));
  });

  if (folders.length > 20) {
    console.log(chalk.yellow(`│`) + `   ... and ${folders.length - 20} more`.padEnd(width) + chalk.yellow(`│`));
  }

  console.log(chalk.yellow(`│`) + ''.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` Total Folders: ${folders.length}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`└${line}┘`));

  // Show non-empty folders warning
  if (nonEmptyFolders.length > 0 && !hasForce) {
    console.log('');
    console.log(chalk.red.bold('⚠️  NON-EMPTY FOLDERS DETECTED:'));
    nonEmptyFolders.forEach(f => {
      console.log(chalk.red(`   ${f.path || f.name}`));
      if (f.subfolderCount > 0) {
        console.log(chalk.gray(`     - ${f.subfolderCount} subfolder(s)`));
      }
      if (f.dataExtensionCount > 0) {
        console.log(chalk.gray(`     - ${f.dataExtensionCount} Data Extension(s)`));
      }
    });
    console.log(chalk.red('\nEmpty these folders first or use --force to delete contents.'));
  }
}

/**
 * Get confirmation from user
 */
async function getConfirmation(count, nonInteractive, confirmPhrase) {
  const expectedPhrase = `DELETE ${count} FOLDER${count === 1 ? '' : 'S'}`;

  if (nonInteractive) {
    if (confirmPhrase === expectedPhrase) {
      return true;
    }
    console.log(chalk.red(`Confirmation phrase mismatch. Expected: "${expectedPhrase}"`));
    return false;
  }

  console.log('');
  console.log(chalk.red.bold('┌──────────────────────────────────────────────────────────────────┐'));
  console.log(chalk.red.bold('│  🚨 THIS ACTION IS IRREVERSIBLE 🚨                              │'));
  console.log(chalk.red.bold('│                                                                  │'));
  console.log(chalk.red.bold(`│  You are about to permanently delete ${String(count).padEnd(3)} folder(s)              │`));
  console.log(chalk.red.bold('│                                                                  │'));
  console.log(chalk.red.bold(`│  Type '${expectedPhrase}' to confirm:                       │`));
  console.log(chalk.red.bold('└──────────────────────────────────────────────────────────────────┘'));
  console.log('');

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'confirmation',
      message: 'Confirmation:'
    }
  ]);

  return answers.confirmation === expectedPhrase;
}

/**
 * Print final report
 */
function printReport(results, auditPath) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.cyan(`┌${line}┐`));
  console.log(chalk.cyan(`│`) + chalk.bold.white('                    FOLDER DELETION COMPLETE').padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ` Successfully Deleted Folders: ${chalk.green(results.foldersDeleted)}`.padEnd(width + 10) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Successfully Deleted DEs (force mode): ${chalk.green(results.desDeleted)}`.padEnd(width + 10) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Failed: ${chalk.red(results.failed)}`.padEnd(width + 10) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Skipped: ${results.skipped}`.padEnd(width) + chalk.cyan(`│`));

  if (results.failedItems && results.failedItems.length > 0) {
    console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
    console.log(chalk.cyan(`│`) + ' Failed Items:'.padEnd(width) + chalk.cyan(`│`));
    results.failedItems.slice(0, 10).forEach(item => {
      const line = `   • ${item.name} - ${item.error}`.substring(0, width - 2);
      console.log(chalk.cyan(`│`) + chalk.red(line.padEnd(width)) + chalk.cyan(`│`));
    });
  }

  console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Audit Log: ${auditPath}`.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`└${line}┘`));
}

/**
 * Main deletion function
 */
async function runDeletion() {
  const startTime = Date.now();
  let stateManager = null;

  // Set up Ctrl+C handler
  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) {
      console.log(chalk.red('\nForce exiting...'));
      process.exit(2);
    }

    interrupted = true;
    console.log(chalk.yellow('\n\nInterrupted! Saving state...'));

    if (stateManager) {
      stateManager.save({
        processed: auditLogger.getData().results
      });
      console.log(chalk.yellow(`State saved. Resume with: --resume ${auditLogger.operationId}`));
    }

    process.exit(2);
  });

  try {
    // Validate configuration
    validateConfig();

    logger.section('SFMC FOLDER DELETION');
    logger.info(`Target folder: ${argv.folder}`);
    logger.info(`Mode: ${argv.dryRun ? 'DRY RUN' : 'LIVE DELETION'}`);
    logger.info(`Force mode: ${argv.force}`);

    // Store options in audit log
    auditLogger.setOptions({
      dryRun: argv.dryRun,
      force: argv.force,
      skipProtected: argv.skipProtected
    });

    stateManager = createStateManager(auditLogger.operationId);

    // Test connection
    const spinner = ora('Connecting to SFMC...').start();
    let connectionResult;
    try {
      connectionResult = await testConnection(logger);
    } catch (error) {
      spinner.fail('Connection failed');
      throw error;
    }

    if (!connectionResult.success) {
      spinner.fail('Connection failed');
      logger.error(connectionResult.error);
      process.exit(2);
    }

    spinner.succeed('Connected to SFMC');

    // Handle cache refresh if requested
    if (argv.refreshCache) {
      spinner.start('Clearing cache and fetching fresh data from SFMC...');
      try {
        await clearFolderCache(logger);
        spinner.succeed('Cache cleared - will fetch fresh data');
      } catch (error) {
        spinner.fail('Failed to clear cache');
        throw error;
      }
    }

    // Find target folder
    spinner.start('Finding target folder...');
    let targetFolder;
    try {
      targetFolder = await findFolder(argv.folder, logger);
    } catch (error) {
      spinner.fail('Failed to find folder');
      throw error;
    }

    if (!targetFolder) {
      spinner.fail('Folder not found');

      const suggestions = await findSimilarFolders(argv.folder, logger);
      if (suggestions.length > 0) {
        console.log(chalk.yellow('\nDid you mean one of these?'));
        suggestions.forEach(s => {
          console.log(chalk.gray(`  - ${s.path}`));
        });
      }

      process.exit(2);
    }

    spinner.succeed(`Found folder: ${targetFolder.name} (ID: ${targetFolder.id})`);

    // Check if target folder is protected
    if (targetFolder.isProtected && !argv.skipProtected) {
      console.log(chalk.red(`\n⚠️  Folder "${targetFolder.name}" matches protected patterns.`));
      console.log(chalk.yellow('Use --skip-protected to skip protected items.'));
      process.exit(2);
    }

    // Get deletion order (deepest first)
    spinner.start('Building folder deletion order...');
    let foldersToDelete;
    try {
      foldersToDelete = await getDeletionOrder(targetFolder.id, logger);
      spinner.succeed(`Found ${foldersToDelete.length} folder(s) to delete`);
    } catch (error) {
      spinner.fail('Failed to build folder deletion order');
      throw error;
    }

    // Check if folders are empty
    spinner.start('Checking folder contents...');
    const nonEmptyFolders = [];

    try {
      for (const folder of foldersToDelete) {
        const emptyStatus = await isFolderEmpty(folder.id, getDataExtensionsInFolder, logger);
        folder.hasContents = !emptyStatus.isEmpty;
        folder.subfolderCount = emptyStatus.subfolderCount;
        folder.dataExtensionCount = emptyStatus.dataExtensionCount;
        folder.contents = emptyStatus;

        if (!emptyStatus.isEmpty) {
          nonEmptyFolders.push(folder);
        }
      }

      spinner.succeed('Folder contents checked');
    } catch (error) {
      spinner.fail('Failed to check folder contents');
      throw error;
    }

    // Filter protected folders
    const protectedFolders = foldersToDelete.filter(f => f.isProtected);
    let filteredFolders = [...foldersToDelete];

    if (protectedFolders.length > 0) {
      console.log('');
      console.log(chalk.red.bold(`⚠️  ${protectedFolders.length} PROTECTED FOLDER(S) DETECTED:`));
      protectedFolders.forEach(f => {
        console.log(chalk.red(`   - ${f.path || f.name}`));
      });

      if (argv.skipProtected) {
        console.log(chalk.yellow('\n--skip-protected enabled. These will be skipped.'));
        filteredFolders = filteredFolders.filter(f => !f.isProtected);
      } else {
        console.log(chalk.red('\nAborting. Use --skip-protected to skip these items.'));
        process.exit(2);
      }
    }

    // Check for non-empty folders
    const nonEmptyToProcess = filteredFolders.filter(f => f.hasContents);

    if (nonEmptyToProcess.length > 0 && !argv.force) {
      printPreview(filteredFolders, nonEmptyToProcess, false);
      console.log(chalk.red('\nAborting. Empty folders first or use --force.'));
      process.exit(2);
    }

    // Store pre-execution state
    auditLogger.setPreExecutionState({
      totalFolders: filteredFolders.length,
      nonEmptyFolders: nonEmptyToProcess.length,
      forceMode: argv.force
    });

    // Show preview
    printPreview(filteredFolders, nonEmptyToProcess, argv.force);

    // Dry run check
    if (argv.dryRun) {
      console.log('');
      console.log(chalk.cyan.bold('═'.repeat(70)));
      console.log(chalk.cyan.bold('   DRY RUN COMPLETE - No changes were made'));
      console.log(chalk.cyan.bold('   Use --confirm to enable actual deletion'));
      console.log(chalk.cyan.bold('═'.repeat(70)));

      auditLogger.setMetadata('dryRun', true);
      auditLogger.save(0);

      process.exit(0);
    }

    // Get confirmation
    const confirmed = await getConfirmation(
      filteredFolders.length,
      argv.nonInteractive,
      argv.confirmPhrase
    );

    if (!confirmed) {
      console.log(chalk.yellow('\nDeletion cancelled.'));
      auditLogger.setMetadata('cancelled', true);
      auditLogger.save(2);
      process.exit(2);
    }

    // Execute deletions
    console.log('');
    console.log(chalk.bold('Starting deletion...'));

    const results = {
      foldersDeleted: 0,
      desDeleted: 0,
      failed: 0,
      skipped: 0,
      failedItems: []
    };

    for (let i = 0; i < filteredFolders.length; i++) {
      const folder = filteredFolders[i];

      console.log(chalk.gray(`\n[${i + 1}/${filteredFolders.length}] Processing ${folder.path || folder.name}...`));

      // If folder has contents and force mode is on, delete contents first
      if (folder.hasContents && argv.force) {
        console.log(chalk.yellow(`  Deleting contents (force mode)...`));

        // Delete Data Extensions
        if (folder.contents.dataExtensions && folder.contents.dataExtensions.length > 0) {
          for (const de of folder.contents.dataExtensions) {
            console.log(chalk.gray(`    Deleting DE: ${de.name}`));

            try {
              const result = await deleteDataExtension(de.customerKey, logger);

              if (result.success) {
                results.desDeleted++;
                auditLogger.addSuccess({
                  type: 'DataExtension',
                  customerKey: de.customerKey,
                  name: de.name,
                  parentFolder: folder.name
                });
              } else {
                results.failed++;
                results.failedItems.push({ name: `DE: ${de.name}`, error: result.error });
                auditLogger.addFailure({
                  type: 'DataExtension',
                  customerKey: de.customerKey,
                  name: de.name
                }, result.error);
              }
            } catch (error) {
              results.failed++;
              results.failedItems.push({ name: `DE: ${de.name}`, error: error.message });
              auditLogger.addFailure({
                type: 'DataExtension',
                customerKey: de.customerKey,
                name: de.name
              }, error.message);
            }

            await sleep(config.safety.apiRateLimitDelayMs);
          }
        }
      }

      // Delete the folder
      console.log(chalk.gray(`  Deleting folder...`));

      try {
        const result = await deleteFolder(folder.id, logger);

        if (result.success) {
          console.log(chalk.green(`  ✓ Folder deleted`));
          results.foldersDeleted++;
          auditLogger.addSuccess({
            type: 'Folder',
            id: folder.id,
            name: folder.name,
            path: folder.path
          });
        } else {
          console.log(chalk.red(`  ✗ Failed: ${result.error}`));
          results.failed++;
          results.failedItems.push({ name: folder.name, error: result.error });
          auditLogger.addFailure({
            type: 'Folder',
            id: folder.id,
            name: folder.name
          }, result.error);
        }
      } catch (error) {
        console.log(chalk.red(`  ✗ Error: ${error.message}`));
        results.failed++;
        results.failedItems.push({ name: folder.name, error: error.message });
        auditLogger.addFailure({
          type: 'Folder',
          id: folder.id,
          name: folder.name
        }, error.message);
      }

      await sleep(config.safety.apiRateLimitDelayMs);

      // Save state periodically
      if ((i + 1) % 10 === 0) {
        stateManager.save({
          processed: auditLogger.getData().results,
          remaining: filteredFolders.slice(i + 1).map(f => f.id)
        });
      }
    }

    // Determine exit code
    let exitCode = 0;
    if (results.failed > 0) {
      exitCode = 1;
    }

    // Save audit log
    const auditPath = auditLogger.save(exitCode);

    // Print report
    printReport(results, auditPath);

    // Send webhook if configured
    const webhookUrl = argv.webhookUrl || config.webhook.url;
    if (webhookUrl) {
      await sendWebhook(webhookUrl, {
        operation: 'delete-folders',
        operationId: auditLogger.operationId,
        businessUnit: config.sfmc.accountId,
        targetFolder: targetFolder.path,
        results,
        completedAt: new Date().toISOString()
      }, logger);
    }

    // Clear state on success
    if (exitCode === 0) {
      stateManager.clear();
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log('');
    console.log(chalk.green(`✓ Operation complete in ${duration} seconds`));
    console.log(chalk.gray(`  Log file: ${logger.logFilePath}`));

    process.exit(exitCode);

  } catch (error) {
    logger.error(`Deletion failed: ${error.message}`);
    logger.debug(error.stack);
    console.error(chalk.red(`\n❌ Error: ${error.message}`));

    if (stateManager) {
      stateManager.save({
        error: error.message,
        processed: auditLogger.getData().results
      });
    }

    auditLogger.save(1);
    process.exit(1);
  }
}

// Run the deletion
runDeletion();
