#!/usr/bin/env node

/**
 * Debug script to trace dependency detection for a specific DE
 * Usage: node src/scripts/debug-dependency.js "DE CustomerKey or Name"
 */

import { testConnection } from '../lib/sfmc-auth.js';
import { getDataExtensionDetails } from '../lib/data-extension-service.js';
import { getFilterActivities } from '../lib/sfmc-rest.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('debug-dependency');

async function main() {
  const searchTerm = process.argv[2];

  if (!searchTerm) {
    console.log('Usage: node src/scripts/debug-dependency.js "DE CustomerKey or Name"');
    console.log('Example: node src/scripts/debug-dependency.js "US35309 - EDB Inactivity Stim - Deployment - FR"');
    process.exit(1);
  }

  console.log(`\n🔍 Debugging dependency detection for: "${searchTerm}"\n`);

  // Connect
  const conn = await testConnection(logger);
  if (!conn.success) {
    console.error('Failed to connect:', conn.error);
    process.exit(1);
  }
  console.log('✓ Connected to SFMC\n');

  // Get DE details
  console.log('--- Step 1: Get DE Details ---');
  const de = await getDataExtensionDetails(searchTerm, logger);

  if (!de) {
    console.log(`❌ Data Extension not found: "${searchTerm}"`);
    console.log('Make sure to use the exact CustomerKey');
    process.exit(1);
  }

  console.log('DE found:');
  console.log(`  Name: ${de.name}`);
  console.log(`  CustomerKey: ${de.customerKey}`);
  console.log(`  ObjectID: ${de.objectId}`);
  console.log(`  FolderID: ${de.folderId}`);
  console.log('');

  // Get all filter activities
  console.log('--- Step 2: Load Filter Activities ---');
  const filters = await getFilterActivities(logger);
  console.log(`Loaded ${filters.length} filter activities\n`);

  // Check what the old (buggy) code would match
  console.log('--- Step 3: Check OLD matching logic (substring on JSON) ---');
  const keyLower = de.customerKey.toLowerCase();
  const oldMatches = filters.filter(f => {
    const jsonStr = JSON.stringify(f).toLowerCase();
    return jsonStr.includes(keyLower);
  });

  console.log(`Old logic found ${oldMatches.length} matches:`);
  oldMatches.forEach((f, i) => {
    console.log(`\n  Match ${i + 1}: ${f.name}`);
    console.log(`    filterActivityId: ${f.filterActivityId}`);
    console.log(`    sourceObjectId: ${f.sourceObjectId}`);
    console.log(`    destinationObjectId: ${f.destinationObjectId}`);
    console.log(`    customerKey: ${f.customerKey}`);

    // Show where in the JSON it matched
    const jsonStr = JSON.stringify(f);
    const matchIndex = jsonStr.toLowerCase().indexOf(keyLower);
    if (matchIndex >= 0) {
      const context = jsonStr.substring(Math.max(0, matchIndex - 30), matchIndex + keyLower.length + 30);
      console.log(`    Match context: ...${context}...`);
    }
  });
  console.log('');

  // Check what the NEW (fixed) code matches
  console.log('--- Step 4: Check NEW matching logic (ObjectID comparison) ---');
  const objectIdLower = de.objectId ? de.objectId.toLowerCase() : null;

  console.log(`DE ObjectID to match: ${objectIdLower}`);
  console.log('');

  const newMatches = filters.filter(f => {
    // Primary check: sourceObjectId
    if (objectIdLower && f.sourceObjectId) {
      if (f.sourceObjectId.toLowerCase() === objectIdLower) {
        return true;
      }
    }
    // Also check destinationObjectId
    if (objectIdLower && f.destinationObjectId) {
      if (f.destinationObjectId.toLowerCase() === objectIdLower) {
        return true;
      }
    }
    return false;
  });

  console.log(`New logic found ${newMatches.length} matches:`);
  newMatches.forEach((f, i) => {
    const isSource = f.sourceObjectId?.toLowerCase() === objectIdLower;
    const isDest = f.destinationObjectId?.toLowerCase() === objectIdLower;
    console.log(`\n  Match ${i + 1}: ${f.name}`);
    console.log(`    filterActivityId: ${f.filterActivityId}`);
    console.log(`    sourceObjectId: ${f.sourceObjectId} ${isSource ? '← MATCH (Source DE)' : ''}`);
    console.log(`    destinationObjectId: ${f.destinationObjectId} ${isDest ? '← MATCH (Destination DE)' : ''}`);
  });
  console.log('');

  // Analyze the difference
  console.log('--- Step 5: Analysis ---');
  const falsePositives = oldMatches.filter(m => !newMatches.includes(m));

  if (falsePositives.length > 0) {
    console.log(`⚠️  ${falsePositives.length} FALSE POSITIVE(s) in old logic:`);
    falsePositives.forEach((f, i) => {
      console.log(`\n  False Positive ${i + 1}: ${f.name}`);
      console.log(`    This filter was matching because the DE name appears in the filter JSON`);
      console.log(`    but the filter is NOT actually using this DE as source/destination.`);
      console.log(`    Filter's source DE ObjectID: ${f.sourceObjectId}`);
      console.log(`    Filter's dest DE ObjectID: ${f.destinationObjectId}`);
      console.log(`    Our DE's ObjectID: ${de.objectId}`);
      console.log(`    These don't match, so it's a false positive!`);
    });
  } else if (oldMatches.length === newMatches.length) {
    console.log('✓ Old and new logic found the same matches');
  }

  if (newMatches.length === 0) {
    console.log('✓ NEW logic correctly finds NO filter dependencies for this DE');
  }

  console.log('\n--- Done ---\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
