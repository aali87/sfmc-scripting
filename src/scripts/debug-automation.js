#!/usr/bin/env node

/**
 * Debug script to inspect automation metadata
 * Usage: node src/scripts/debug-automation.js "Automation Name"
 */

import { testConnection } from '../lib/sfmc-auth.js';
import { getAutomations, getAutomationDetails } from '../lib/sfmc-rest.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('debug-automation');

async function main() {
  const searchTerm = process.argv[2];

  if (!searchTerm) {
    console.log('Usage: node src/scripts/debug-automation.js "Automation Name"');
    process.exit(1);
  }

  console.log(`\n🔍 Searching for automation: "${searchTerm}"\n`);

  // Connect
  const conn = await testConnection(logger);
  if (!conn.success) {
    console.error('Failed to connect:', conn.error);
    process.exit(1);
  }
  console.log('✓ Connected to SFMC\n');

  // Get all automations
  console.log('Loading automations...');
  const automations = await getAutomations(logger);
  console.log(`Loaded ${automations.length} automations\n`);

  // Find matching automation
  const searchLower = searchTerm.toLowerCase();
  const matches = automations.filter(a =>
    a.name && a.name.toLowerCase().includes(searchLower)
  );

  if (matches.length === 0) {
    console.log(`❌ No automations found matching "${searchTerm}"`);
    process.exit(1);
  }

  console.log(`Found ${matches.length} matching automation(s):\n`);

  for (const auto of matches) {
    console.log('─'.repeat(70));
    console.log(`Name: ${auto.name}`);
    console.log(`ID: ${auto.id}`);
    console.log(`Key: ${auto.key}`);
    console.log('');

    // Basic info from list endpoint
    console.log('--- From List Endpoint ---');
    console.log(`  status: ${auto.status}`);
    console.log(`  statusId: ${auto.statusId}`);
    console.log(`  lastRunTime: ${auto.lastRunTime || '(not available in list)'}`);
    console.log('');

    // Get full details
    console.log('--- From Details Endpoint ---');
    try {
      const details = await getAutomationDetails(auto.id, logger);
      console.log(`  status: ${details.status}`);
      console.log(`  statusId: ${details.statusId}`);
      console.log(`  lastRunTime: ${details.lastRunTime || '(null/undefined)'}`);
      console.log(`  lastRunInstanceId: ${details.lastRunInstanceId || '(null/undefined)'}`);
      console.log(`  createdDate: ${details.createdDate}`);
      console.log(`  modifiedDate: ${details.modifiedDate}`);
      console.log('');

      // Classification logic check
      console.log('--- Classification Analysis ---');
      const statusId = details.statusId;
      const status = (details.status || '').toLowerCase();
      const lastRunTime = details.lastRunTime;

      const isInactive = statusId === 4 || statusId === 5 || statusId === 8 ||
        status.includes('paused') || status.includes('stopped') || status.includes('inactive');

      console.log(`  statusId=${statusId}, status="${details.status}"`);
      console.log(`  isInactive check: ${isInactive}`);
      console.log(`    - statusId === 4 (Paused): ${statusId === 4}`);
      console.log(`    - statusId === 5 (Stopped): ${statusId === 5}`);
      console.log(`    - statusId === 8 (Inactive): ${statusId === 8}`);
      console.log(`    - status includes 'paused': ${status.includes('paused')}`);
      console.log(`    - status includes 'stopped': ${status.includes('stopped')}`);
      console.log(`    - status includes 'inactive': ${status.includes('inactive')}`);
      console.log('');
      console.log(`  lastRunTime: ${lastRunTime || '(none)'}`);

      if (lastRunTime) {
        const lastRun = new Date(lastRunTime);
        const now = new Date();
        const daysSinceRun = Math.floor((now - lastRun) / (1000 * 60 * 60 * 24));
        console.log(`  Days since last run: ${daysSinceRun}`);
        console.log(`  Would be stale (>365 days): ${daysSinceRun > 365}`);
      } else {
        console.log(`  No lastRunTime = "Never Run" = SAFE TO DELETE`);
      }

      // Show what classification would be
      let classification, reason;
      if (!lastRunTime) {
        classification = 'SAFE_TO_DELETE';
        reason = 'Automation has never been run';
      } else {
        const lastRun = new Date(lastRunTime);
        const staleThreshold = new Date();
        staleThreshold.setDate(staleThreshold.getDate() - 365);

        if (lastRun < staleThreshold) {
          classification = 'SAFE_TO_DELETE';
          reason = 'Automation has not run in over a year';
        } else if (isInactive) {
          classification = 'REQUIRES_REVIEW';
          reason = 'Automation is inactive/paused but recently used';
        } else {
          classification = 'REQUIRES_REVIEW';
          reason = 'Automation is active and recently used';
        }
      }

      console.log('');
      console.log(`  → Classification: ${classification}`);
      console.log(`  → Reason: ${reason}`);

    } catch (err) {
      console.log(`  Error getting details: ${err.message}`);
    }

    console.log('');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
