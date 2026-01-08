/**
 * Check Query/Automation Mismatch Script
 *
 * This script compares queries in SFMC with what automations reference
 * to identify any mismatches between existing queries and automation references.
 *
 * Usage: node src/scripts/check-query-automation-mismatch.js
 */

import { retrieve, buildSimpleFilter } from '../lib/sfmc-soap.js';
import { getAutomationDetails } from '../lib/sfmc-rest.js';
import { validateConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

// Configuration
const TARGET_BU = '1079060';
const QUERY_NAME_PATTERN = '10567SmallBusinessSmartCapture';

const AUTOMATIONS = [
  {
    name: '10567SmallBusinessSmartCapture_Summaries',
    id: '11e781fb-b173-4d04-905c-a9e32de05e5d'
  },
  {
    name: '10567SmallBusinessSmartCapture_Trigger',
    id: '1db8d963-80fe-4c2f-b1e8-12f550d16a36'
  }
];

async function main() {
  console.log('='.repeat(80));
  console.log('Query/Automation Mismatch Check');
  console.log(`Business Unit: ${TARGET_BU}`);
  console.log(`Query Pattern: ${QUERY_NAME_PATTERN}`);
  console.log('='.repeat(80));
  console.log();

  // Validate configuration
  try {
    validateConfig();
  } catch (error) {
    console.error('Configuration Error:', error.message);
    process.exit(1);
  }

  const logger = createLogger('check-query-automation-mismatch');

  // =========================================================================
  // STEP 1: Retrieve ALL queries containing "10567SmallBusinessSmartCapture"
  // =========================================================================
  console.log('STEP 1: Searching for queries via SOAP API...');
  console.log('-'.repeat(80));

  const filter = buildSimpleFilter('Name', 'like', `%${QUERY_NAME_PATTERN}%`);

  const queryProperties = [
    'ObjectID',
    'CustomerKey',
    'Name',
    'Description',
    'TargetType',
    'TargetUpdateType',
    'CategoryID',
    'DataExtensionTarget.CustomerKey',
    'DataExtensionTarget.Name'
  ];

  let queries = [];
  try {
    queries = await retrieve('QueryDefinition', queryProperties, filter, logger, TARGET_BU);
    console.log(`\nFound ${queries.length} queries matching pattern "${QUERY_NAME_PATTERN}":\n`);

    if (queries.length === 0) {
      console.log('  (No queries found)');
    } else {
      queries.forEach((q, index) => {
        console.log(`  ${index + 1}. Name: ${q.Name}`);
        console.log(`     ObjectID: ${q.ObjectID}`);
        console.log(`     CustomerKey: ${q.CustomerKey}`);
        if (q.DataExtensionTarget) {
          console.log(`     Target DE: ${q.DataExtensionTarget.Name || q.DataExtensionTarget.CustomerKey || 'N/A'}`);
        }
        console.log();
      });
    }
  } catch (error) {
    console.error('Error retrieving queries:', error.message);
    logger.error('SOAP retrieve failed', { error: error.message });
  }

  // Create a map of queries by ObjectID and by Name for easy lookup
  const queriesByObjectId = new Map();
  const queriesByName = new Map();
  for (const q of queries) {
    if (q.ObjectID) queriesByObjectId.set(q.ObjectID, q);
    if (q.Name) queriesByName.set(q.Name, q);
  }

  // =========================================================================
  // STEP 2: Get automation details via REST API
  // =========================================================================
  console.log('\nSTEP 2: Retrieving automation details via REST API...');
  console.log('-'.repeat(80));

  const automationDetails = [];

  for (const automation of AUTOMATIONS) {
    console.log(`\nFetching: ${automation.name} (${automation.id})`);

    try {
      const details = await getAutomationDetails(automation.id, logger, TARGET_BU);
      automationDetails.push({
        ...automation,
        details
      });

      console.log(`  Status: ${details.status || 'Unknown'}`);
      console.log(`  Steps: ${details.steps?.length || 0}`);

      // Extract query activities from steps
      if (details.steps && details.steps.length > 0) {
        console.log('\n  Query Activities Referenced:');
        let queryActivityCount = 0;

        for (const step of details.steps) {
          if (step.activities) {
            for (const activity of step.activities) {
              // Query activities have objectTypeId = 300
              if (activity.objectTypeId === 300) {
                queryActivityCount++;
                console.log(`    - Step ${step.stepNumber || step.step}: ${activity.name || 'Unnamed'}`);
                console.log(`      activityObjectId: ${activity.activityObjectId || 'N/A'}`);
                console.log(`      id: ${activity.id || 'N/A'}`);
              }
            }
          }
        }

        if (queryActivityCount === 0) {
          console.log('    (No query activities found in this automation)');
        }
      }
    } catch (error) {
      console.error(`  Error: ${error.message}`);
      automationDetails.push({
        ...automation,
        error: error.message
      });
    }
  }

  // =========================================================================
  // STEP 3: Analyze mismatches
  // =========================================================================
  console.log('\n\nSTEP 3: Analyzing for mismatches...');
  console.log('='.repeat(80));

  const issues = [];
  const referencedQueryIds = new Set();

  for (const automation of automationDetails) {
    if (automation.error) {
      issues.push({
        type: 'AUTOMATION_ERROR',
        automation: automation.name,
        message: `Could not fetch automation details: ${automation.error}`
      });
      continue;
    }

    const details = automation.details;
    if (!details.steps) continue;

    for (const step of details.steps) {
      if (!step.activities) continue;

      for (const activity of step.activities) {
        if (activity.objectTypeId === 300) {
          // This is a query activity
          const refId = activity.activityObjectId;
          const activityName = activity.name;

          if (refId) {
            referencedQueryIds.add(refId);

            // Check if this ObjectID exists in our query list
            if (!queriesByObjectId.has(refId)) {
              // Check if there's a query with matching name
              const matchingByName = queriesByName.get(activityName);

              issues.push({
                type: 'MISSING_QUERY',
                automation: automation.name,
                step: step.stepNumber || step.step,
                activityName: activityName,
                referencedObjectId: refId,
                matchingQueryByName: matchingByName ? {
                  name: matchingByName.Name,
                  objectId: matchingByName.ObjectID,
                  customerKey: matchingByName.CustomerKey
                } : null
              });
            }
          }
        }
      }
    }
  }

  // Check for queries that exist but are not referenced
  for (const query of queries) {
    if (!referencedQueryIds.has(query.ObjectID)) {
      issues.push({
        type: 'ORPHAN_QUERY',
        queryName: query.Name,
        queryObjectId: query.ObjectID,
        queryCustomerKey: query.CustomerKey,
        message: 'Query exists but is not referenced by any automation'
      });
    }
  }

  // =========================================================================
  // STEP 4: Generate report
  // =========================================================================
  console.log('\n\nSUMMARY REPORT');
  console.log('='.repeat(80));

  console.log(`\nQueries found: ${queries.length}`);
  console.log(`Automations checked: ${AUTOMATIONS.length}`);
  console.log(`Issues detected: ${issues.length}`);

  if (issues.length === 0) {
    console.log('\n[OK] No mismatches detected. All automation references match existing queries.');
  } else {
    console.log('\n[!] ISSUES DETECTED:\n');

    // Group issues by type
    const missingQueries = issues.filter(i => i.type === 'MISSING_QUERY');
    const orphanQueries = issues.filter(i => i.type === 'ORPHAN_QUERY');
    const automationErrors = issues.filter(i => i.type === 'AUTOMATION_ERROR');

    if (missingQueries.length > 0) {
      console.log('MISSING QUERIES (referenced by automations but not found):');
      console.log('-'.repeat(60));
      for (const issue of missingQueries) {
        console.log(`  Automation: ${issue.automation}`);
        console.log(`  Step: ${issue.step}`);
        console.log(`  Activity Name: ${issue.activityName}`);
        console.log(`  Referenced ObjectID: ${issue.referencedObjectId}`);
        if (issue.matchingQueryByName) {
          console.log(`  [!] Found query with SAME NAME but DIFFERENT ObjectID:`);
          console.log(`      Query Name: ${issue.matchingQueryByName.name}`);
          console.log(`      Query ObjectID: ${issue.matchingQueryByName.objectId}`);
          console.log(`      Query CustomerKey: ${issue.matchingQueryByName.customerKey}`);
        }
        console.log();
      }
    }

    if (orphanQueries.length > 0) {
      console.log('\nORPHAN QUERIES (exist but not referenced by automations):');
      console.log('-'.repeat(60));
      for (const issue of orphanQueries) {
        console.log(`  Name: ${issue.queryName}`);
        console.log(`  ObjectID: ${issue.queryObjectId}`);
        console.log(`  CustomerKey: ${issue.queryCustomerKey}`);
        console.log();
      }
    }

    if (automationErrors.length > 0) {
      console.log('\nAUTOMATION ERRORS:');
      console.log('-'.repeat(60));
      for (const issue of automationErrors) {
        console.log(`  Automation: ${issue.automation}`);
        console.log(`  Error: ${issue.message}`);
        console.log();
      }
    }
  }

  // Create a detailed comparison table
  console.log('\n\nDETAILED COMPARISON TABLE');
  console.log('='.repeat(80));
  console.log('\nExisting Queries:');
  console.log('-'.repeat(80));
  console.log(String('Name').padEnd(50) + String('ObjectID').padEnd(40));
  console.log('-'.repeat(80));
  for (const q of queries) {
    console.log(String(q.Name || '').substring(0, 48).padEnd(50) + String(q.ObjectID || ''));
  }

  console.log('\n\nAutomation Query References:');
  console.log('-'.repeat(80));
  for (const automation of automationDetails) {
    if (automation.error) continue;

    console.log(`\n${automation.name}:`);
    const details = automation.details;
    if (!details.steps) continue;

    for (const step of details.steps) {
      if (!step.activities) continue;

      for (const activity of step.activities) {
        if (activity.objectTypeId === 300) {
          const refId = activity.activityObjectId;
          const exists = queriesByObjectId.has(refId);
          const status = exists ? '[OK]' : '[MISSING]';
          console.log(`  ${status} ${activity.name || 'Unnamed'}`);
          console.log(`         activityObjectId: ${refId}`);
          if (!exists && activity.name) {
            const byName = queriesByName.get(activity.name);
            if (byName) {
              console.log(`         [!] Query with same name exists with ObjectID: ${byName.ObjectID}`);
            }
          }
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('Check complete.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
