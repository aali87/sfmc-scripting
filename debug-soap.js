/**
 * Debug script to test SOAP connectivity
 */

import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

async function debug() {
  console.log('=== SFMC SOAP Debug ===\n');

  // 1. Show config
  console.log('Configuration:');
  console.log('  AUTH_URL:', process.env.SFMC_AUTH_URL);
  console.log('  SOAP_URL:', process.env.SFMC_SOAP_URL);
  console.log('  ACCOUNT_ID:', process.env.SFMC_ACCOUNT_ID);
  console.log('');

  // 2. Get token
  console.log('Fetching OAuth token...');
  const tokenUrl = `${process.env.SFMC_AUTH_URL}/v2/token`;
  console.log('  Token URL:', tokenUrl);

  try {
    const tokenResponse = await axios.post(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: process.env.SFMC_CLIENT_ID,
      client_secret: process.env.SFMC_CLIENT_SECRET,
      account_id: process.env.SFMC_ACCOUNT_ID
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('\nToken Response:');
    console.log('  access_token:', tokenResponse.data.access_token ? '[RECEIVED]' : '[MISSING]');
    console.log('  rest_instance_url:', tokenResponse.data.rest_instance_url);
    console.log('  soap_instance_url:', tokenResponse.data.soap_instance_url);
    console.log('');

    const accessToken = tokenResponse.data.access_token;

    // Determine SOAP URL to use
    let soapUrl = tokenResponse.data.soap_instance_url || process.env.SFMC_SOAP_URL;

    // Ensure it ends with /Service.asmx
    if (!soapUrl.endsWith('/Service.asmx')) {
      if (soapUrl.endsWith('/')) {
        soapUrl = soapUrl + 'Service.asmx';
      } else {
        soapUrl = soapUrl + '/Service.asmx';
      }
    }

    console.log('Using SOAP URL:', soapUrl);

    // 3. Test SOAP request
    console.log('\nTesting SOAP Retrieve...');

    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:et="http://exacttarget.com/wsdl/partnerAPI">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>DataFolder</ObjectType>
        <Properties>ID</Properties>
        <Properties>Name</Properties>
        <Properties>ContentType</Properties>
        <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
          <Property>ContentType</Property>
          <SimpleOperator>equals</SimpleOperator>
          <Value>dataextension</Value>
        </Filter>
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log('  Sending POST to:', soapUrl);

    const soapResponse = await axios.post(soapUrl, soapEnvelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'Retrieve'
      },
      timeout: 30000
    });

    console.log('\nSOAP Response Status:', soapResponse.status);
    console.log('Response preview:', soapResponse.data.substring(0, 500));
    console.log('\n✓ SOAP connection successful!');

  } catch (error) {
    console.log('\n❌ Error occurred:');
    if (error.response) {
      console.log('  HTTP Status:', error.response.status, error.response.statusText);
      console.log('  Response Headers:', JSON.stringify(error.response.headers, null, 2));
      console.log('  Response Data:', typeof error.response.data === 'string'
        ? error.response.data.substring(0, 1000)
        : JSON.stringify(error.response.data, null, 2));
    } else {
      console.log('  Error:', error.message);
    }
  }
}

debug();
