/**
 * Debug script to test SOAP Delete operation
 */

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

async function debug() {
  console.log('=== SFMC SOAP Delete Debug ===\n');

  // 1. Get token
  console.log('Fetching OAuth token...');
  const authBase = process.env.SFMC_AUTH_URL.replace(/\/$/, '');
  const tokenUrl = `${authBase}/v2/token`;

  try {
    const tokenResponse = await axios.post(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: process.env.SFMC_CLIENT_ID,
      client_secret: process.env.SFMC_CLIENT_SECRET,
      account_id: process.env.SFMC_ACCOUNT_ID
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('Token acquired.\n');
    const accessToken = tokenResponse.data.access_token;

    // Determine SOAP URL
    let soapUrl = tokenResponse.data.soap_instance_url || process.env.SFMC_SOAP_URL;
    if (!soapUrl.endsWith('/Service.asmx')) {
      soapUrl = soapUrl.replace(/\/?$/, '/Service.asmx');
    }

    console.log('Using SOAP URL:', soapUrl);

    // Test delete with a fake key to see the response format
    // Using a non-existent key so we don't actually delete anything
    const testCustomerKey = 'TEST_NONEXISTENT_DE_12345';

    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:et="http://exacttarget.com/wsdl/partnerAPI">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <DeleteRequest xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <Objects xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="DataExtension">
        <CustomerKey>${testCustomerKey}</CustomerKey>
      </Objects>
    </DeleteRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log('\nTesting SOAP Delete with SOAPAction: Delete...');
    console.log('Test CustomerKey:', testCustomerKey);

    const soapResponse = await axios.post(soapUrl, soapEnvelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'Delete'
      },
      timeout: 30000
    });

    console.log('\nSOAP Response Status:', soapResponse.status);
    console.log('\nFull Response:');
    console.log(soapResponse.data);

    // Also test parsing
    const { parseStringPromise } = await import('xml2js');
    const parsed = await parseStringPromise(soapResponse.data, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [(name) => name.replace(/^.*:/, '')]
    });

    console.log('\n\nParsed Body structure:');
    console.log(JSON.stringify(parsed.Envelope.Body, null, 2));

  } catch (error) {
    console.log('\n❌ Error occurred:');
    if (error.response) {
      console.log('  HTTP Status:', error.response.status, error.response.statusText);
      console.log('  Response Data:', error.response.data);
    } else {
      console.log('  Error:', error.message);
    }
  }
}

debug();
