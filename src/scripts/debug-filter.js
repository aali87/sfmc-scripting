#!/usr/bin/env node

/**
 * Debug script to inspect filter activity structure and test dependency matching
 * Usage:
 *   node src/scripts/debug-filter.js "Filter Name"
 *   node src/scripts/debug-filter.js --de-objectid "484fc2e1-41dd-e811-a2cc-1402ec851ea5"
 */

import { testConnection } from '../lib/sfmc-auth.js';
import { getFilterActivities, getFilterActivityDetails } from '../lib/sfmc-rest.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('debug-filter');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node src/scripts/debug-filter.js "Filter Name"');
    console.log('  node src/scripts/debug-filter.js --de-objectid "DE-GUID-HERE"');
    console.log('');
    console.log('This will show the full structure of a filter activity');
    console.log('and help debug dependency detection.');
    process.exit(1);
  }

  console.log('Testing SFMC connection...');
  await testConnection();
  console.log('Connected!\n');

  console.log('Fetching all filter activities...');
  const filters = await getFilterActivities(logger);
  console.log(`Found ${filters.length} filter activities\n`);

  // Check if searching by DE ObjectID
  if (args[0] === '--de-objectid' && args[1]) {
    const deObjectId = args[1].toLowerCase();
    console.log(`Searching for filters that reference DE ObjectID: ${deObjectId}\n`);

    const matches = filters.filter(f => {
      const sourceMatch = f.sourceObjectId && f.sourceObjectId.toLowerCase() === deObjectId;
      const destMatch = f.destinationObjectId && f.destinationObjectId.toLowerCase() === deObjectId;
      return sourceMatch || destMatch;
    });

    if (matches.length === 0) {
      console.log('No filters found referencing this DE ObjectID.');
      console.log('\nThis means the DE is NOT used as a source or destination in any filter activity.');
    } else {
      console.log(`Found ${matches.length} filter(s) referencing this DE:\n`);
      for (const filter of matches) {
        const isSource = filter.sourceObjectId?.toLowerCase() === deObjectId;
        const isDest = filter.destinationObjectId?.toLowerCase() === deObjectId;
        console.log(`  - ${filter.name}`);
        console.log(`    ID: ${filter.filterActivityId || filter.id}`);
        console.log(`    Role: ${isSource ? 'SOURCE' : ''} ${isDest ? 'DESTINATION' : ''}`);
        console.log(`    sourceObjectId: ${filter.sourceObjectId}`);
        console.log(`    destinationObjectId: ${filter.destinationObjectId}`);
        console.log('');
      }
    }
    process.exit(0);
  }

  // Search by filter name
  const filterName = args[0];
  const searchLower = filterName.toLowerCase();
  const matches = filters.filter(f =>
    f.name && f.name.toLowerCase().includes(searchLower)
  );

  if (matches.length === 0) {
    console.log(`No filters found matching "${filterName}"`);
    console.log('\nAvailable filters (first 20):');
    filters.slice(0, 20).forEach(f => {
      console.log(`  - ${f.name} (ID: ${f.filterActivityId || f.id})`);
    });
    process.exit(0);
  }

  console.log(`Found ${matches.length} matching filter(s):\n`);

  for (const filter of matches) {
    console.log('='.repeat(80));
    console.log(`FILTER: ${filter.name}`);
    console.log('='.repeat(80));

    console.log('\n--- Filter Structure (from list endpoint) ---');
    console.log(JSON.stringify(filter, null, 2));

    console.log('\n--- Key Fields for Dependency Matching ---');
    console.log(`  filterActivityId: ${filter.filterActivityId || 'NOT FOUND'}`);
    console.log(`  sourceObjectId: ${filter.sourceObjectId || 'NOT FOUND'} (This is the SOURCE DE's ObjectID)`);
    console.log(`  destinationObjectId: ${filter.destinationObjectId || 'NOT FOUND'} (This is the DESTINATION DE's ObjectID)`);
    console.log(`  customerKey: ${filter.customerKey || 'NOT FOUND'}`);

    console.log('\n--- How Dependency Matching Works ---');
    console.log('  To find if a DE is used by this filter:');
    console.log(`  Compare DE.objectId against filter.sourceObjectId: ${filter.sourceObjectId}`);
    console.log(`  Compare DE.objectId against filter.destinationObjectId: ${filter.destinationObjectId}`);

    console.log('\n');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
