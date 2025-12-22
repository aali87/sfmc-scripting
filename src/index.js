#!/usr/bin/env node

/**
 * SFMC DE Toolkit - CLI Entry Point
 *
 * A comprehensive toolkit for auditing, analyzing dependencies,
 * and safely deleting Data Extensions and folders in Salesforce Marketing Cloud.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import config from './config/index.js';
import { testConnection } from './lib/sfmc-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Print banner
 */
function printBanner() {
  console.log('');
  console.log(chalk.cyan('╔═══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.bold.white('         SFMC Data Extension Toolkit v' + config.version) + chalk.cyan('                  ║'));
  console.log(chalk.cyan('║') + chalk.gray('         Audit, Analyze & Safely Delete DEs') + chalk.cyan('                 ║'));
  console.log(chalk.cyan('╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');
}

/**
 * Run a script as a child process
 */
function runScript(scriptName, args) {
  const scriptPath = path.join(__dirname, 'scripts', `${scriptName}.js`);

  const child = spawn('node', [scriptPath, ...args], {
    stdio: 'inherit',
    shell: true
  });

  child.on('close', (code) => {
    process.exit(code);
  });
}

// Build CLI
const cli = yargs(hideBin(process.argv))
  .scriptName('sfmc-de-toolkit')
  .usage('Usage: $0 <command> [options]')

  // Audit command
  .command(
    'audit',
    'Audit a folder and its contents (read-only)',
    (yargs) => {
      return yargs
        .option('folder', {
          alias: 'f',
          describe: 'Folder path or name to audit',
          type: 'string',
          demandOption: true
        })
        .option('output', {
          alias: 'o',
          describe: 'Output format',
          type: 'string',
          choices: ['console', 'json', 'csv', 'all'],
          default: 'all'
        })
        .option('check-dependencies', {
          alias: 'd',
          describe: 'Run dependency checks',
          type: 'boolean',
          default: true
        })
        .option('include-row-counts', {
          alias: 'r',
          describe: 'Include record counts',
          type: 'boolean',
          default: true
        })
        .example('$0 audit -f "Archive/Old Campaigns"', 'Audit the specified folder')
        .example('$0 audit -f "Archive" -o json', 'Audit and output JSON only');
    },
    (argv) => {
      const args = ['--folder', argv.folder];
      if (argv.output) args.push('--output', argv.output);
      if (!argv.checkDependencies) args.push('--check-dependencies', 'false');
      if (!argv.includeRowCounts) args.push('--include-row-counts', 'false');
      runScript('audit-folder', args);
    }
  )

  // Delete DEs command
  .command(
    'delete-des',
    'Delete Data Extensions in a folder',
    (yargs) => {
      return yargs
        .option('folder', {
          alias: 'f',
          describe: 'Folder containing DEs to delete',
          type: 'string',
          demandOption: true
        })
        .option('confirm', {
          describe: 'Enable actual deletion (default is dry-run)',
          type: 'boolean',
          default: false
        })
        .option('interactive', {
          alias: 'i',
          describe: 'Interactively select DEs to delete',
          type: 'boolean',
          default: false
        })
        .option('skip-dependency-check', {
          describe: 'Skip dependency validation',
          type: 'boolean',
          default: false
        })
        .option('skip-protected', {
          describe: 'Skip protected DEs instead of aborting',
          type: 'boolean',
          default: false
        })
        .option('older-than-days', {
          describe: 'Only delete DEs not modified in X days',
          type: 'number'
        })
        .option('batch-size', {
          describe: 'Batch size for deletions',
          type: 'number',
          default: 10
        })
        .example('$0 delete-des -f "Archive"', 'Dry run - preview what would be deleted')
        .example('$0 delete-des -f "Archive" --confirm', 'Actually delete DEs')
        .example('$0 delete-des -f "Archive" -i', 'Interactive selection mode');
    },
    (argv) => {
      const args = ['--folder', argv.folder];
      if (argv.confirm) args.push('--confirm');
      if (argv.interactive) args.push('--interactive');
      if (argv.skipDependencyCheck) args.push('--skip-dependency-check');
      if (argv.skipProtected) args.push('--skip-protected');
      if (argv.olderThanDays) args.push('--older-than-days', argv.olderThanDays);
      if (argv.batchSize) args.push('--batch-size', argv.batchSize);
      runScript('delete-data-extensions', args);
    }
  )

  // Delete folders command
  .command(
    'delete-folders',
    'Delete a folder and its subfolders',
    (yargs) => {
      return yargs
        .option('folder', {
          alias: 'f',
          describe: 'Folder to delete',
          type: 'string',
          demandOption: true
        })
        .option('confirm', {
          describe: 'Enable actual deletion (default is dry-run)',
          type: 'boolean',
          default: false
        })
        .option('force', {
          describe: 'Delete contents before deleting folders',
          type: 'boolean',
          default: false
        })
        .option('skip-protected', {
          describe: 'Skip protected folders instead of aborting',
          type: 'boolean',
          default: false
        })
        .example('$0 delete-folders -f "Archive"', 'Dry run - preview folder deletion')
        .example('$0 delete-folders -f "Archive" --confirm', 'Actually delete folders')
        .example('$0 delete-folders -f "Archive" --force --confirm', 'Delete folders and contents');
    },
    (argv) => {
      const args = ['--folder', argv.folder];
      if (argv.confirm) args.push('--confirm');
      if (argv.force) args.push('--force');
      if (argv.skipProtected) args.push('--skip-protected');
      runScript('delete-folders', args);
    }
  )

  // Test connection command
  .command(
    'test',
    'Test SFMC connection',
    () => {},
    async () => {
      printBanner();
      console.log('Testing SFMC connection...\n');

      try {
        const result = await testConnection();

        if (result.success) {
          console.log(chalk.green('✓ Connection successful!\n'));
          console.log(`  Account ID: ${result.accountId}`);
          console.log(`  REST URL: ${result.restUrl}`);
          console.log(`  SOAP URL: ${result.soapUrl}`);

          if (result.tokenExpiry) {
            console.log(`  Token expires in: ${result.tokenExpiry.remainingSeconds} seconds`);
          }
        } else {
          console.log(chalk.red('✗ Connection failed!\n'));
          console.log(`  Error: ${result.error}`);
          process.exit(1);
        }
      } catch (error) {
        console.log(chalk.red('✗ Connection failed!\n'));
        console.log(`  Error: ${error.message}`);
        process.exit(1);
      }
    }
  )

  // Version command
  .command(
    'version',
    'Show version information',
    () => {},
    () => {
      console.log(`SFMC DE Toolkit v${config.version}`);
    }
  )

  .demandCommand(1, 'Please specify a command')
  .recommendCommands()
  .strict()
  .help()
  .alias('help', 'h')
  .version(false) // Disable default version, we have a custom command
  .epilogue('For more information, see the README.md file.')
  .wrap(100);

// Show banner for help
if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length === 2) {
  printBanner();
}

// Parse and execute
cli.parse();
