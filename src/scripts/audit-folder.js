#!/usr/bin/env node

/**
 * SFMC Folder Audit Script
 *
 * Generates a comprehensive report of a folder's contents, including all
 * Data Extensions, subfolders, record counts, and dependencies.
 *
 * This script is READ-ONLY - it does not modify or delete anything.
 *
 * Usage:
 *   node src/scripts/audit-folder.js --folder "Path/To/Folder" [options]
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import config, { validateConfig, isFolderProtected, isDeProtected } from '../config/index.js';
import { createLogger, createAuditLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { getFolderByPath, getFolderByName, getSubfolders, getFolderTree, findSimilarFolders, clearFolderCache } from '../lib/folder-service.js';
import { getDataExtensionsInFolder, getFullDataExtensionDetails } from '../lib/data-extension-service.js';
import { batchCheckDependencies } from '../lib/dependency-service.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --folder <path> [options]')
  .option('folder', {
    alias: 'f',
    describe: 'Folder path or name to audit',
    type: 'string',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    describe: 'Output format(s)',
    type: 'string',
    choices: ['console', 'json', 'csv', 'all'],
    default: 'all'
  })
  .option('check-dependencies', {
    alias: 'd',
    describe: 'Run dependency checks (slower but thorough)',
    type: 'boolean',
    default: true
  })
  .option('include-row-counts', {
    alias: 'r',
    describe: 'Include record counts per DE (slower)',
    type: 'boolean',
    default: true
  })
  .option('max-depth', {
    describe: 'Maximum subfolder depth to traverse',
    type: 'number',
    default: -1 // Unlimited
  })
  .option('refresh-cache', {
    describe: 'Force refresh folder cache from SFMC API',
    type: 'boolean',
    default: false
  })
  .help()
  .alias('help', 'h')
  .version(config.version)
  .parseSync();

// Initialize logger
const logger = createLogger('audit-folder');

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Print header box
 */
function printHeader(folder) {
  const width = 70;
  const line = '═'.repeat(width);

  console.log('');
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan(`║`) + chalk.bold.white('           SFMC FOLDER AUDIT REPORT'.padEnd(width)) + chalk.cyan(`║`));
  console.log(chalk.cyan(`║`) + `           Generated: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`.padEnd(width) + chalk.cyan(`║`));
  console.log(chalk.cyan(`║`) + `           Business Unit: ${config.sfmc.accountId}`.padEnd(width) + chalk.cyan(`║`));
  console.log(chalk.cyan(`╠${line}╣`));
  console.log(chalk.cyan(`║`) + ` Target Folder: ${folder.path || folder.name}`.padEnd(width) + chalk.cyan(`║`));
  console.log(chalk.cyan(`║`) + ` Folder ID: ${folder.id}`.padEnd(width) + chalk.cyan(`║`));
  console.log(chalk.cyan(`╚${line}╝`));
  console.log('');
}

/**
 * Print folder tree to console
 */
function printFolderTree(tree, dataExtensionMap, depth = 0) {
  const indent = '│   '.repeat(depth);
  const prefix = depth === 0 ? '' : '├── ';

  // Print folder
  const folderIcon = tree.isProtected ? '🔒' : '📁';
  console.log(`${indent}${prefix}${folderIcon} ${chalk.bold(tree.name)} (ID: ${tree.id})`);

  // Print DEs in this folder
  const desInFolder = dataExtensionMap.get(tree.id) || [];
  desInFolder.forEach((de, i) => {
    const isLast = i === desInFolder.length - 1 && tree.children.length === 0;
    const dePrefix = isLast ? '└── ' : '├── ';
    const deIndent = '│   '.repeat(depth + 1);

    let deIcon = '📊';
    let warning = '';

    if (de.isProtected) {
      deIcon = '🔒';
      warning = chalk.red(' [PROTECTED]');
    } else if (de.hasDependencies) {
      warning = chalk.yellow(' ⚠️ HAS DEPENDENCIES');
    }

    const rowInfo = de.rowCount !== null ? `(${formatNumber(de.rowCount)} rows)` : '';
    console.log(`${deIndent}${dePrefix}${deIcon} ${de.name} ${rowInfo}${warning}`);
  });

  // Print subfolders
  tree.children.forEach((child, i) => {
    printFolderTree(child, dataExtensionMap, depth + 1);
  });
}

/**
 * Print summary table
 */
function printSummary(summary) {
  console.log('');
  console.log(chalk.bold('📈 SUMMARY'));
  console.log('┌─────────────────────────────────┬───────────┐');
  console.log(`│ Total Folders                   │ ${String(summary.totalFolders).padStart(9)} │`);
  console.log(`│ Total Data Extensions           │ ${String(summary.totalDataExtensions).padStart(9)} │`);
  console.log(`│ Total Records Across All DEs    │ ${formatNumber(summary.totalRecords).padStart(9)} │`);
  console.log(`│ DEs with Dependencies           │ ${String(summary.dataExtensionsWithDependencies).padStart(9)} │`);
  console.log(`│ DEs with PII Fields             │ ${String(summary.dataExtensionsWithPII).padStart(9)} │`);
  console.log(`│ Protected DEs (would be skipped)│ ${String(summary.protectedItemsFound).padStart(9)} │`);
  console.log('└─────────────────────────────────┴───────────┘');
}

/**
 * Print dependencies table
 */
function printDependencies(dataExtensions) {
  const withDeps = dataExtensions.filter(de => de.hasDependencies);

  if (withDeps.length === 0) {
    return;
  }

  console.log('');
  console.log(chalk.yellow.bold(`⚠️  DATA EXTENSIONS WITH DEPENDENCIES (${withDeps.length})`));
  console.log('┌────────────────────────┬─────────────────────────────────────────────┐');
  console.log('│ Data Extension         │ Dependencies                                │');
  console.log('├────────────────────────┼─────────────────────────────────────────────┤');

  withDeps.forEach(de => {
    const deName = de.name.substring(0, 22).padEnd(22);
    const deps = de.dependencies || [];

    if (deps.length === 0) {
      console.log(`│ ${deName} │ (none listed)                               │`);
    } else {
      deps.forEach((dep, i) => {
        const prefix = i === 0 ? deName : ''.padEnd(22);
        const depStr = `• ${dep.type}: "${dep.name}"`.substring(0, 43).padEnd(43);
        console.log(`│ ${prefix} │ ${depStr} │`);
      });
    }
    console.log('├────────────────────────┼─────────────────────────────────────────────┤');
  });

  console.log('└────────────────────────┴─────────────────────────────────────────────┘');
}

/**
 * Print protected items
 */
function printProtectedItems(dataExtensions, folders) {
  const protectedDes = dataExtensions.filter(de => de.isProtected);
  const protectedFolders = folders.filter(f => f.isProtected);

  console.log('');
  console.log(chalk.bold('🔒 PROTECTED ITEMS DETECTED (would be skipped by delete scripts)'));

  if (protectedDes.length === 0 && protectedFolders.length === 0) {
    console.log(chalk.green('   None detected.'));
  } else {
    if (protectedFolders.length > 0) {
      console.log(chalk.red(`   Folders: ${protectedFolders.map(f => f.name).join(', ')}`));
    }
    if (protectedDes.length > 0) {
      console.log(chalk.red(`   Data Extensions: ${protectedDes.map(de => de.name).join(', ')}`));
    }
  }
}

/**
 * Print full DE list
 */
function printDeList(dataExtensions) {
  console.log('');
  console.log(chalk.bold('📋 FULL DATA EXTENSION LIST'));
  console.log('┌────┬──────────────────────┬───────────┬────────────┬─────────────┬──────────────┐');
  console.log('│ #  │ Name                 │ Rows      │ PII Fields │ Created     │ Dependencies │');
  console.log('├────┼──────────────────────┼───────────┼────────────┼─────────────┼──────────────┤');

  dataExtensions.forEach((de, i) => {
    const num = String(i + 1).padStart(2);
    const name = de.name.substring(0, 20).padEnd(20);
    const rows = formatNumber(de.rowCount).padStart(9);
    const pii = de.hasPii ? `Yes (${de.piiFields?.length || 0})`.padEnd(10) : 'No'.padEnd(10);
    const created = de.createdDate ? dayjs(de.createdDate).format('YYYY-MM-DD') : 'N/A';
    const deps = String(de.dependencyCount || 0).padStart(12);

    console.log(`│ ${num} │ ${name} │ ${rows} │ ${pii} │ ${created} │ ${deps} │`);
  });

  console.log('└────┴──────────────────────┴───────────┴────────────┴─────────────┴──────────────┘');
}

/**
 * Save JSON output
 */
function saveJsonOutput(auditData) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const filename = `audit-${timestamp}.json`;
  const filePath = path.join(config.paths.audit, filename);

  // Ensure directory exists
  if (!fs.existsSync(config.paths.audit)) {
    fs.mkdirSync(config.paths.audit, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(auditData, null, 2));
  return filePath;
}

/**
 * Save CSV output
 */
function saveCsvOutput(dataExtensions, folders) {
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const filename = `audit-${timestamp}.csv`;
  const filePath = path.join(config.paths.audit, filename);

  // Ensure directory exists
  if (!fs.existsSync(config.paths.audit)) {
    fs.mkdirSync(config.paths.audit, { recursive: true });
  }

  // Build CSV
  const headers = [
    'FolderPath', 'DEName', 'CustomerKey', 'RowCount', 'HasPII',
    'PIIFieldCount', 'CreatedDate', 'ModifiedDate', 'DependencyCount', 'DependencyDetails'
  ];

  const rows = dataExtensions.map(de => {
    const folder = folders.find(f => f.id === de.folderId);
    const folderPath = folder?.path || '';
    const depDetails = (de.dependencies || []).map(d => `${d.type}:${d.name}`).join('; ');

    return [
      `"${folderPath}"`,
      `"${de.name}"`,
      `"${de.customerKey}"`,
      de.rowCount || 0,
      de.hasPii ? 'Yes' : 'No',
      de.piiFields?.length || 0,
      de.createdDate || '',
      de.modifiedDate || '',
      de.dependencyCount || 0,
      `"${depDetails}"`
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(filePath, csv);
  return filePath;
}

/**
 * Main audit function
 */
async function runAudit() {
  const startTime = Date.now();

  try {
    // Validate configuration
    validateConfig();

    logger.section('SFMC FOLDER AUDIT');
    logger.info(`Target folder: ${argv.folder}`);
    logger.info(`Options: dependencies=${argv.checkDependencies}, rowCounts=${argv.includeRowCounts}`);

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
    let targetFolder = await getFolderByPath(argv.folder, logger);

    // If not found by path, try by name
    if (!targetFolder) {
      targetFolder = await getFolderByName(argv.folder, logger);
    }

    if (!targetFolder) {
      spinner.fail('Folder not found');

      // Suggest similar folders
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

    // Get subfolders
    spinner.start('Discovering subfolders...');
    const subfolders = await getSubfolders(targetFolder.id, true, logger);
    const allFolders = [targetFolder, ...subfolders];
    spinner.succeed(`Found ${allFolders.length} folder(s)`);

    // Get folder tree for display
    const folderTree = await getFolderTree(targetFolder.id, logger);

    // Get all data extensions
    spinner.start('Discovering Data Extensions...');
    const allDataExtensions = [];
    const deByFolder = new Map();

    for (const folder of allFolders) {
      const des = await getDataExtensionsInFolder(folder.id, logger);
      deByFolder.set(folder.id, des);
      allDataExtensions.push(...des);
    }
    spinner.succeed(`Found ${allDataExtensions.length} Data Extension(s)`);

    // Get detailed info for each DE
    if (argv.includeRowCounts || argv.checkDependencies) {
      spinner.start('Gathering Data Extension details...');

      for (let i = 0; i < allDataExtensions.length; i++) {
        const de = allDataExtensions[i];
        spinner.text = `Gathering details: ${i + 1}/${allDataExtensions.length} - ${de.name}`;

        const details = await getFullDataExtensionDetails(de.customerKey, argv.includeRowCounts, logger);
        if (details) {
          Object.assign(de, details);
        }
      }

      spinner.succeed('Data Extension details gathered');
    }

    // Check dependencies
    if (argv.checkDependencies && allDataExtensions.length > 0) {
      spinner.start('Checking dependencies...');

      const customerKeys = allDataExtensions.map(de => de.customerKey);
      const dependencyResults = await batchCheckDependencies(customerKeys, logger, (current, total, key) => {
        spinner.text = `Checking dependencies: ${current}/${total} - ${key}`;
      });

      // Merge dependency info into DE objects
      for (const de of allDataExtensions) {
        const depInfo = dependencyResults.get(de.customerKey);
        if (depInfo) {
          de.hasDependencies = depInfo.hasDependencies;
          de.dependencyCount = depInfo.totalCount;
          de.dependencies = depInfo.all;
          de.dependencySummary = depInfo.summary;
        }
      }

      spinner.succeed('Dependency check complete');
    }

    // Update DE map with enriched data
    for (const folder of allFolders) {
      const desInFolder = allDataExtensions.filter(de => de.folderId === folder.id);
      deByFolder.set(folder.id, desInFolder);
    }

    // Calculate summary
    const summary = {
      totalFolders: allFolders.length,
      totalDataExtensions: allDataExtensions.length,
      totalRecords: allDataExtensions.reduce((sum, de) => sum + (de.rowCount || 0), 0),
      dataExtensionsWithDependencies: allDataExtensions.filter(de => de.hasDependencies).length,
      dataExtensionsWithPII: allDataExtensions.filter(de => de.hasPii).length,
      protectedItemsFound: allDataExtensions.filter(de => de.isProtected).length +
                          allFolders.filter(f => f.isProtected).length
    };

    // Build audit data for JSON output
    const auditData = {
      reportMetadata: {
        generatedAt: new Date().toISOString(),
        businessUnitId: config.sfmc.accountId,
        targetFolder: targetFolder.path || targetFolder.name,
        targetFolderId: targetFolder.id,
        scriptVersion: config.version,
        options: {
          checkDependencies: argv.checkDependencies,
          includeRowCounts: argv.includeRowCounts,
          maxDepth: argv.maxDepth
        }
      },
      summary,
      folders: allFolders.map(f => ({
        id: f.id,
        name: f.name,
        path: f.path,
        parentFolderId: f.parentFolderId,
        isProtected: f.isProtected,
        createdDate: f.createdDate,
        modifiedDate: f.modifiedDate
      })),
      dataExtensions: allDataExtensions.map(de => ({
        customerKey: de.customerKey,
        name: de.name,
        folderId: de.folderId,
        folderPath: allFolders.find(f => f.id === de.folderId)?.path || '',
        rowCount: de.rowCount,
        createdDate: de.createdDate,
        modifiedDate: de.modifiedDate,
        fields: de.fields,
        piiFields: de.piiFields,
        hasPii: de.hasPii,
        isProtected: de.isProtected,
        dependencies: de.dependencies ? {
          summary: de.dependencySummary,
          all: de.dependencies
        } : null
      }))
    };

    // Console output
    if (argv.output === 'console' || argv.output === 'all') {
      printHeader(targetFolder);

      console.log(chalk.bold('📁 FOLDER STRUCTURE'));
      printFolderTree(folderTree, deByFolder);

      printSummary(summary);
      printDependencies(allDataExtensions);
      printProtectedItems(allDataExtensions, allFolders);
      printDeList(allDataExtensions);
    }

    // JSON output
    let jsonPath = null;
    if (argv.output === 'json' || argv.output === 'all') {
      jsonPath = saveJsonOutput(auditData);
      console.log('');
      console.log(chalk.green(`📄 JSON report saved: ${jsonPath}`));
    }

    // CSV output
    let csvPath = null;
    if (argv.output === 'csv' || argv.output === 'all') {
      csvPath = saveCsvOutput(allDataExtensions, allFolders);
      console.log(chalk.green(`📄 CSV report saved: ${csvPath}`));
    }

    // Final summary
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log('');
    console.log(chalk.green(`✓ Audit complete in ${duration} seconds`));
    console.log(chalk.gray(`  Log file: ${logger.logFilePath}`));

    process.exit(0);

  } catch (error) {
    logger.error(`Audit failed: ${error.message}`);
    logger.debug(error.stack);
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    process.exit(1);
  }
}

// Run the audit
runAudit();
