#!/usr/bin/env node

/**
 * Audit CloudPages Script
 *
 * Retrieves all CloudPages in a Business Unit, checks their published status,
 * extracts the published URL, and detects if "DAX" is referenced in the HTML.
 *
 * Usage:
 *   node src/scripts/audit-cloudpages.js --bu 123456
 *   node src/scripts/audit-cloudpages.js --bu 123456 -o report.csv
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';

import config, { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { testConnection } from '../lib/sfmc-auth.js';
import { getCloudPages, getCloudPageDetails } from '../lib/sfmc-rest.js';

// Default patterns to search for DAX references
const DEFAULT_SEARCH_PATTERNS = [
  // DAX in font-family declarations, class names, or other references
  'DAX'
];

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('business-unit', {
    alias: 'bu',
    describe: 'Business Unit MID',
    type: 'string',
    demandOption: true
  })
  .option('search', {
    alias: 's',
    describe: 'Comma-separated patterns to search for in HTML content',
    type: 'string'
  })
  .option('output', {
    alias: 'o',
    describe: 'Output CSV file path',
    type: 'string'
  })
  .option('include-content', {
    describe: 'Include full HTML content in output (warning: large files)',
    type: 'boolean',
    default: false
  })
  .option('published-only', {
    describe: 'Only show published CloudPages',
    type: 'boolean',
    default: false
  })
  .option('with-matches-only', {
    describe: 'Only show CloudPages with pattern matches',
    type: 'boolean',
    default: false
  })
  .option('verbose', {
    alias: 'v',
    describe: 'Verbose output',
    type: 'boolean',
    default: false
  })
  .option('limit', {
    describe: 'Limit number of CloudPages to process (for testing)',
    type: 'number'
  })
  .example('$0 --bu 123456', 'Audit all CloudPages in BU')
  .example('$0 --bu 123456 -o report.csv', 'Export to CSV')
  .example('$0 --bu 123456 --with-matches-only', 'Only show pages with DAX')
  .help()
  .parseSync();

// Initialize logger
const logger = createLogger('audit-cloudpages');

/**
 * Extract the published URL from a CloudPage asset
 * The URL is stored in the content field as stringified JSON for republished pages
 */
function extractPublishedUrl(asset) {
  if (!asset.content || typeof asset.content !== 'string') {
    return null;
  }

  try {
    // Content field contains stringified JSON like: {"url":"https://..."}
    const contentObj = JSON.parse(asset.content);
    if (contentObj && contentObj.url) {
      return contentObj.url;
    }
  } catch {
    // Content is not JSON, might be HTML or other format
  }

  return null;
}

/**
 * Extract HTML content from a CloudPage asset
 */
function extractHtmlContent(asset) {
  // Try views.html.content first (most common)
  if (asset.views?.html?.content) {
    return asset.views.html.content;
  }

  // Try direct content property
  if (asset.content && typeof asset.content === 'string') {
    return asset.content;
  }

  // Try slots (for block-based pages)
  if (asset.views?.html?.slots) {
    const slots = asset.views.html.slots;
    const htmlParts = [];
    for (const slotKey of Object.keys(slots)) {
      if (slots[slotKey]?.content) {
        htmlParts.push(slots[slotKey].content);
      }
    }
    if (htmlParts.length > 0) {
      return htmlParts.join('\n');
    }
  }

  return null;
}

/**
 * Check if a CloudPage is published
 * Note: SFMC API doesn't have a direct published/unpublished status field.
 * We determine published state by checking for publishDate or URL in content.
 */
function isPublished(asset) {
  // Method 1: Check meta.cloudPages.publishDate (most reliable)
  // Only published pages have a publishDate value
  if (asset.meta?.cloudPages?.publishDate) {
    return true;
  }

  // Method 2: Check status.name for "Published"
  if (asset.status && typeof asset.status === 'object') {
    if (asset.status.name === 'Published') {
      return true;
    }
  }

  // Method 3: Check if content contains a URL (indicates republished page)
  // The content field contains stringified JSON with URL when published
  if (asset.content && typeof asset.content === 'string') {
    try {
      // Content might be JSON with a url property
      if (asset.content.includes('"url"') || asset.content.includes('cloudpagesurl')) {
        return true;
      }
    } catch {
      // Not JSON, continue checking
    }
  }

  // Method 4: Check data.email.legacy.legacyData (older published pages)
  if (asset.data?.email?.legacy?.legacyData?.legacyId) {
    return true;
  }

  // Default: If status.name is "Draft", it's definitely not published
  if (asset.status?.name === 'Draft') {
    return false;
  }

  // If views.html.content exists and is substantial, likely published
  if (asset.views?.html?.content && asset.views.html.content.length > 100) {
    return true;
  }

  return false;
}

/**
 * Search content for patterns and return matches
 */
function searchPatterns(content, patterns) {
  if (!content) return [];

  const matches = [];

  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'gi');
      const found = content.match(regex);
      if (found) {
        matches.push({
          pattern: pattern,
          count: found.length,
          samples: found.slice(0, 3) // First 3 matches as samples
        });
      }
    } catch (e) {
      // Invalid regex, try as literal string
      if (content.toLowerCase().includes(pattern.toLowerCase())) {
        const count = (content.toLowerCase().match(new RegExp(escapeRegex(pattern), 'gi')) || []).length;
        matches.push({
          pattern: pattern,
          count: count,
          samples: [pattern]
        });
      }
    }
  }

  return matches;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    return new Date(dateString).toISOString().split('T')[0];
  } catch {
    return dateString;
  }
}

/**
 * Escape CSV field
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate CSV content
 */
function generateCSV(results, includeContent) {
  const headers = [
    'ID',
    'Name',
    'CustomerKey',
    'AssetType',
    'Published',
    'URL',
    'CreatedDate',
    'ModifiedDate',
    'Category',
    'HasDAX',
    'ContentLength'
  ];

  if (includeContent) {
    headers.push('HTMLContent');
  }

  const rows = [headers.join(',')];

  for (const result of results) {
    const row = [
      escapeCSV(result.id),
      escapeCSV(result.name),
      escapeCSV(result.customerKey),
      escapeCSV(result.assetType),
      escapeCSV(result.isPublished ? 'Yes' : 'No'),
      escapeCSV(result.url || ''),
      escapeCSV(result.createdDate),
      escapeCSV(result.modifiedDate),
      escapeCSV(result.category),
      escapeCSV(result.hasMatches ? 'Yes' : 'No'),
      escapeCSV(result.contentLength)
    ];

    if (includeContent) {
      row.push(escapeCSV(result.htmlContent || ''));
    }

    rows.push(row.join(','));
  }

  return rows.join('\n');
}

/**
 * Print summary to console
 */
function printSummary(results) {
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  Summary'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  const total = results.length;
  const published = results.filter(r => r.isPublished).length;
  const unpublished = total - published;
  const withMatches = results.filter(r => r.hasMatches).length;

  const withUrl = results.filter(r => r.url).length;

  console.log(`  Total CloudPages:     ${chalk.white(total)}`);
  console.log(`  Published:            ${chalk.green(published)}`);
  console.log(`  Unpublished:          ${chalk.yellow(unpublished)}`);
  console.log(`  With URL:             ${chalk.blue(withUrl)}`);
  console.log(`  With DAX:             ${chalk.red(withMatches)}`);
  console.log('');
}

/**
 * Print detailed results to console
 */
function printDetailedResults(results, verbose) {
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  CloudPages'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  for (const result of results) {
    const statusIcon = result.isPublished ? chalk.green('●') : chalk.yellow('○');
    const matchIcon = result.hasMatches ? chalk.red(' [DAX]') : '';

    console.log(`${statusIcon} ${chalk.white(result.name)}${matchIcon}`);
    console.log(`  ID: ${chalk.gray(result.id)} | Key: ${chalk.gray(result.customerKey || 'N/A')}`);
    console.log(`  Type: ${result.assetType} | Modified: ${result.modifiedDate}`);

    if (result.url) {
      console.log(`  URL: ${chalk.blue(result.url)}`);
    }

    if (result.category) {
      console.log(`  Category: ${chalk.gray(result.category)}`);
    }

    // In verbose mode, show raw status info for debugging
    if (verbose && result.rawStatus) {
      console.log(`  ${chalk.gray('Status Info:')} ${result.rawStatus}`);
    }

    console.log('');
  }
}

/**
 * Main function
 */
async function main() {
  console.log('');
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('  CloudPages Audit'));
  console.log(chalk.cyan('═══════════════════════════════════════════════════════════════'));
  console.log('');

  // Validate config
  try {
    validateConfig();
  } catch (configError) {
    console.error(chalk.red(`Configuration error: ${configError.message}`));
    process.exit(1);
  }

  // Parse search patterns
  let searchPatternsList = DEFAULT_SEARCH_PATTERNS;
  if (argv.search) {
    // Add user patterns to defaults
    const userPatterns = argv.search.split(',').map(p => p.trim()).filter(Boolean);
    searchPatternsList = [...new Set([...userPatterns, ...DEFAULT_SEARCH_PATTERNS])];
  }

  console.log(chalk.gray(`Searching for ${searchPatternsList.length} patterns`));
  console.log('');

  // Test connection
  const spinner = ora('Connecting to SFMC...').start();
  const conn = await testConnection(logger);
  if (!conn.success) {
    spinner.fail('Connection failed');
    console.error(chalk.red(`Error: ${conn.error}`));
    process.exit(1);
  }
  spinner.succeed('Connected to SFMC');

  // Get CloudPages
  spinner.start('Retrieving CloudPages...');
  let cloudPages = await getCloudPages(logger, argv.businessUnit);

  if (cloudPages.length === 0) {
    spinner.warn('No CloudPages found in this Business Unit');
    return;
  }

  spinner.succeed(`Found ${cloudPages.length} CloudPages`);

  // Apply limit if specified
  if (argv.limit && argv.limit > 0) {
    cloudPages = cloudPages.slice(0, argv.limit);
    console.log(chalk.gray(`  (Limited to ${argv.limit} pages for testing)`));
  }

  // Process each CloudPage
  spinner.start('Analyzing CloudPages...');
  const results = [];
  let processed = 0;

  for (const page of cloudPages) {
    processed++;
    spinner.text = `Analyzing CloudPages... (${processed}/${cloudPages.length})`;

    // Get detailed content if not already available
    let htmlContent = extractHtmlContent(page);
    if (!htmlContent && page.id) {
      const details = await getCloudPageDetails(page.id, logger, argv.businessUnit);
      if (details) {
        htmlContent = extractHtmlContent(details);
      }
    }

    // Check published status
    const published = isPublished(page);

    // Skip unpublished if filter is set
    if (argv.publishedOnly && !published) {
      continue;
    }

    // Search for patterns
    const matches = searchPatterns(htmlContent, searchPatternsList);
    const hasMatches = matches.length > 0;

    // Skip if no matches and filter is set
    if (argv.withMatchesOnly && !hasMatches) {
      continue;
    }

    // Build raw status info for debugging
    const rawStatusParts = [];
    if (page.status) {
      rawStatusParts.push(`status.name=${page.status?.name || page.status}`);
    }
    if (page.meta?.cloudPages?.publishDate) {
      rawStatusParts.push(`publishDate=${page.meta.cloudPages.publishDate}`);
    }
    if (page.content && typeof page.content === 'string' && page.content.includes('"url"')) {
      rawStatusParts.push(`contentHasUrl=yes`);
    }

    // Extract published URL
    const url = extractPublishedUrl(page);

    // Build result object
    const result = {
      id: page.id,
      name: page.name || 'Unnamed',
      customerKey: page.customerKey,
      assetType: page.assetType?.name || page.assetType?.id || 'Unknown',
      isPublished: published,
      url: url,
      createdDate: formatDate(page.createdDate),
      modifiedDate: formatDate(page.modifiedDate),
      category: page.category?.name || '',
      hasMatches: hasMatches,
      contentLength: htmlContent?.length || 0,
      htmlContent: argv.includeContent ? htmlContent : null,
      rawStatus: rawStatusParts.join(', ') || 'no status fields found'
    };

    results.push(result);
  }

  spinner.succeed(`Analyzed ${processed} CloudPages`);

  // Print results
  printDetailedResults(results, argv.verbose);
  printSummary(results);

  // Export to CSV if requested
  if (argv.output) {
    spinner.start(`Exporting to ${argv.output}...`);

    const csvContent = generateCSV(results, argv.includeContent);
    const outputPath = path.resolve(argv.output);

    // Ensure directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, csvContent, 'utf8');
    spinner.succeed(`Exported ${results.length} CloudPages to ${outputPath}`);
  }

  console.log(chalk.green('\nAudit complete.'));
}

// Run
main().catch(err => {
  console.error(chalk.red(`\nError: ${err.message}`));
  if (logger) {
    logger.error(`Script failed: ${err.message}`, { stack: err.stack });
  }
  process.exit(1);
});
