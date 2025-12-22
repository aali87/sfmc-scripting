/**
 * SFMC SOAP API Client
 * Handles SOAP requests with WS-Security headers and pagination
 */

import axios from 'axios';
import { parseStringPromise, Builder } from 'xml2js';
import { getAccessToken } from './sfmc-auth.js';
import config from '../config/index.js';

// SOAP namespaces
const NAMESPACES = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  et: 'http://exacttarget.com/wsdl/partnerAPI'
};

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Sleep helper for rate limiting and retries
 * @param {number} ms - Milliseconds to sleep
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build SOAP envelope with fueloauth header (OAuth 2.0)
 * @param {string} accessToken - OAuth access token
 * @param {string} bodyContent - SOAP body XML content
 * @returns {string} Complete SOAP envelope XML
 */
function buildSoapEnvelope(accessToken, bodyContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${NAMESPACES.soap}" xmlns:et="${NAMESPACES.et}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    ${bodyContent}
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Parse SOAP response and extract body content
 * @param {string} xmlResponse - SOAP response XML
 * @returns {Promise<object>} Parsed response body
 */
async function parseSoapResponse(xmlResponse) {
  const result = await parseStringPromise(xmlResponse, {
    explicitArray: false,
    ignoreAttrs: false,
    tagNameProcessors: [(name) => name.replace(/^.*:/, '')] // Remove namespace prefixes
  });

  const envelope = result.Envelope;
  if (!envelope) {
    throw new Error('Invalid SOAP response: missing Envelope');
  }

  // Check for SOAP Fault
  if (envelope.Body && envelope.Body.Fault) {
    const fault = envelope.Body.Fault;
    const faultString = fault.faultstring || fault.Reason?.Text || 'Unknown SOAP Fault';
    const faultCode = fault.faultcode || fault.Code?.Value || 'Unknown';
    throw new Error(`SOAP Fault [${faultCode}]: ${faultString}`);
  }

  return envelope.Body;
}

/**
 * Make a SOAP API request with retry logic
 * @param {string} soapBody - SOAP body content
 * @param {object} logger - Logger instance
 * @param {number} retryCount - Current retry count
 * @returns {Promise<object>} Parsed response body
 */
async function makeSoapRequest(soapBody, logger, retryCount = 0) {
  const tokenInfo = await getAccessToken(logger);
  const envelope = buildSoapEnvelope(tokenInfo.accessToken, soapBody);

  // Get SOAP URL and ensure it ends with /Service.asmx
  let soapUrl = tokenInfo.soapInstanceUrl || config.sfmc.soapUrl;
  if (!soapUrl.endsWith('/Service.asmx')) {
    soapUrl = soapUrl.replace(/\/?$/, '/Service.asmx');
  }

  if (logger) {
    logger.api('POST', soapUrl, { bodyLength: soapBody.length });
  }

  try {
    const response = await axios.post(soapUrl, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'Retrieve'
      },
      timeout: 120000 // 2 minute timeout for SOAP calls
    });

    // Rate limit delay
    await sleep(config.safety.apiRateLimitDelayMs);

    return await parseSoapResponse(response.data);

  } catch (error) {
    // Handle retryable errors
    if (retryCount < MAX_RETRIES) {
      const isRetryable =
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' ||
        (error.response && error.response.status === 503) ||
        (error.response && error.response.status === 429);

      if (isRetryable) {
        const delay = RETRY_DELAY_MS * Math.pow(2, retryCount); // Exponential backoff
        if (logger) {
          logger.warn(`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        }
        await sleep(delay);
        return makeSoapRequest(soapBody, logger, retryCount + 1);
      }
    }

    // Handle specific error types
    if (error.response) {
      // Try to parse SOAP fault from response
      try {
        const body = await parseSoapResponse(error.response.data);
        // If we get here, the fault was already thrown
        return body;
      } catch (parseError) {
        if (parseError.message.includes('SOAP Fault')) {
          throw parseError;
        }
        throw new Error(`SOAP API error: HTTP ${error.response.status} - ${error.response.statusText}`);
      }
    }

    throw new Error(`SOAP request failed: ${error.message}`);
  }
}

/**
 * Build a filter expression for SOAP Retrieve
 * @param {string} property - Property name to filter on
 * @param {string} operator - SimpleOperator value (equals, notEquals, like, etc.)
 * @param {string|number} value - Value to compare
 * @returns {string} Filter XML
 */
function buildSimpleFilter(property, operator, value) {
  return `
    <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
      <Property>${property}</Property>
      <SimpleOperator>${operator}</SimpleOperator>
      <Value>${escapeXml(String(value))}</Value>
    </Filter>`;
}

/**
 * Build a complex filter with AND/OR logic
 * @param {string} logicalOperator - 'AND' or 'OR'
 * @param {string[]} filterParts - Array of filter XML strings
 * @returns {string} Complex filter XML
 */
function buildComplexFilter(logicalOperator, filterParts) {
  if (filterParts.length === 1) {
    return filterParts[0];
  }

  // SFMC complex filters are binary, so we need to nest them
  let result = filterParts[0];
  for (let i = 1; i < filterParts.length; i++) {
    result = `
    <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ComplexFilterPart">
      <LeftOperand xsi:type="SimpleFilterPart">${result}</LeftOperand>
      <LogicalOperator>${logicalOperator}</LogicalOperator>
      <RightOperand xsi:type="SimpleFilterPart">${filterParts[i]}</RightOperand>
    </Filter>`;
  }
  return result;
}

/**
 * Escape special XML characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generic SOAP Retrieve operation with pagination
 * @param {string} objectType - SFMC object type (DataExtension, DataFolder, etc.)
 * @param {string[]} properties - Properties to retrieve
 * @param {string} filter - Filter XML (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of retrieved objects
 */
export async function retrieve(objectType, properties, filter = null, logger = null) {
  const allResults = [];
  let requestId = null;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    let soapBody;

    if (requestId) {
      // Continue retrieving with requestId
      soapBody = `
        <RetrieveRequestMsg xmlns="${NAMESPACES.et}">
          <ContinueRequest>${requestId}</ContinueRequest>
        </RetrieveRequestMsg>`;
    } else {
      // Initial retrieve request
      const propsXml = properties.map(p => `<Properties>${p}</Properties>`).join('\n        ');
      soapBody = `
        <RetrieveRequestMsg xmlns="${NAMESPACES.et}">
          <RetrieveRequest>
            <ObjectType>${objectType}</ObjectType>
            ${propsXml}
            ${filter || ''}
          </RetrieveRequest>
        </RetrieveRequestMsg>`;
    }

    const body = await makeSoapRequest(soapBody, logger);
    const response = body.RetrieveResponseMsg;

    if (!response) {
      throw new Error('Invalid SOAP response: missing RetrieveResponseMsg');
    }

    const status = response.OverallStatus;
    pageCount++;

    if (logger) {
      logger.debug(`Retrieve page ${pageCount}: status=${status}`);
    }

    // Check for errors
    if (status === 'Error') {
      const errorMsg = response.Results?.StatusMessage || 'Unknown error';
      throw new Error(`Retrieve failed: ${errorMsg}`);
    }

    // Extract results
    if (response.Results) {
      const results = Array.isArray(response.Results) ? response.Results : [response.Results];
      allResults.push(...results);
    }

    // Check for more results
    if (status === 'MoreDataAvailable') {
      requestId = response.RequestID;
    } else {
      hasMore = false;
    }
  }

  if (logger) {
    logger.debug(`Retrieve complete: ${allResults.length} total results from ${pageCount} page(s)`);
  }

  return allResults;
}

/**
 * SOAP Delete operation
 * @param {string} objectType - SFMC object type
 * @param {object[]} objects - Objects to delete (must have identifying properties)
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteObjects(objectType, objects, logger = null) {
  if (objects.length === 0) {
    return { success: true, deleted: 0 };
  }

  // Build object XML for deletion
  const objectsXml = objects.map(obj => {
    let objXml = `<Objects xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="${objectType}">`;
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && value !== undefined) {
        objXml += `<${key}>${escapeXml(String(value))}</${key}>`;
      }
    }
    objXml += '</Objects>';
    return objXml;
  }).join('\n    ');

  const soapBody = `
    <DeleteRequest xmlns="${NAMESPACES.et}">
      ${objectsXml}
    </DeleteRequest>`;

  const body = await makeSoapRequest(soapBody, logger);
  const response = body.DeleteResponse;

  if (!response) {
    throw new Error('Invalid SOAP response: missing DeleteResponse');
  }

  // Parse results
  const results = Array.isArray(response.Results) ? response.Results : [response.Results];
  const successful = results.filter(r => r.StatusCode === 'OK');
  const failed = results.filter(r => r.StatusCode !== 'OK');

  if (logger) {
    logger.debug(`Delete complete: ${successful.length} success, ${failed.length} failed`);
  }

  return {
    success: failed.length === 0,
    deleted: successful.length,
    failed: failed.length,
    results: results.map(r => ({
      statusCode: r.StatusCode,
      statusMessage: r.StatusMessage,
      objectId: r.Object?.ObjectID || r.Object?.CustomerKey
    }))
  };
}

/**
 * Retrieve DataFolder (folder) objects
 * @param {string} filter - Filter XML (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of folder objects
 */
export async function retrieveFolders(filter = null, logger = null) {
  const properties = [
    'ID', 'Name', 'Description', 'ContentType', 'ParentFolder.ID',
    'ParentFolder.Name', 'CustomerKey', 'IsActive', 'IsEditable',
    'AllowChildren', 'CreatedDate', 'ModifiedDate', 'ObjectID'
  ];

  return retrieve('DataFolder', properties, filter, logger);
}

/**
 * Retrieve DataExtension objects
 * @param {string} filter - Filter XML (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of DE objects
 */
export async function retrieveDataExtensions(filter = null, logger = null) {
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description', 'IsSendable',
    'IsTestable', 'SendableSubscriberField.Name', 'SendableDataExtensionField.Name',
    'Template.CustomerKey', 'CategoryID', 'Status', 'CreatedDate', 'ModifiedDate',
    'RetainUntil', 'DataRetentionPeriodLength', 'DataRetentionPeriodUnitOfMeasure',
    'RowBasedRetention', 'ResetRetentionPeriodOnImport', 'DeleteAtEndOfRetentionPeriod'
  ];

  return retrieve('DataExtension', properties, filter, logger);
}

/**
 * Retrieve DataExtension fields
 * @param {string} deCustomerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of field objects
 */
export async function retrieveDataExtensionFields(deCustomerKey, logger = null) {
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'DefaultValue', 'FieldType',
    'IsPrimaryKey', 'IsRequired', 'MaxLength', 'Scale', 'Ordinal'
  ];

  const filter = `
    <Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="SimpleFilterPart">
      <Property>DataExtension.CustomerKey</Property>
      <SimpleOperator>equals</SimpleOperator>
      <Value>${escapeXml(deCustomerKey)}</Value>
    </Filter>`;

  return retrieve('DataExtensionField', properties, filter, logger);
}

/**
 * Retrieve TriggeredSendDefinition objects
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of TSD objects
 */
export async function retrieveTriggeredSendDefinitions(logger = null) {
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description', 'TriggeredSendStatus',
    'Email.ID', 'List.ID', 'SendableDataExtensionField.Name',
    'SendableSubscriberField.Name', 'CreatedDate', 'ModifiedDate'
  ];

  return retrieve('TriggeredSendDefinition', properties, null, logger);
}

/**
 * Retrieve QueryDefinition (SQL Query Activity) objects
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of query objects
 */
export async function retrieveQueryDefinitions(logger = null) {
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description', 'QueryText',
    'TargetType', 'TargetUpdateType', 'DataExtensionTarget.CustomerKey',
    'DataExtensionTarget.Name', 'CategoryID', 'Status', 'CreatedDate', 'ModifiedDate'
  ];

  return retrieve('QueryDefinition', properties, null, logger);
}

/**
 * Retrieve ImportDefinition objects
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of import definition objects
 */
export async function retrieveImportDefinitions(logger = null) {
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description',
    'DestinationObject.ObjectID', 'DestinationObject.CustomerKey',
    'UpdateType', 'FileSpec', 'CategoryID', 'Status', 'CreatedDate', 'ModifiedDate'
  ];

  return retrieve('ImportDefinition', properties, null, logger);
}

/**
 * Delete a Data Extension
 * @param {string} customerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteDataExtension(customerKey, logger = null) {
  return deleteObjects('DataExtension', [{ CustomerKey: customerKey }], logger);
}

/**
 * Delete a folder
 * @param {number} folderId - Folder CategoryID
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteFolder(folderId, logger = null) {
  return deleteObjects('DataFolder', [{ ID: folderId }], logger);
}

// Export filter builders
export { buildSimpleFilter, buildComplexFilter, escapeXml };

export default {
  retrieve,
  deleteObjects,
  retrieveFolders,
  retrieveDataExtensions,
  retrieveDataExtensionFields,
  retrieveTriggeredSendDefinitions,
  retrieveQueryDefinitions,
  retrieveImportDefinitions,
  deleteDataExtension,
  deleteFolder,
  buildSimpleFilter,
  buildComplexFilter
};
