#!/usr/bin/env node

/**
 * Debug script to test all dependency detection for a specific DE
 * Usage: node src/scripts/debug-de-dependencies.js "DE CustomerKey"
 */

import { testConnection } from '../lib/sfmc-auth.js';
import { getDataExtensionDetails } from '../lib/data-extension-service.js';
import { loadAllSfmcData } from '../lib/bulk-data-loader.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('debug-de-deps');

async function main() {
  const searchTerm = process.argv[2];

  if (!searchTerm) {
    console.log('Usage: node src/scripts/debug-de-dependencies.js "DE CustomerKey"');
    console.log('');
    console.log('This script tests all dependency detection types for a specific DE.');
    process.exit(1);
  }

  console.log(`\n🔍 Testing dependency detection for DE: "${searchTerm}"\n`);

  // Connect
  const conn = await testConnection(logger);
  if (!conn.success) {
    console.error('Failed to connect:', conn.error);
    process.exit(1);
  }
  console.log('✓ Connected to SFMC\n');

  // Get DE details - try by CustomerKey first, then by Name
  console.log('--- Step 1: Get DE Details ---');
  let de = await getDataExtensionDetails(searchTerm, logger);

  if (!de) {
    // Try searching by Name instead
    console.log(`  Not found by CustomerKey, trying by Name...`);
    const { retrieveDataExtensions, buildSimpleFilter } = await import('../lib/sfmc-soap.js');
    const filter = buildSimpleFilter('Name', 'equals', searchTerm);
    const results = await retrieveDataExtensions(filter, logger);

    if (results.length > 0) {
      // Normalize the result
      de = {
        objectId: results[0].ObjectID,
        customerKey: results[0].CustomerKey,
        name: results[0].Name,
        folderId: results[0].CategoryID
      };
    }
  }

  if (!de) {
    console.log(`❌ Data Extension not found by CustomerKey or Name: "${searchTerm}"`);
    console.log(`   Try using the exact CustomerKey from SFMC.`);
    process.exit(1);
  }

  console.log(`  Name: ${de.name}`);
  console.log(`  CustomerKey: ${de.customerKey}`);
  console.log(`  ObjectID: ${de.objectId}`);
  console.log(`  FolderID: ${de.folderId}`);
  console.log('');

  const keyLower = de.customerKey.toLowerCase();
  const nameLower = de.name ? de.name.toLowerCase() : null;
  const objectIdLower = de.objectId ? de.objectId.toLowerCase() : null;

  // Load bulk data
  console.log('--- Step 2: Loading SFMC Data ---');
  const bulkData = await loadAllSfmcData({ logger });

  console.log(`  Automations: ${bulkData.automations.length}`);
  console.log(`  Filter Activities: ${bulkData.filterActivities.length}`);
  console.log(`  Query Activities: ${bulkData.queryActivities.length}`);
  const queriesWithSql = bulkData.queryActivities.filter(q => q.QueryText).length;
  console.log(`    (${queriesWithSql} have SQL text loaded)`);
  console.log(`  Import Activities: ${bulkData.importActivities.length}`);
  console.log(`  Triggered Sends: ${bulkData.triggeredSends.length}`);
  console.log(`  Journeys: ${bulkData.journeys.length}`);
  console.log(`  Data Extracts: ${bulkData.dataExtracts.length}`);
  console.log('');

  // Test each dependency type
  console.log('═'.repeat(70));
  console.log('DEPENDENCY DETECTION RESULTS');
  console.log('═'.repeat(70));

  // 1. Filter Activities
  console.log('\n--- Filter Activities (by ObjectID) ---');
  let filterMatches = 0;
  for (const filter of bulkData.filterActivities) {
    let matchType = null;

    if (objectIdLower) {
      if (filter.sourceObjectId && filter.sourceObjectId.toLowerCase() === objectIdLower) {
        matchType = 'Source DE';
      }
      if (filter.destinationObjectId && filter.destinationObjectId.toLowerCase() === objectIdLower) {
        matchType = matchType ? 'Source & Destination DE' : 'Destination DE';
      }
    }

    if (matchType) {
      filterMatches++;
      console.log(`  ✓ ${filter.name}`);
      console.log(`    ID: ${filter.filterActivityId}`);
      console.log(`    Match: ${matchType}`);
      console.log(`    Source: ${filter.sourceObjectId}`);
      console.log(`    Dest: ${filter.destinationObjectId}`);
    }
  }
  console.log(`  Total: ${filterMatches} match(es)`);

  // 2. Query Activities
  console.log('\n--- Query Activities (by CustomerKey or Name) ---');
  let queryMatches = 0;
  for (const query of bulkData.queryActivities) {
    const targetKey = query['DataExtensionTarget.CustomerKey'] || query.DataExtensionTarget?.CustomerKey || '';
    const targetName = query['DataExtensionTarget.Name'] || query.DataExtensionTarget?.Name || '';
    const sql = query.QueryText || '';
    const sqlLower = sql.toLowerCase();

    let matchDetails = [];

    // Check target DE by CustomerKey
    if (targetKey.toLowerCase() === keyLower) {
      matchDetails.push('Target DE (CustomerKey match)');
    }
    // Check target DE by Name
    if (nameLower && targetName.toLowerCase() === nameLower) {
      matchDetails.push('Target DE (Name match)');
    }
    // Check SQL for CustomerKey reference
    if (sqlLower.includes(keyLower)) {
      matchDetails.push('Referenced in SQL (by Key)');
    }
    // Check SQL for Name reference (this is the common case!)
    if (nameLower && sqlLower.includes(nameLower)) {
      matchDetails.push('Referenced in SQL (by Name)');
    }

    if (matchDetails.length > 0) {
      queryMatches++;
      console.log(`  ✓ ${query.Name}`);
      console.log(`    ObjectID: ${query.ObjectID}`);
      console.log(`    CustomerKey: ${query.CustomerKey}`);
      console.log(`    Match: ${matchDetails.join(', ')}`);
      console.log(`    Target DE Key: ${targetKey || '(none)'}`);

      // Show SQL snippet around the match (prefer name match, fall back to key)
      const matchTerm = (nameLower && sqlLower.includes(nameLower)) ? nameLower : keyLower;
      if (sqlLower.includes(matchTerm)) {
        const idx = sqlLower.indexOf(matchTerm);
        const snippet = sql.substring(Math.max(0, idx - 30), Math.min(sql.length, idx + matchTerm.length + 30));
        console.log(`    SQL snippet: ...${snippet.replace(/\n/g, ' ')}...`);
      }
    }
  }
  console.log(`  Total: ${queryMatches} match(es)`);

  // 3. Import Activities
  console.log('\n--- Import Activities (by CustomerKey) ---');
  let importMatches = 0;
  for (const imp of bulkData.importActivities) {
    const destKey = imp['DestinationObject.CustomerKey'] || imp.DestinationObject?.CustomerKey || '';

    if (destKey.toLowerCase() === keyLower) {
      importMatches++;
      console.log(`  ✓ ${imp.Name}`);
      console.log(`    ObjectID: ${imp.ObjectID}`);
      console.log(`    CustomerKey: ${imp.CustomerKey}`);
      console.log(`    Destination DE: ${destKey}`);
    }
  }
  console.log(`  Total: ${importMatches} match(es)`);

  // 4. Triggered Sends
  console.log('\n--- Triggered Sends (by CustomerKey in JSON) ---');
  let tsdMatches = 0;
  for (const tsd of bulkData.triggeredSends) {
    const jsonStr = JSON.stringify(tsd).toLowerCase();

    if (jsonStr.includes(keyLower)) {
      tsdMatches++;
      console.log(`  ✓ ${tsd.Name}`);
      console.log(`    ObjectID: ${tsd.ObjectID}`);
      console.log(`    CustomerKey: ${tsd.CustomerKey}`);
      console.log(`    Status: ${tsd.TriggeredSendStatus}`);

      // Find where in the JSON it matched
      const matchIdx = jsonStr.indexOf(keyLower);
      const context = JSON.stringify(tsd).substring(Math.max(0, matchIdx - 40), matchIdx + keyLower.length + 40);
      console.log(`    Context: ...${context}...`);
    }
  }
  console.log(`  Total: ${tsdMatches} match(es)`);

  // 5. Automations
  console.log('\n--- Automations (by CustomerKey in JSON) ---');
  let autoMatches = 0;
  for (const auto of bulkData.automations) {
    const jsonStr = JSON.stringify(auto).toLowerCase();

    if (jsonStr.includes(keyLower)) {
      autoMatches++;
      console.log(`  ✓ ${auto.name}`);
      console.log(`    ID: ${auto.id}`);
      console.log(`    Status: ${auto.status} (statusId: ${auto.statusId})`);
      console.log(`    Last Run: ${auto.lastRunTime || '(never)'}`);

      // Find where in the JSON it matched
      const matchIdx = jsonStr.indexOf(keyLower);
      const context = JSON.stringify(auto).substring(Math.max(0, matchIdx - 40), matchIdx + keyLower.length + 40);
      console.log(`    Context: ...${context}...`);
    }
  }
  console.log(`  Total: ${autoMatches} match(es)`);

  // 6. Journeys
  console.log('\n--- Journeys (by CustomerKey in JSON) ---');
  let journeyMatches = 0;
  for (const journey of bulkData.journeys) {
    const jsonStr = JSON.stringify(journey).toLowerCase();

    if (jsonStr.includes(keyLower)) {
      journeyMatches++;
      console.log(`  ✓ ${journey.name}`);
      console.log(`    ID: ${journey.id}`);
      console.log(`    Status: ${journey.status}`);

      // Find where in the JSON it matched
      const matchIdx = jsonStr.indexOf(keyLower);
      const context = JSON.stringify(journey).substring(Math.max(0, matchIdx - 40), matchIdx + keyLower.length + 40);
      console.log(`    Context: ...${context}...`);
    }
  }
  console.log(`  Total: ${journeyMatches} match(es)`);

  // 7. Data Extracts
  console.log('\n--- Data Extracts (by CustomerKey in JSON) ---');
  let extractMatches = 0;
  for (const extract of bulkData.dataExtracts) {
    const jsonStr = JSON.stringify(extract).toLowerCase();

    if (jsonStr.includes(keyLower)) {
      extractMatches++;
      console.log(`  ✓ ${extract.name}`);
      console.log(`    ID: ${extract.dataExtractDefinitionId || extract.id}`);

      // Find where in the JSON it matched
      const matchIdx = jsonStr.indexOf(keyLower);
      const context = JSON.stringify(extract).substring(Math.max(0, matchIdx - 40), matchIdx + keyLower.length + 40);
      console.log(`    Context: ...${context}...`);
    }
  }
  console.log(`  Total: ${extractMatches} match(es)`);

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Filter Activities: ${filterMatches}`);
  console.log(`  Query Activities: ${queryMatches}`);
  console.log(`  Import Activities: ${importMatches}`);
  console.log(`  Triggered Sends: ${tsdMatches}`);
  console.log(`  Automations: ${autoMatches}`);
  console.log(`  Journeys: ${journeyMatches}`);
  console.log(`  Data Extracts: ${extractMatches}`);
  console.log(`  ─────────────────`);
  console.log(`  Total: ${filterMatches + queryMatches + importMatches + tsdMatches + autoMatches + journeyMatches + extractMatches}`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
