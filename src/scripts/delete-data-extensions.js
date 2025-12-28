#!/usr/bin/env node

/**
 * SFMC Data Extension Deletion Script
 *
 * Deletes all Data Extensions within a specified folder and its subfolders,
 * with comprehensive safety checks.
 *
 * IMPORTANT: Defaults to DRY RUN mode. Use --confirm to enable actual deletion.
 *
 * Usage:
 *   node src/scripts/delete-data-extensions.js --folder "Path/To/Folder" [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import config, { validateConfig, isDeProtected } from '../config/index.js';
import { createLogger, createAuditLogger, createStateManager } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { getFolderByPath, getFolderByName, getSubfolders, findSimilarFolders, clearFolderCache } from '../lib/folder-service.js';
import {
  getDataExtensionsInFolder,
  getFullDataExtensionDetails,
  deleteDataExtension,
  backupDataExtensionSchema,
  generateUndoScript,
  filterByDate,
  filterByPattern
} from '../lib/data-extension-service.js';
import {
  analyzeDependencies,
  formatAnalysisReport,
  exportReportToCsv,
  exportDeDependenciesToCsv,
  DependencyClassification
} from '../lib/dependency-analyzer.js';
import {
  sendWebhook,
  deleteFilterActivity,
  deleteAutomation,
  checkFilterInAutomations,
  getAutomations,
  getAutomationWithMetadata
} from '../lib/sfmc-rest.js';
import { deleteQueryActivity } from '../lib/sfmc-soap.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --folder <path> [options]')
  .option('folder', {
    alias: 'f',
    describe: 'Folder path or name containing DEs to delete',
    type: 'string',
    demandOption: true
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
  .option('skip-dependency-check', {
    describe: 'Skip dependency validation (DANGEROUS)',
    type: 'boolean',
    default: false
  })
  .option('force-delete-with-dependencies', {
    describe: 'Delete even if dependencies exist (VERY DANGEROUS)',
    type: 'boolean',
    default: false
  })
  .option('auto-delete-filters', {
    describe: 'Automatically delete standalone filter activities that reference DEs',
    type: 'boolean',
    default: false
  })
  .option('delete-safe-dependencies', {
    describe: 'Auto-delete dependencies classified as safe (standalone filters, stale automations)',
    type: 'boolean',
    default: false
  })
  .option('delete-query-dependencies', {
    describe: 'Also delete Query Activities that reference target DEs (use with --delete-safe-dependencies)',
    type: 'boolean',
    default: false
  })
  .option('skip-protected', {
    describe: 'Skip protected DEs instead of aborting',
    type: 'boolean',
    default: false
  })
  .option('backup-schemas', {
    describe: 'Backup DE schemas before deletion',
    type: 'boolean',
    default: true
  })
  .option('older-than-days', {
    describe: 'Only delete DEs not modified in X days',
    type: 'number'
  })
  .option('exclude-pattern', {
    describe: 'Regex pattern for DE names to exclude',
    type: 'string'
  })
  .option('include-pattern', {
    describe: 'Regex pattern for DE names to include',
    type: 'string'
  })
  .option('batch-size', {
    describe: 'Number of DEs to delete before pausing',
    type: 'number',
    default: 10
  })
  .option('interactive', {
    alias: 'i',
    describe: 'Interactively select which DEs to delete',
    type: 'boolean',
    default: false
  })
  .option('resume', {
    describe: 'Resume a previous operation by ID',
    type: 'string'
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
const logger = createLogger('delete-data-extensions');
const auditLogger = createAuditLogger('delete-des');

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Sleep helper
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Print deletion preview
 */
function printPreview(dataExtensions, summary, backupDir, filtersToDelete = [], automationsToDelete = [], queriesToDelete = []) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.yellow(`┌${line}┐`));
  console.log(chalk.yellow(`│`) + chalk.bold.yellow('                    ⚠️  DELETION PREVIEW').padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`├${line}┤`));
  console.log(chalk.yellow(`│`) + ` Business Unit: ${config.sfmc.accountId}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` Target Folder: ${summary.targetFolder}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` Total Data Extensions to Delete: ${dataExtensions.length}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` Total Records that will be PERMANENTLY DELETED: ${formatNumber(summary.totalRecords)}`.padEnd(width) + chalk.yellow(`│`));
  console.log(chalk.yellow(`│`) + ` DEs with PII: ${summary.withPii}`.padEnd(width) + chalk.yellow(`│`));

  if (filtersToDelete.length > 0) {
    console.log(chalk.yellow(`│`) + ` Filter Activities to Delete: ${filtersToDelete.length}`.padEnd(width) + chalk.yellow(`│`));
  }

  if (automationsToDelete.length > 0) {
    console.log(chalk.yellow(`│`) + ` Stale Automations to Delete: ${automationsToDelete.length}`.padEnd(width) + chalk.yellow(`│`));
  }

  if (queriesToDelete.length > 0) {
    console.log(chalk.yellow(`│`) + ` Query Activities to Delete: ${queriesToDelete.length}`.padEnd(width) + chalk.yellow(`│`));
  }

  if (backupDir) {
    console.log(chalk.yellow(`│`) + ` Schema Backups: ${backupDir}`.padEnd(width) + chalk.yellow(`│`));
  }

  console.log(chalk.yellow(`├${line}┤`));
  console.log(chalk.yellow(`│`) + ' Data Extensions:'.padEnd(width) + chalk.yellow(`│`));

  dataExtensions.slice(0, 20).forEach((de, i) => {
    const rowInfo = de.rowCount !== null ? ` (${formatNumber(de.rowCount)} rows)` : '';
    const lineText = `   ${i + 1}. ${de.name}${rowInfo}`;
    console.log(chalk.yellow(`│`) + lineText.substring(0, width).padEnd(width) + chalk.yellow(`│`));
  });

  if (dataExtensions.length > 20) {
    console.log(chalk.yellow(`│`) + `   ... and ${dataExtensions.length - 20} more`.padEnd(width) + chalk.yellow(`│`));
  }

  // Show filters if any
  if (filtersToDelete.length > 0) {
    console.log(chalk.yellow(`├${line}┤`));
    console.log(chalk.yellow(`│`) + ' Filter Activities:'.padEnd(width) + chalk.yellow(`│`));
    filtersToDelete.slice(0, 10).forEach((filter, i) => {
      const lineText = `   ${i + 1}. ${filter.name}`;
      console.log(chalk.yellow(`│`) + lineText.substring(0, width).padEnd(width) + chalk.yellow(`│`));
    });
    if (filtersToDelete.length > 10) {
      console.log(chalk.yellow(`│`) + `   ... and ${filtersToDelete.length - 10} more`.padEnd(width) + chalk.yellow(`│`));
    }
  }

  // Show automations if any
  if (automationsToDelete.length > 0) {
    console.log(chalk.yellow(`├${line}┤`));
    console.log(chalk.yellow(`│`) + ' Stale Automations:'.padEnd(width) + chalk.yellow(`│`));
    automationsToDelete.slice(0, 10).forEach((auto, i) => {
      const lineText = `   ${i + 1}. ${auto.name} (${auto.reason})`;
      console.log(chalk.yellow(`│`) + lineText.substring(0, width).padEnd(width) + chalk.yellow(`│`));
    });
    if (automationsToDelete.length > 10) {
      console.log(chalk.yellow(`│`) + `   ... and ${automationsToDelete.length - 10} more`.padEnd(width) + chalk.yellow(`│`));
    }
  }

  // Show queries if any
  if (queriesToDelete.length > 0) {
    console.log(chalk.yellow(`├${line}┤`));
    console.log(chalk.yellow(`│`) + ' Query Activities:'.padEnd(width) + chalk.yellow(`│`));
    queriesToDelete.slice(0, 10).forEach((query, i) => {
      const lineText = `   ${i + 1}. ${query.name}`;
      console.log(chalk.yellow(`│`) + lineText.substring(0, width).padEnd(width) + chalk.yellow(`│`));
    });
    if (queriesToDelete.length > 10) {
      console.log(chalk.yellow(`│`) + `   ... and ${queriesToDelete.length - 10} more`.padEnd(width) + chalk.yellow(`│`));
    }
  }

  console.log(chalk.yellow(`└${line}┘`));
}

/**
 * Interactive DE selection
 */
async function interactiveSelection(dataExtensions) {
  const choices = dataExtensions.map(de => {
    let label = de.name;
    if (de.rowCount !== null) {
      label += ` (${formatNumber(de.rowCount)} rows)`;
    }
    if (de.hasDependencies) {
      label = chalk.yellow(label + ' [has dependencies]');
    }
    if (de.isProtected) {
      label = chalk.red(label + ' [PROTECTED]');
    }

    return {
      name: label,
      value: de.customerKey,
      checked: !de.isProtected && !de.hasDependencies
    };
  });

  const answers = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select Data Extensions to delete (space to toggle, enter to confirm):',
      choices,
      pageSize: 20
    }
  ]);

  return dataExtensions.filter(de => answers.selected.includes(de.customerKey));
}

/**
 * Get confirmation from user
 */
async function getConfirmation(count, nonInteractive, confirmPhrase) {
  const expectedPhrase = `DELETE ${count} DATA EXTENSION${count === 1 ? '' : 'S'}`;

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
  console.log(chalk.red.bold(`│  You are about to permanently delete ${String(count).padEnd(3)} Data Extension(s)       │`));
  console.log(chalk.red.bold('│                                                                  │'));
  console.log(chalk.red.bold(`│  Type '${expectedPhrase}' to confirm:              │`));
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
 * Export dependencies to CSV file with full automation analysis
 * @param {object[]} desWithDeps - Data Extensions with dependencies
 * @param {string} targetFolder - Target folder name for filename
 * @param {object} logger - Logger instance
 * @returns {Promise<string>} Path to the exported CSV file
 */
async function exportDependenciesToCsv(desWithDeps, targetFolder, logger = null) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const sanitizedFolder = targetFolder.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const filename = `dependencies-${sanitizedFolder}-${timestamp}.csv`;
  const outputDir = path.resolve(process.cwd(), 'audit');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filepath = path.join(outputDir, filename);

  // Pre-load automations for filter analysis
  console.log(chalk.gray('  Analyzing filter dependencies for CSV export...'));
  let automations = [];
  try {
    automations = await getAutomations(logger);
  } catch (e) {
    if (logger) logger.debug(`Could not load automations for CSV: ${e.message}`);
  }

  // Escape CSV values (wrap in quotes if contains comma or quote)
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Cache for automation metadata to avoid repeated API calls
  const automationMetadataCache = new Map();

  // Helper to get automation metadata with caching
  const getAutomationMetadataCached = async (automationId) => {
    if (automationMetadataCache.has(automationId)) {
      return automationMetadataCache.get(automationId);
    }
    try {
      const metadata = await getAutomationWithMetadata(automationId, logger);
      automationMetadataCache.set(automationId, metadata);
      return metadata;
    } catch (e) {
      return null;
    }
  };

  // CSV header - expanded to include automation usage details and metadata
  const header = [
    'Data Extension Name',
    'Data Extension CustomerKey',
    'Dependency Type',
    'Dependency Name',
    'Dependency ID',
    'Dependency Status',
    'Details',
    'Used In Automation',
    'Automation Name',
    'Automation Status',
    'Automation Created Date',
    'Automation Last Run Time',
    'Can Auto-Delete',
    'Blocking'
  ].join(',');

  const rows = [header];

  for (const de of desWithDeps) {
    for (const dep of de.dependencies || []) {
      if (dep.type === 'Filter Activity') {
        // Check if filter is used in automations
        const usageCheck = await checkFilterInAutomations(dep.id, automations, logger);

        if (usageCheck.isUsed && usageCheck.automations.length > 0) {
          // Add a row for each automation the filter is used in
          for (const automation of usageCheck.automations) {
            // Get additional automation metadata
            const metadata = await getAutomationMetadataCached(automation.automationId);

            rows.push([
              escapeCSV(de.name),
              escapeCSV(de.customerKey),
              escapeCSV(dep.type),
              escapeCSV(dep.name),
              escapeCSV(dep.id),
              escapeCSV(dep.status),
              escapeCSV(dep.details || ''),
              'Yes',
              escapeCSV(automation.automationName),
              escapeCSV(automation.automationStatus),
              escapeCSV(metadata?.createdDate || ''),
              escapeCSV(metadata?.lastRunTime || ''),
              'No',
              'Yes'
            ].join(','));
          }
        } else {
          // Standalone filter - not used in any automation
          rows.push([
            escapeCSV(de.name),
            escapeCSV(de.customerKey),
            escapeCSV(dep.type),
            escapeCSV(dep.name),
            escapeCSV(dep.id),
            escapeCSV(dep.status),
            escapeCSV(dep.details || ''),
            'No',
            '',
            '',
            '',
            '',
            'Yes',
            'No'
          ].join(','));
        }
      } else {
        // Non-filter dependencies (always blocking)
        rows.push([
          escapeCSV(de.name),
          escapeCSV(de.customerKey),
          escapeCSV(dep.type),
          escapeCSV(dep.name),
          escapeCSV(dep.id),
          escapeCSV(dep.status),
          escapeCSV(dep.details || ''),
          'N/A',
          '',
          '',
          '',
          '',
          'No',
          'Yes'
        ].join(','));
      }
    }
  }

  fs.writeFileSync(filepath, rows.join('\n'), 'utf-8');

  return filepath;
}

/**
 * Categorize dependencies into deletable (standalone filters) and blocking (other types)
 * @param {object} de - Data Extension with dependencies
 * @param {object[]} automations - Pre-loaded automations for filter check
 * @param {object} logger - Logger instance
 * @returns {Promise<{deletableFilters: object[], blockingDeps: object[]}>}
 */
async function categorizeDependencies(de, automations, logger) {
  const deletableFilters = [];
  const blockingDeps = [];

  for (const dep of de.dependencies || []) {
    if (dep.type === 'Filter Activity') {
      // Check if this filter is used in any automation
      const filterId = dep.id;
      const usageCheck = await checkFilterInAutomations(filterId, automations, logger);

      if (usageCheck.isUsed) {
        // Filter is in an automation - blocking dependency
        // Deduplicate and limit automation names to prevent extremely long reasons
        const uniqueAutomationNames = [...new Set(usageCheck.automations.map(a => a.automationName))];
        const displayNames = uniqueAutomationNames.slice(0, 2);
        const remaining = uniqueAutomationNames.length - displayNames.length;
        let reasonText = displayNames.join(', ');
        if (remaining > 0) {
          reasonText += ` (+${remaining} more)`;
        }
        blockingDeps.push({
          ...dep,
          reason: `Used in automation: ${reasonText}`
        });
      } else {
        // Standalone filter - can be deleted
        deletableFilters.push(dep);
      }
    } else {
      // All other dependency types are blocking
      blockingDeps.push(dep);
    }
  }

  return { deletableFilters, blockingDeps };
}

/**
 * Handle dependencies interactively
 * @param {object[]} desWithDeps - DEs that have dependencies
 * @param {object} logger - Logger instance
 * @param {boolean} autoDeleteFilters - Auto-delete standalone filters without prompting
 * @param {boolean} nonInteractive - Running in non-interactive mode
 * @param {string} targetFolder - Target folder name (for CSV export filename)
 * @returns {Promise<{proceed: object[], skip: object[], filtersToDelete: object[]}>}
 */
async function handleDependenciesInteractively(desWithDeps, logger, autoDeleteFilters = false, nonInteractive = false, targetFolder = 'unknown') {
  const proceed = [];
  const skip = [];
  const filtersToDelete = [];
  let csvExported = false;
  let confirmAllMode = null; // null = ask each, 'delete' = delete all, 'skip' = skip all

  // Offer CSV export option first (before processing individual DEs)
  if (!nonInteractive && desWithDeps.length > 0) {
    console.log('');
    const exportAnswer = await inquirer.prompt([{
      type: 'list',
      name: 'exportFirst',
      message: `${desWithDeps.length} DE(s) have dependencies. Would you like to export them to CSV first?`,
      choices: [
        { name: 'No, proceed with interactive resolution', value: 'no' },
        { name: 'Yes, export to CSV then continue', value: 'export' },
        { name: 'Yes, export to CSV and abort (review offline)', value: 'export_abort' }
      ]
    }]);

    if (exportAnswer.exportFirst === 'export' || exportAnswer.exportFirst === 'export_abort') {
      const csvPath = await exportDependenciesToCsv(desWithDeps, targetFolder, logger);
      console.log(chalk.green(`\n✓ Dependencies exported to: ${csvPath}`));
      csvExported = true;

      if (exportAnswer.exportFirst === 'export_abort') {
        console.log(chalk.yellow('\nOperation aborted. Review the CSV file and run again when ready.'));
        return { proceed: [], skip: [], filtersToDelete: [], aborted: true, csvExported: true, csvPath };
      }
    }

    // Ask if user wants to confirm all at once or individually
    const bulkAnswer = await inquirer.prompt([{
      type: 'list',
      name: 'bulkMode',
      message: 'How would you like to handle these DEs with dependencies?',
      choices: [
        { name: 'Review and confirm each DE individually', value: 'individual' },
        { name: 'Delete ALL DEs (and their safe dependencies) without individual prompts', value: 'delete_all' },
        { name: 'Skip ALL DEs with dependencies', value: 'skip_all' },
        { name: 'Abort operation', value: 'abort' }
      ]
    }]);

    if (bulkAnswer.bulkMode === 'abort') {
      return { proceed: [], skip: [], filtersToDelete: [], aborted: true };
    } else if (bulkAnswer.bulkMode === 'delete_all') {
      confirmAllMode = 'delete';
    } else if (bulkAnswer.bulkMode === 'skip_all') {
      confirmAllMode = 'skip';
    }
    // 'individual' keeps confirmAllMode as null
  }

  // Pre-load automations for efficiency
  console.log(chalk.gray('\nAnalyzing filter dependencies...'));
  let automations = [];
  try {
    automations = await getAutomations(logger);
  } catch (e) {
    logger.debug(`Could not load automations: ${e.message}`);
  }

  for (const de of desWithDeps) {
    const { deletableFilters, blockingDeps } = await categorizeDependencies(de, automations, logger);

    console.log('');
    // DE header with box drawing
    const deName = de.name.length > 50 ? de.name.substring(0, 47) + '...' : de.name;
    console.log(chalk.yellow('┌─ ') + chalk.yellow.bold(deName) + chalk.yellow(' ─'.padEnd(55 - deName.length, '─') + '┐'));

    // Show deletable filters (standalone) - these are OK
    if (deletableFilters.length > 0) {
      console.log(chalk.yellow('│'));
      console.log(chalk.yellow('│ ') + chalk.green.bold('✓ CAN AUTO-DELETE:'));
      deletableFilters.forEach(f => {
        const name = f.name.length > 48 ? f.name.substring(0, 45) + '...' : f.name;
        console.log(chalk.yellow('│   ') + chalk.green(`Filter: ${name}`));
      });
    }

    // Show blocking dependencies - these need attention
    if (blockingDeps.length > 0) {
      console.log(chalk.yellow('│'));
      console.log(chalk.yellow('│ ') + chalk.red.bold('✗ BLOCKING (require manual resolution):'));

      // Group by type for cleaner display
      const blockingByType = {};
      for (const dep of blockingDeps) {
        if (!blockingByType[dep.type]) {
          blockingByType[dep.type] = [];
        }
        blockingByType[dep.type].push(dep);
      }

      for (const [type, deps] of Object.entries(blockingByType)) {
        console.log(chalk.yellow('│   ') + chalk.red(`${type}:`));
        deps.forEach(dep => {
          const name = dep.name.length > 40 ? dep.name.substring(0, 37) + '...' : dep.name;
          // Truncate reason to prevent extremely long automation names from breaking display
          let reason = '';
          if (dep.reason) {
            const truncatedReason = dep.reason.length > 50 ? dep.reason.substring(0, 47) + '...' : dep.reason;
            reason = chalk.gray(` (${truncatedReason})`);
          }
          console.log(chalk.yellow('│     ') + chalk.white(`• ${name}`) + reason);
        });
      }
    }

    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('└' + '─'.repeat(56) + '┘'));

    // Determine action based on confirmAllMode or individual prompts
    if (confirmAllMode === 'skip') {
      // Bulk skip mode
      console.log(chalk.yellow(`  → Skipping (bulk skip mode)`));
      skip.push(de);
      continue;
    } else if (confirmAllMode === 'delete') {
      // Bulk delete mode - delete DE and safe dependencies, ignore blocking
      if (blockingDeps.length > 0) {
        console.log(chalk.cyan(`  → Will delete DE and ${deletableFilters.length} safe dep(s), ignoring ${blockingDeps.length} blocking dep(s)`));
      } else {
        console.log(chalk.green(`  → Will delete DE and ${deletableFilters.length} standalone filter(s)`));
      }
      proceed.push(de);
      filtersToDelete.push(...deletableFilters);
      continue;
    }

    // Individual confirmation mode (confirmAllMode === null)
    if (blockingDeps.length > 0) {
      // Has blocking dependencies - need user decision
      if (nonInteractive) {
        console.log(chalk.yellow(`  → Skipping (has blocking dependencies, non-interactive mode)`));
        skip.push(de);
        continue;
      }

      const choices = [
        { name: 'Skip this DE and continue with others', value: 'skip' },
        { name: 'Force delete (ignore all dependencies)', value: 'force' },
        { name: 'Abort entire operation', value: 'abort' }
      ];

      if (deletableFilters.length > 0) {
        choices.unshift({
          name: `Delete DE and ${deletableFilters.length} standalone filter(s), ignore ${blockingDeps.length} blocking dep(s)`,
          value: 'partial'
        });
      }

      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices
      }]);

      switch (answer.action) {
        case 'skip':
          skip.push(de);
          break;
        case 'force':
          proceed.push(de);
          filtersToDelete.push(...deletableFilters);
          break;
        case 'partial':
          proceed.push(de);
          filtersToDelete.push(...deletableFilters);
          break;
        case 'abort':
          return { proceed: [], skip: [], filtersToDelete: [], aborted: true };
      }

    } else if (deletableFilters.length > 0) {
      // Only has standalone filters - can delete them
      if (autoDeleteFilters || nonInteractive) {
        console.log(chalk.green(`  → Will delete DE and ${deletableFilters.length} standalone filter(s)`));
        proceed.push(de);
        filtersToDelete.push(...deletableFilters);
      } else {
        const answer = await inquirer.prompt([{
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: `Delete DE and ${deletableFilters.length} standalone filter(s) (Recommended)`, value: 'delete' },
            { name: 'Skip this DE', value: 'skip' },
            { name: 'Abort entire operation', value: 'abort' }
          ]
        }]);

        switch (answer.action) {
          case 'delete':
            proceed.push(de);
            filtersToDelete.push(...deletableFilters);
            break;
          case 'skip':
            skip.push(de);
            break;
          case 'abort':
            return { proceed: [], skip: [], filtersToDelete: [], aborted: true };
        }
      }
    }
  }

  return { proceed, skip, filtersToDelete, aborted: false, csvExported };
}

/**
 * Print final report
 */
function printReport(results, auditPath, backupDir, undoPath) {
  const width = 70;
  const line = '─'.repeat(width);

  console.log('');
  console.log(chalk.cyan(`┌${line}┐`));
  console.log(chalk.cyan(`│`) + chalk.bold.white('                    DELETION COMPLETE').padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`├${line}┤`));
  console.log(chalk.cyan(`│`) + ` Data Extensions Deleted: ${chalk.green(results.successful)}`.padEnd(width + 10) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Data Extensions Failed: ${chalk.red(results.failed)}`.padEnd(width + 10) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Skipped (protected): ${results.skipped}`.padEnd(width) + chalk.cyan(`│`));

  // Show filter results if any were processed
  if (results.filtersDeleted > 0 || results.filtersFailed > 0) {
    console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
    console.log(chalk.cyan(`│`) + ` Filter Activities Deleted: ${chalk.green(results.filtersDeleted)}`.padEnd(width + 10) + chalk.cyan(`│`));
    if (results.filtersFailed > 0) {
      console.log(chalk.cyan(`│`) + ` Filter Activities Failed: ${chalk.yellow(results.filtersFailed)}`.padEnd(width + 10) + chalk.cyan(`│`));
    }
  }

  // Show automation results if any were processed
  if (results.automationsDeleted > 0 || results.automationsFailed > 0) {
    console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
    console.log(chalk.cyan(`│`) + ` Stale Automations Deleted: ${chalk.green(results.automationsDeleted)}`.padEnd(width + 10) + chalk.cyan(`│`));
    if (results.automationsFailed > 0) {
      console.log(chalk.cyan(`│`) + ` Stale Automations Failed: ${chalk.yellow(results.automationsFailed)}`.padEnd(width + 10) + chalk.cyan(`│`));
    }
  }

  // Show query results if any were processed
  if (results.queriesDeleted > 0 || results.queriesFailed > 0) {
    console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
    console.log(chalk.cyan(`│`) + ` Query Activities Deleted: ${chalk.green(results.queriesDeleted)}`.padEnd(width + 10) + chalk.cyan(`│`));
    if (results.queriesFailed > 0) {
      console.log(chalk.cyan(`│`) + ` Query Activities Failed: ${chalk.yellow(results.queriesFailed)}`.padEnd(width + 10) + chalk.cyan(`│`));
    }
  }

  if (results.failedItems && results.failedItems.length > 0) {
    console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
    console.log(chalk.cyan(`│`) + ' Failed Deletions:'.padEnd(width) + chalk.cyan(`│`));
    results.failedItems.forEach(item => {
      const lineText = `   • ${item.name} - ${item.error}`.substring(0, width - 2);
      console.log(chalk.cyan(`│`) + chalk.red(lineText.padEnd(width)) + chalk.cyan(`│`));
    });
  }

  console.log(chalk.cyan(`│`) + ''.padEnd(width) + chalk.cyan(`│`));
  console.log(chalk.cyan(`│`) + ` Audit Log: ${auditPath}`.padEnd(width) + chalk.cyan(`│`));

  if (backupDir) {
    console.log(chalk.cyan(`│`) + ` Backup Schemas: ${backupDir}`.padEnd(width) + chalk.cyan(`│`));
  }

  if (undoPath) {
    console.log(chalk.cyan(`│`) + ` Undo Script: ${undoPath}`.padEnd(width) + chalk.cyan(`│`));
  }

  console.log(chalk.cyan(`└${line}┘`));
}

/**
 * Main deletion function
 */
async function runDeletion() {
  const startTime = Date.now();
  let stateManager = null;
  let targetFolder = null;
  let allDataExtensions = [];
  let desToDelete = [];
  let backupDir = null;

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
        targetFolder: targetFolder?.path,
        processed: auditLogger.getData().results,
        remaining: desToDelete.map(de => de.customerKey)
      });
      console.log(chalk.yellow(`State saved. Resume with: --resume ${auditLogger.operationId}`));
    }

    process.exit(2);
  });

  try {
    // Validate configuration
    validateConfig();

    logger.section('SFMC DATA EXTENSION DELETION');
    logger.info(`Target folder: ${argv.folder}`);
    logger.info(`Mode: ${argv.dryRun ? 'DRY RUN' : 'LIVE DELETION'}`);

    // Store options in audit log
    auditLogger.setOptions({
      dryRun: argv.dryRun,
      skipDependencyCheck: argv.skipDependencyCheck,
      forceDeleteWithDependencies: argv.forceDeleteWithDependencies,
      skipProtected: argv.skipProtected,
      backupSchemas: argv.backupSchemas,
      olderThanDays: argv.olderThanDays,
      excludePattern: argv.excludePattern,
      includePattern: argv.includePattern,
      interactive: argv.interactive
    });

    // Check for resume
    if (argv.resume) {
      stateManager = createStateManager(argv.resume);
      const savedState = stateManager.load();

      if (savedState) {
        logger.info(`Resuming operation ${argv.resume}`);
        console.log(chalk.yellow(`Resuming from saved state. ${savedState.remaining?.length || 0} items remaining.`));
        // Would continue from saved state here
      } else {
        logger.warn(`No saved state found for ${argv.resume}`);
      }
    }

    stateManager = createStateManager(auditLogger.operationId);

    // Test connection
    const spinner = ora('Connecting to SFMC...').start();
    const connectionResult = await testConnection(logger);

    if (!connectionResult.success) {
      spinner.fail('Connection failed');
      logger.error(connectionResult.error);
      process.exit(2);
    }

    spinner.succeed('Connected to SFMC');

    // Handle cache refresh if requested
    if (argv.refreshCache) {
      spinner.start('Clearing cache and fetching fresh data from SFMC...');
      await clearFolderCache(logger);
      spinner.succeed('Cache cleared - will fetch fresh data');
    }

    // Find target folder
    spinner.start('Finding target folder...');
    targetFolder = await getFolderByPath(argv.folder, logger);

    if (!targetFolder) {
      targetFolder = await getFolderByName(argv.folder, logger);
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

    // Check if target folder is protected
    if (targetFolder.isProtected && !argv.skipProtected) {
      spinner.fail('Target folder is protected');
      console.log(chalk.red(`\nFolder "${targetFolder.name}" matches protected patterns.`));
      console.log(chalk.yellow('Use --skip-protected to skip protected items.'));
      process.exit(2);
    }

    spinner.succeed(`Found folder: ${targetFolder.name} (ID: ${targetFolder.id})`);

    // Get subfolders
    spinner.start('Discovering subfolders...');
    const subfolders = await getSubfolders(targetFolder.id, true, logger);
    const allFolders = [targetFolder, ...subfolders];
    spinner.succeed(`Found ${allFolders.length} folder(s)`);

    // Get all data extensions
    spinner.start('Discovering Data Extensions...');

    for (const folder of allFolders) {
      const des = await getDataExtensionsInFolder(folder.id, logger);
      des.forEach(de => {
        de.folderPath = folder.path;
      });
      allDataExtensions.push(...des);
    }

    spinner.succeed(`Found ${allDataExtensions.length} Data Extension(s)`);

    if (allDataExtensions.length === 0) {
      console.log(chalk.green('\nNo Data Extensions found in the specified folder(s).'));
      process.exit(0);
    }

    // Apply filters
    let filteredDes = [...allDataExtensions];

    // Date filters
    if (argv.olderThanDays) {
      spinner.start(`Applying date filter (older than ${argv.olderThanDays} days)...`);
      filteredDes = filterByDate(filteredDes, { olderThanDays: argv.olderThanDays });
      spinner.succeed(`After date filter: ${filteredDes.length} DE(s)`);
    }

    // Pattern filters
    if (argv.excludePattern || argv.includePattern) {
      spinner.start('Applying pattern filters...');
      filteredDes = filterByPattern(filteredDes, {
        exclude: argv.excludePattern,
        include: argv.includePattern
      });
      spinner.succeed(`After pattern filter: ${filteredDes.length} DE(s)`);
    }

    if (filteredDes.length === 0) {
      console.log(chalk.green('\nNo Data Extensions match the specified filters.'));
      process.exit(0);
    }

    // Get detailed info for each DE
    spinner.start('Gathering Data Extension details...');

    for (let i = 0; i < filteredDes.length; i++) {
      const de = filteredDes[i];
      spinner.text = `Gathering details: ${i + 1}/${filteredDes.length} - ${de.name}`;

      const details = await getFullDataExtensionDetails(de.customerKey, true, logger);
      if (details) {
        Object.assign(de, details);
      }
    }

    spinner.succeed('Data Extension details gathered');

    // Check protection
    const protectedDes = filteredDes.filter(de => de.isProtected);

    if (protectedDes.length > 0) {
      console.log('');
      console.log(chalk.red.bold(`⚠️  ${protectedDes.length} PROTECTED DATA EXTENSION(S) DETECTED:`));
      protectedDes.forEach(de => {
        console.log(chalk.red(`   - ${de.name} (${de.customerKey})`));
      });

      if (argv.skipProtected) {
        console.log(chalk.yellow('\n--skip-protected enabled. These will be skipped.'));
        filteredDes = filteredDes.filter(de => !de.isProtected);
      } else {
        console.log(chalk.red('\nAborting. Use --skip-protected to skip these items.'));
        process.exit(2);
      }
    }

    // Check dependencies using smart analysis
    let filtersToDelete = [];
    let automationsToDelete = [];
    let queriesToDelete = [];
    let dependenciesToDelete = []; // Safe dependencies that will be auto-deleted
    let dependencyReport = null;

    if (!argv.skipDependencyCheck && filteredDes.length > 0) {
      spinner.start('Running smart dependency analysis...');

      // Prepare DE objects for analysis
      const desForAnalysis = filteredDes.map(de => ({
        customerKey: de.customerKey,
        objectId: de.objectId,
        name: de.name
      }));

      dependencyReport = await analyzeDependencies(desForAnalysis, {
        logger,
        onProgress: (stage, current, total, message) => {
          spinner.text = message;
        }
      });

      // Merge dependency info into DE objects
      for (const de of filteredDes) {
        const deDeps = dependencyReport.deMapping?.get(de.customerKey) || [];
        de.hasDependencies = deDeps.length > 0;
        de.dependencyCount = deDeps.length;
        de.dependencies = deDeps.map(ref => {
          const fullDep = dependencyReport.all.find(d => d.type === ref.type && d.id === ref.id);
          return fullDep || ref;
        });

        // Count safe vs blocking
        de.safeToDeleteDeps = de.dependencies.filter(d =>
          d.classification === DependencyClassification.SAFE_TO_DELETE
        ).length;
        de.blockingDeps = de.dependencies.filter(d =>
          d.classification !== DependencyClassification.SAFE_TO_DELETE
        ).length;
      }

      spinner.succeed(`Smart analysis complete: ${dependencyReport.summary.safeToDelete} safe, ${dependencyReport.summary.requiresReview} require review`);

      // Print the smart analysis report
      console.log(formatAnalysisReport(dependencyReport));

      const withDeps = filteredDes.filter(de => de.hasDependencies);
      const withoutDeps = filteredDes.filter(de => !de.hasDependencies);

      // Separate DEs by whether they have only safe deps or blocking deps
      const withOnlySafeDeps = withDeps.filter(de => de.blockingDeps === 0);
      const withBlockingDeps = withDeps.filter(de => de.blockingDeps > 0);

      if (withDeps.length > 0) {
        console.log('');
        console.log(chalk.bold('📊 DEPENDENCY SUMMARY BY DE:'));
        console.log('');

        // Show DEs with only safe dependencies
        if (withOnlySafeDeps.length > 0) {
          console.log(chalk.green.bold(`  ✓ ${withOnlySafeDeps.length} DE(s) have ONLY safe-to-delete dependencies`));
          withOnlySafeDeps.slice(0, 5).forEach(de => {
            console.log(chalk.green(`    • ${de.name} (${de.safeToDeleteDeps} safe deps)`));
          });
          if (withOnlySafeDeps.length > 5) {
            console.log(chalk.green(`    ... and ${withOnlySafeDeps.length - 5} more`));
          }
          console.log('');
        }

        // Show DEs with blocking dependencies
        if (withBlockingDeps.length > 0) {
          console.log(chalk.yellow.bold(`  ⚠ ${withBlockingDeps.length} DE(s) have BLOCKING dependencies (require review)`));
          withBlockingDeps.slice(0, 5).forEach(de => {
            console.log(chalk.yellow(`    • ${de.name} (${de.blockingDeps} blocking, ${de.safeToDeleteDeps} safe)`));
            // Show blocking deps
            de.dependencies
              .filter(d => d.classification !== DependencyClassification.SAFE_TO_DELETE)
              .slice(0, 2)
              .forEach(d => {
                console.log(chalk.gray(`      └─ ${d.type}: ${d.name}`));
              });
          });
          if (withBlockingDeps.length > 5) {
            console.log(chalk.yellow(`    ... and ${withBlockingDeps.length - 5} more`));
          }
          console.log('');
        }

        if (argv.forceDeleteWithDependencies) {
          // Force mode - proceed with all
          console.log(chalk.red.bold('\n⚠️  --force-delete-with-dependencies enabled. Proceeding despite dependencies!'));
        } else if (argv.deleteSafeDependencies) {
          // Auto-delete safe dependencies mode
          console.log(chalk.cyan.bold('\n🔄 --delete-safe-dependencies enabled'));
          console.log(chalk.cyan('   Safe dependencies will be automatically deleted.'));

          // Collect safe dependencies to delete
          dependenciesToDelete = dependencyReport.safeToDelete;
          console.log(chalk.cyan(`   ${dependenciesToDelete.length} safe dependencies queued for deletion.`));

          // Handle blocking deps
          if (withBlockingDeps.length > 0) {
            console.log(chalk.yellow(`\n   ${withBlockingDeps.length} DE(s) have blocking dependencies and will be skipped.`));
            filteredDes = [...withoutDeps, ...withOnlySafeDeps];
          } else {
            filteredDes = [...withoutDeps, ...withOnlySafeDeps];
          }

          // Extract filter activities for deletion
          filtersToDelete = dependenciesToDelete
            .filter(d => d.type === 'Filter Activity')
            .map(d => ({ id: d.id, name: d.name }));

          // Extract stale automations for deletion
          automationsToDelete = dependenciesToDelete
            .filter(d => d.type === 'Automation')
            .map(d => ({ id: d.id, name: d.name, reason: d.classificationReason }));

          // Extract query activities for deletion (if --delete-query-dependencies is set)
          if (argv.deleteQueryDependencies) {
            // Get ALL query activities that reference target DEs (regardless of classification)
            queriesToDelete = dependencyReport.all
              .filter(d => d.type === 'Query Activity')
              .map(d => ({ id: d.id, name: d.name, matchDetails: d.metadata?.matchDetails }));

            if (queriesToDelete.length > 0) {
              console.log(chalk.cyan(`   ${queriesToDelete.length} Query Activities queued for deletion.`));

              // With queries being deleted, DEs that were blocked only by queries can now proceed
              const desBlockedOnlyByQueries = withBlockingDeps.filter(de => {
                const nonQueryBlockingDeps = de.dependencies.filter(d =>
                  d.classification !== DependencyClassification.SAFE_TO_DELETE &&
                  d.type !== 'Query Activity'
                );
                return nonQueryBlockingDeps.length === 0;
              });

              if (desBlockedOnlyByQueries.length > 0) {
                console.log(chalk.cyan(`   ${desBlockedOnlyByQueries.length} DE(s) unblocked (were only blocked by queries).`));
                filteredDes = [...withoutDeps, ...withOnlySafeDeps, ...desBlockedOnlyByQueries];
              }
            }
          }
        } else {
          // Interactive handling
          console.log('');
          console.log(chalk.cyan('━'.repeat(70)));
          console.log(chalk.cyan.bold('  DEPENDENCY RESOLUTION'));
          console.log(chalk.cyan('━'.repeat(70)));
          console.log(chalk.gray('  Dependencies classified as "safe" (standalone filters, stale automations)'));
          console.log(chalk.gray('  can be automatically deleted with --delete-safe-dependencies flag.'));
          console.log(chalk.gray('  Other dependencies require manual resolution.'));

          const depResult = await handleDependenciesInteractively(
            withDeps,
            logger,
            argv.autoDeleteFilters,
            argv.nonInteractive,
            targetFolder.Name || argv.folder
          );

          if (depResult.aborted) {
            console.log(chalk.yellow('\nOperation aborted by user.'));
            auditLogger.setMetadata('aborted', true);
            auditLogger.save(2);
            process.exit(2);
          }

          // Update filtered list: keep DEs without deps + approved DEs with deps
          filteredDes = [...withoutDeps, ...depResult.proceed];
          filtersToDelete = depResult.filtersToDelete;

          if (depResult.skip.length > 0) {
            console.log(chalk.yellow(`\nSkipping ${depResult.skip.length} DE(s) with unresolved dependencies.`));
          }

          if (filtersToDelete.length > 0) {
            console.log(chalk.cyan(`\n${filtersToDelete.length} standalone filter activity(s) will be deleted.`));
          }

          if (filteredDes.length === 0) {
            console.log(chalk.yellow('\nNo Data Extensions remaining to delete.'));
            process.exit(0);
          }
        }
      }

      // Export dependency report to CSV
      if (dependencyReport && dependencyReport.all.length > 0) {
        const timestamp = dayjs().format('YYYYMMDD-HHmmss');
        const depCsvPath = path.join(config.paths.audit, `delete-dependencies-${timestamp}.csv`);

        if (!fs.existsSync(config.paths.audit)) {
          fs.mkdirSync(config.paths.audit, { recursive: true });
        }

        fs.writeFileSync(depCsvPath, exportReportToCsv(dependencyReport));
        console.log(chalk.gray(`\n📄 Dependency report saved: ${depCsvPath}`));
      }
    }

    // Interactive selection
    if (argv.interactive) {
      desToDelete = await interactiveSelection(filteredDes);

      if (desToDelete.length === 0) {
        console.log(chalk.yellow('\nNo Data Extensions selected.'));
        process.exit(0);
      }
    } else {
      desToDelete = filteredDes;
    }

    // Backup schemas
    if (argv.backupSchemas && desToDelete.length > 0) {
      const timestamp = dayjs().format('YYYYMMDD-HHmmss');
      backupDir = path.join(config.paths.backup, timestamp);

      spinner.start('Backing up DE schemas...');

      for (let i = 0; i < desToDelete.length; i++) {
        const de = desToDelete[i];
        spinner.text = `Backing up schemas: ${i + 1}/${desToDelete.length}`;

        try {
          await backupDataExtensionSchema(de.customerKey, backupDir, logger);
        } catch (err) {
          logger.warn(`Failed to backup ${de.name}: ${err.message}`);
        }
      }

      spinner.succeed(`Schemas backed up to ${backupDir}`);
    }

    // Calculate summary
    const summary = {
      targetFolder: targetFolder.path || targetFolder.name,
      totalRecords: desToDelete.reduce((sum, de) => sum + (de.rowCount || 0), 0),
      withPii: desToDelete.filter(de => de.hasPii).length,
      withDependencies: desToDelete.filter(de => de.hasDependencies).length
    };

    // Store pre-execution state
    auditLogger.setPreExecutionState({
      totalFolders: allFolders.length,
      totalDataExtensions: desToDelete.length,
      totalRecords: summary.totalRecords
    });

    // Show preview
    printPreview(desToDelete, summary, backupDir, filtersToDelete, automationsToDelete, queriesToDelete);

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
      desToDelete.length,
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
      successful: 0,
      failed: 0,
      skipped: 0,
      failedItems: [],
      filtersDeleted: 0,
      filtersFailed: 0,
      automationsDeleted: 0,
      automationsFailed: 0,
      queriesDeleted: 0,
      queriesFailed: 0
    };

    // Delete filter activities first (before their DEs)
    if (filtersToDelete.length > 0) {
      console.log(chalk.cyan(`\nDeleting ${filtersToDelete.length} standalone filter activity(s)...`));

      for (const filter of filtersToDelete) {
        console.log(chalk.gray(`  Deleting filter: ${filter.name}...`));

        try {
          const filterResult = await deleteFilterActivity(filter.id, logger);

          if (filterResult.success) {
            console.log(chalk.green(`    ✓ Filter deleted`));
            results.filtersDeleted++;
            auditLogger.addSuccess({
              type: 'FilterActivity',
              id: filter.id,
              name: filter.name
            });
          } else {
            console.log(chalk.yellow(`    ⚠ Filter deletion failed: ${filterResult.error}`));
            results.filtersFailed++;
            // Don't add to failedItems - filter failure shouldn't block DE deletion
            logger.warn(`Filter deletion failed for ${filter.name}: ${filterResult.error}`);
          }
        } catch (error) {
          console.log(chalk.yellow(`    ⚠ Filter deletion error: ${error.message}`));
          results.filtersFailed++;
          logger.warn(`Filter deletion error for ${filter.name}: ${error.message}`);
        }

        await sleep(config.safety.apiRateLimitDelayMs);
      }

      console.log('');
    }

    // Delete stale automations (before their DEs)
    if (automationsToDelete.length > 0) {
      console.log(chalk.cyan(`Deleting ${automationsToDelete.length} stale automation(s)...`));

      for (const auto of automationsToDelete) {
        console.log(chalk.gray(`  Deleting automation: ${auto.name} (${auto.reason})...`));

        try {
          const autoResult = await deleteAutomation(auto.id, logger);

          if (autoResult.success) {
            console.log(chalk.green(`    ✓ Automation deleted`));
            results.automationsDeleted++;
            auditLogger.addSuccess({
              type: 'Automation',
              id: auto.id,
              name: auto.name,
              reason: auto.reason
            });
          } else {
            console.log(chalk.yellow(`    ⚠ Automation deletion failed: ${autoResult.error}`));
            results.automationsFailed++;
            logger.warn(`Automation deletion failed for ${auto.name}: ${autoResult.error}`);
          }
        } catch (error) {
          console.log(chalk.yellow(`    ⚠ Automation deletion error: ${error.message}`));
          results.automationsFailed++;
          logger.warn(`Automation deletion error for ${auto.name}: ${error.message}`);
        }

        await sleep(config.safety.apiRateLimitDelayMs);
      }

      console.log('');
    }

    // Delete query activities (before their DEs)
    if (queriesToDelete.length > 0) {
      console.log(chalk.cyan(`Deleting ${queriesToDelete.length} query activity(s)...`));

      for (const query of queriesToDelete) {
        console.log(chalk.gray(`  Deleting query: ${query.name}...`));

        try {
          const queryResult = await deleteQueryActivity(query.id, logger);

          if (queryResult.success) {
            console.log(chalk.green(`    ✓ Query deleted`));
            results.queriesDeleted++;
            auditLogger.addSuccess({
              type: 'QueryActivity',
              id: query.id,
              name: query.name
            });
          } else {
            const errorMsg = queryResult.results?.[0]?.statusMessage || 'Unknown error';
            console.log(chalk.yellow(`    ⚠ Query deletion failed: ${errorMsg}`));
            results.queriesFailed++;
            logger.warn(`Query deletion failed for ${query.name}: ${errorMsg}`);
            auditLogger.addFailure({
              type: 'QueryActivity',
              id: query.id,
              name: query.name
            }, errorMsg);
          }
        } catch (error) {
          console.log(chalk.yellow(`    ⚠ Query deletion error: ${error.message}`));
          results.queriesFailed++;
          logger.warn(`Query deletion error for ${query.name}: ${error.message}`);
          auditLogger.addFailure({
            type: 'QueryActivity',
            id: query.id,
            name: query.name
          }, error.message);
        }

        await sleep(config.safety.apiRateLimitDelayMs);
      }

      console.log('');
    }

    console.log(chalk.bold('Deleting Data Extensions...'));

    const batchSize = argv.batchSize;
    let batch = 0;

    for (let i = 0; i < desToDelete.length; i++) {
      const de = desToDelete[i];

      // Progress
      console.log(chalk.gray(`[${i + 1}/${desToDelete.length}] Deleting ${de.name}...`));

      try {
        const result = await deleteDataExtension(de.customerKey, logger);

        if (result.success) {
          console.log(chalk.green(`  ✓ Deleted`));
          results.successful++;
          auditLogger.addSuccess({
            customerKey: de.customerKey,
            name: de.name,
            rowCount: de.rowCount
          });
        } else {
          console.log(chalk.red(`  ✗ Failed: ${result.error}`));
          results.failed++;
          results.failedItems.push({ name: de.name, error: result.error });
          auditLogger.addFailure({
            customerKey: de.customerKey,
            name: de.name
          }, result.error);
        }
      } catch (error) {
        console.log(chalk.red(`  ✗ Error: ${error.message}`));
        results.failed++;
        results.failedItems.push({ name: de.name, error: error.message });
        auditLogger.addFailure({
          customerKey: de.customerKey,
          name: de.name
        }, error.message);
      }

      // Rate limiting
      await sleep(config.safety.apiRateLimitDelayMs);

      // Batch progress
      if ((i + 1) % batchSize === 0 && i + 1 < desToDelete.length) {
        batch++;
        console.log(chalk.cyan(`\n--- Batch ${batch} complete (${i + 1}/${desToDelete.length}) ---\n`));

        // Save state after each batch
        stateManager.save({
          targetFolder: targetFolder.path,
          processed: auditLogger.getData().results,
          remaining: desToDelete.slice(i + 1).map(de => de.customerKey)
        });
      }
    }

    // Generate undo script
    let undoPath = null;
    if (results.successful > 0) {
      undoPath = generateUndoScript(desToDelete, config.paths.undo);
    }

    // Determine exit code
    let exitCode = 0;
    if (results.failed > 0) {
      exitCode = 1;
    }

    // Save audit log
    const auditPath = auditLogger.save(exitCode);

    // Print report
    printReport(results, auditPath, backupDir, undoPath);

    // Send webhook if configured
    const webhookUrl = argv.webhookUrl || config.webhook.url;
    if (webhookUrl) {
      await sendWebhook(webhookUrl, {
        operation: 'delete-data-extensions',
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
