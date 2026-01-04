#!/usr/bin/env node

/**
 * Smart Dependency Analyzer
 *
 * Analyzes dependencies for Data Extensions in a folder and provides
 * actionable recommendations on which dependencies can be safely deleted.
 *
 * Usage:
 *   node src/scripts/analyze-dependencies.js --folder "Path/To/Folder" [options]
 *
 * Options:
 *   --stale-days <n>   Days without activity to consider stale (default: 365)
 *   --output <file>    Output report to JSON file
 *   --verbose          Show detailed progress
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import config, { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { getFolderByPath, getFolderByName, getSubfolders } from '../lib/folder-service.js';
import { getDataExtensionsInFolder, getFullDataExtensionDetails } from '../lib/data-extension-service.js';
import { analyzeDependencies, formatAnalysisReport } from '../lib/dependency-analyzer.js';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 --folder <path> [options]')
  .option('folder', {
    alias: 'f',
    describe: 'Folder path or name containing DEs to analyze',
    type: 'string',
    demandOption: true
  })
  .option('stale-days', {
    describe: 'Days without activity to consider stale',
    type: 'number',
    default: 365
  })
  .option('output', {
    alias: 'o',
    describe: 'Output report to JSON file',
    type: 'string'
  })
  .option('verbose', {
    alias: 'v',
    describe: 'Show detailed progress',
    type: 'boolean',
    default: false
  })
  .option('limit', {
    describe: 'Limit number of DEs to analyze (for testing)',
    type: 'number'
  })
  .option('refresh-cache', {
    describe: 'Force refresh of cached SFMC data',
    type: 'boolean',
    default: false
  })
  .help()
  .alias('help', 'h')
  .parseSync();

// Initialize logger
const logger = createLogger('analyze-dependencies');

/**
 * Main analysis function
 */
async function runAnalysis() {
  const startTime = Date.now();

  try {
    // Validate configuration
    validateConfig();

    console.log('');
    console.log(chalk.cyan.bold('━'.repeat(70)));
    console.log(chalk.cyan.bold('  SMART DEPENDENCY ANALYZER'));
    console.log(chalk.cyan.bold('━'.repeat(70)));
    console.log('');
    console.log(chalk.gray(`  Target folder: ${argv.folder}`));
    console.log(chalk.gray(`  Stale threshold: ${argv.staleDays} days`));
    console.log('');

    // Test connection
    const spinner = ora('Connecting to SFMC...').start();
    const connectionResult = await testConnection(logger);

    if (!connectionResult.success) {
      spinner.fail('Connection failed');
      console.error(chalk.red(connectionResult.error));
      process.exit(1);
    }

    spinner.succeed('Connected to SFMC');

    // Find target folder
    spinner.start('Finding target folder...');
    let targetFolder = await getFolderByPath(argv.folder, logger);

    if (!targetFolder) {
      targetFolder = await getFolderByName(argv.folder, logger);
    }

    if (!targetFolder) {
      spinner.fail('Folder not found');
      process.exit(1);
    }

    spinner.succeed(`Found folder: ${targetFolder.name}`);

    // Get subfolders
    spinner.start('Discovering subfolders...');
    const subfolders = await getSubfolders(targetFolder.id, true, logger);
    const allFolders = [targetFolder, ...subfolders];
    spinner.succeed(`Found ${allFolders.length} folder(s)`);

    // Get all data extensions
    spinner.start('Discovering Data Extensions...');
    let allDataExtensions = [];

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

    // Apply limit if specified (for testing)
    if (argv.limit && argv.limit < allDataExtensions.length) {
      console.log(chalk.yellow(`\nLimiting analysis to first ${argv.limit} DEs (--limit flag)`));
      allDataExtensions = allDataExtensions.slice(0, argv.limit);
    }

    // Get full details for each DE (need objectId for accurate filter matching)
    spinner.start('Gathering Data Extension details...');
    for (let i = 0; i < allDataExtensions.length; i++) {
      const de = allDataExtensions[i];
      spinner.text = `Gathering details: ${i + 1}/${allDataExtensions.length}`;

      const details = await getFullDataExtensionDetails(de.customerKey, false, logger);
      if (details) {
        Object.assign(de, details);
      }
    }
    spinner.succeed('Data Extension details gathered');

    // Run the smart dependency analysis
    console.log('');
    console.log(chalk.cyan.bold('  Running Smart Dependency Analysis...'));
    if (argv.refreshCache) {
      console.log(chalk.yellow('  (--refresh-cache: Forcing fresh data load from SFMC)'));
    } else {
      console.log(chalk.gray('  (Using cached data if available, or loading from SFMC)'));
    }
    console.log('');

    let currentStage = '';
    let stageSpinner = null;

    const stageLabels = {
      loading: 'Bulk loading SFMC metadata',
      cached: 'Using cached SFMC data',
      scanning: 'Scanning DEs for dependencies (in-memory)',
      classifying: 'Classifying dependencies'
    };

    const report = await analyzeDependencies(allDataExtensions, {
      staleDays: argv.staleDays,
      logger: argv.verbose ? logger : null,
      forceRefresh: argv.refreshCache,
      onProgress: (stage, current, total, message) => {
        // Handle sub-stages from bulk loader
        const mainStage = stage.split('-')[0];

        if (mainStage !== currentStage) {
          if (stageSpinner) stageSpinner.succeed();
          currentStage = mainStage;

          stageSpinner = ora(stageLabels[mainStage] || stage).start();
        }

        if (stageSpinner) {
          // Show more detail for loading stage
          if (stage.startsWith('loading-')) {
            const subStage = stage.replace('loading-', '');
            stageSpinner.text = `Bulk loading: ${subStage} (${current}/${total})`;
          } else if (stage === 'cached') {
            stageSpinner.text = `Using cached SFMC data (${message})`;
          } else {
            stageSpinner.text = `${stageLabels[mainStage] || stage}: ${current}/${total}`;
          }
        }
      }
    });

    if (stageSpinner) stageSpinner.succeed();

    // Show data load summary
    if (report.dataLoadSummary) {
      const dls = report.dataLoadSummary;
      console.log(chalk.gray(`  Loaded: ${dls.automations} automations, ${dls.filterActivities} filters, ` +
        `${dls.queryActivities} queries, ${dls.importActivities} imports, ${dls.journeys} journeys`));
    }

    // Display the formatted report
    console.log(formatAnalysisReport(report));

    // Show affected DEs for each safe-to-delete dependency
    if (report.safeToDelete.length > 0) {
      console.log('');
      console.log(chalk.cyan.bold('━'.repeat(70)));
      console.log(chalk.cyan.bold('  AFFECTED DATA EXTENSIONS'));
      console.log(chalk.cyan.bold('━'.repeat(70)));
      console.log('');

      for (const dep of report.safeToDelete.slice(0, 10)) {
        console.log(chalk.green(`  ${dep.type}: ${dep.name}`));
        console.log(chalk.gray(`  └ Affects ${dep.affectedDes.length} DE(s):`));
        for (const de of dep.affectedDes.slice(0, 5)) {
          console.log(chalk.gray(`      • ${de.name || de.customerKey}`));
        }
        if (dep.affectedDes.length > 5) {
          console.log(chalk.gray(`      ... and ${dep.affectedDes.length - 5} more`));
        }
        console.log('');
      }

      if (report.safeToDelete.length > 10) {
        console.log(chalk.gray(`  ... and ${report.safeToDelete.length - 10} more safe-to-delete dependencies`));
      }
    }

    // Output to JSON file if requested
    if (argv.output) {
      const outputPath = path.resolve(process.cwd(), argv.output);

      // Convert Maps to objects for JSON serialization
      const jsonReport = {
        ...report,
        deMapping: Object.fromEntries(report.deMapping),
        generatedAt: new Date().toISOString(),
        options: {
          folder: argv.folder,
          staleDays: argv.staleDays
        }
      };

      fs.writeFileSync(outputPath, JSON.stringify(jsonReport, null, 2));
      console.log('');
      console.log(chalk.green(`✓ Report saved to: ${outputPath}`));
    }

    // Summary
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log('');
    console.log(chalk.cyan.bold('━'.repeat(70)));
    console.log(chalk.green(`  ✓ Analysis complete in ${duration} seconds`));
    console.log(chalk.cyan.bold('━'.repeat(70)));
    console.log('');

    if (report.summary.safeToDelete > 0) {
      console.log(chalk.green(`  ${report.summary.safeToDelete} dependencies can be safely deleted.`));
      console.log(chalk.gray(`  Run with --output report.json to get the full list.`));
    }

    if (report.summary.requiresReview > 0) {
      console.log(chalk.yellow(`  ${report.summary.requiresReview} dependencies require manual review.`));
    }

    console.log('');

  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    if (argv.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the analysis
runAnalysis();
