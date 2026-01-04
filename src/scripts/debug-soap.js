#!/usr/bin/env node

/**
 * Debug script to test SOAP API calls directly
 * Usage: node src/scripts/debug-soap.js
 */

import axios from 'axios';
import { testConnection, getAccessToken } from '../lib/sfmc-auth.js';
import {
  retrieveQueryDefinitions,
  retrieveImportDefinitions,
  retrieveTriggeredSendDefinitions
} from '../lib/sfmc-soap.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('debug-soap');

async function testRawQueryRequest() {
  const tokenInfo = await getAccessToken(logger);
  let soapUrl = tokenInfo.soapInstanceUrl;
  if (!soapUrl.endsWith('/Service.asmx')) {
    soapUrl = soapUrl.replace(/\/?$/, '/Service.asmx');
  }

  // Try without QueryText first since large SQL can cause issues
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:et="http://exacttarget.com/wsdl/partnerAPI">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${tokenInfo.accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>QueryDefinition</ObjectType>
        <Properties>ObjectID</Properties>
        <Properties>CustomerKey</Properties>
        <Properties>Name</Properties>
        <Properties>TargetType</Properties>
        <Properties>TargetUpdateType</Properties>
        <Properties>CategoryID</Properties>
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

  console.log('  Making raw SOAP request...');
  try {
    const response = await axios.post(soapUrl, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'Retrieve'
      },
      timeout: 120000
    });

    console.log(`  Response status: ${response.status}`);
    console.log(`  Response data length: ${response.data?.length || 0} bytes`);
    console.log(`  Response starts with: ${response.data?.substring(0, 200)}...`);
    return response.data;
  } catch (err) {
    console.log(`  Raw request error: ${err.message}`);
    if (err.response) {
      console.log(`  Response status: ${err.response.status}`);
      console.log(`  Response data: ${err.response.data?.substring?.(0, 500) || err.response.data}`);
    }
    return null;
  }
}

async function main() {
  console.log('\n🔍 Testing SOAP API calls for Query, Import, and Triggered Send definitions\n');

  // Connect
  const conn = await testConnection(logger);
  if (!conn.success) {
    console.error('Failed to connect:', conn.error);
    process.exit(1);
  }
  console.log('✓ Connected to SFMC\n');

  // Test Query Definitions - with raw request first
  console.log('--- Query Definitions (QueryDefinition) ---');
  console.log('  Testing raw request first...');
  const rawResult = await testRawQueryRequest();
  if (rawResult && rawResult.includes('Envelope')) {
    console.log('  ✓ Raw request returned valid SOAP response');
  }
  console.log('');

  console.log('  Testing via library function...');
  try {
    const queries = await retrieveQueryDefinitions(logger);
    console.log(`  ✓ Retrieved ${queries.length} query definitions`);
    if (queries.length > 0) {
      console.log(`  Sample: ${queries[0].Name || queries[0].CustomerKey}`);
      console.log(`  Properties: ${Object.keys(queries[0]).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    console.log(`  Stack: ${err.stack}`);
  }
  console.log('');

  // Test Import Definitions
  console.log('--- Import Definitions (ImportDefinition) ---');
  try {
    const imports = await retrieveImportDefinitions(logger);
    console.log(`  ✓ Retrieved ${imports.length} import definitions`);
    if (imports.length > 0) {
      console.log(`  Sample: ${imports[0].Name || imports[0].CustomerKey}`);
      console.log(`  Properties: ${Object.keys(imports[0]).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }
  console.log('');

  // Test Triggered Send Definitions
  console.log('--- Triggered Send Definitions (TriggeredSendDefinition) ---');
  try {
    const triggers = await retrieveTriggeredSendDefinitions(logger);
    console.log(`  ✓ Retrieved ${triggers.length} triggered send definitions`);
    if (triggers.length > 0) {
      console.log(`  Sample: ${triggers[0].Name || triggers[0].CustomerKey}`);
      console.log(`  Properties: ${Object.keys(triggers[0]).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }
  console.log('');

  console.log('Done!\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
