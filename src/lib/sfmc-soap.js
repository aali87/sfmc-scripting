/**
 * SFMC SOAP API Client
 * Handles SOAP requests with WS-Security headers and pagination
 */

import axios from 'axios';
import { parseStringPromise, Builder } from 'xml2js';
import { getAccessToken } from './sfmc-auth.js';
import config from '../config/index.js';
import { sleep, isRetryableError, calculateBackoffDelay, RETRY_CONFIG } from './utils.js';

// SOAP namespaces
const NAMESPACES = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  et: 'http://exacttarget.com/wsdl/partnerAPI'
};

const { MAX_RETRIES, RETRY_DELAY_MS } = RETRY_CONFIG;

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
async function makeSoapRequest(soapBody, logger, retryCount = 0, soapAction = 'Retrieve') {
  const tokenInfo = await getAccessToken(logger);
  const envelope = buildSoapEnvelope(tokenInfo.accessToken, soapBody);

  // Get SOAP URL and ensure it ends with /Service.asmx
  let soapUrl = tokenInfo.soapInstanceUrl || config.sfmc.soapUrl;
  if (!soapUrl.endsWith('/Service.asmx')) {
    soapUrl = soapUrl.replace(/\/?$/, '/Service.asmx');
  }

  if (logger) {
    logger.api('POST', soapUrl, { bodyLength: soapBody.length, action: soapAction });
  }

  try {
    const response = await axios.post(soapUrl, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction
      },
      timeout: 120000 // 2 minute timeout for SOAP calls
    });

    // Rate limit delay
    await sleep(config.safety.apiRateLimitDelayMs);

    return await parseSoapResponse(response.data);

  } catch (error) {
    // Handle retryable errors
    if (retryCount < MAX_RETRIES && isRetryableError(error)) {
      const delay = calculateBackoffDelay(retryCount);
      if (logger) {
        logger.warn(`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      }
      await sleep(delay);
      return makeSoapRequest(soapBody, logger, retryCount + 1, soapAction);
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
          <RetrieveRequest>
            <ContinueRequest>${requestId}</ContinueRequest>
          </RetrieveRequest>
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
      // Try to extract error message from various possible locations
      let errorMsg = 'Unknown error';
      if (response.Results) {
        const results = Array.isArray(response.Results) ? response.Results : [response.Results];
        const errorResult = results.find(r => r.StatusMessage || r.ErrorCode);
        if (errorResult) {
          errorMsg = errorResult.StatusMessage || `ErrorCode: ${errorResult.ErrorCode}`;
        }
      }
      // Also check for error in OverallStatusMessage
      if (response.OverallStatusMessage) {
        errorMsg = response.OverallStatusMessage;
      }
      if (logger) {
        logger.debug(`SOAP Error Response: ${JSON.stringify(response)}`);
      }
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

  const body = await makeSoapRequest(soapBody, logger, 0, 'Delete');

  if (logger) {
    logger.debug(`Delete response body: ${JSON.stringify(body)}`);
  }

  const response = body.DeleteResponse;

  if (!response) {
    // Check if there's an alternative response structure
    if (body.DeleteResponseMsg) {
      const deleteResponse = body.DeleteResponseMsg;
      if (logger) {
        logger.debug(`Found DeleteResponseMsg: ${JSON.stringify(deleteResponse)}`);
      }
    }
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
  // Valid TriggeredSendDefinition properties (SFMC SOAP API)
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description', 'TriggeredSendStatus',
    'Email.ID', 'List.ID', 'CreatedDate', 'ModifiedDate',
    'SendClassification.CustomerKey', 'SenderProfile.CustomerKey'
  ];

  return retrieve('TriggeredSendDefinition', properties, null, logger);
}

/**
 * Retrieve QueryDefinition (SQL Query Activity) objects
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of query objects
 */
export async function retrieveQueryDefinitions(logger = null, includeQueryText = false) {
  // Valid QueryDefinition properties (SFMC SOAP API)
  // NOTE: QueryText is excluded from bulk retrieval by default as it can cause SFMC to return
  // HTML error pages instead of SOAP responses when there's a lot of data.
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description',
    'TargetType', 'TargetUpdateType', 'CategoryID'
  ];

  if (includeQueryText) {
    properties.push('QueryText');
  }

  return retrieve('QueryDefinition', properties, null, logger);
}

/**
 * Retrieve QueryText for specific queries by ObjectID
 * Use this to load SQL for specific queries after initial bulk load
 * @param {string[]} objectIds - Array of query ObjectIDs to fetch
 * @param {object} logger - Logger instance
 * @returns {Promise<Map<string, string>>} Map of ObjectID -> QueryText
 */
export async function retrieveQueryTexts(objectIds, logger = null, concurrency = 10) {
  if (!objectIds || objectIds.length === 0) {
    return new Map();
  }

  const results = new Map();

  // Process in parallel with controlled concurrency
  // This is much faster than sequential but still avoids overwhelming the API
  const fetchQueryText = async (objectId) => {
    const filter = buildSimpleFilter('ObjectID', 'equals', objectId);

    try {
      const queries = await retrieve(
        'QueryDefinition',
        ['ObjectID', 'QueryText'],
        filter,
        null // Don't pass logger to avoid flooding logs
      );

      for (const q of queries) {
        if (q.ObjectID && q.QueryText) {
          results.set(q.ObjectID, q.QueryText);
        }
      }
    } catch (err) {
      // Silently skip failures - some queries may not have text or may be inaccessible
    }
  };

  // Process in chunks with concurrency limit
  for (let i = 0; i < objectIds.length; i += concurrency) {
    const chunk = objectIds.slice(i, i + concurrency);
    await Promise.all(chunk.map(fetchQueryText));

    // Brief pause between chunks to be gentle on the API
    if (i + concurrency < objectIds.length) {
      await sleep(100);
    }
  }

  return results;
}

/**
 * Retrieve ImportDefinition objects
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of import definition objects
 */
export async function retrieveImportDefinitions(logger = null) {
  // Valid ImportDefinition properties (SFMC SOAP API)
  // DestinationObject.ObjectID returns the DE's ObjectID
  const properties = [
    'ObjectID', 'CustomerKey', 'Name', 'Description',
    'DestinationObject.ObjectID',
    'UpdateType', 'FileSpec', 'FieldMappingType', 'FileType'
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

/**
 * Delete a Query Activity (QueryDefinition) by ObjectID
 * @param {string} objectId - The ObjectID of the query to delete
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteQueryActivity(objectId, logger = null) {
  return deleteObjects('QueryDefinition', [{ ObjectID: objectId }], logger);
}

/**
 * Create a Query Activity (QueryDefinition)
 * @param {object} queryData - Query data
 * @param {string} queryData.Name - Query name
 * @param {string} queryData.CustomerKey - Customer key (optional, defaults to Name)
 * @param {string} queryData.QueryText - SQL query text
 * @param {string} queryData.TargetType - Target type (DE)
 * @param {string} queryData.TargetUpdateType - Update type (Overwrite, Update, Append)
 * @param {string} queryData.CategoryID - Folder category ID
 * @param {string} queryData.DataExtensionTargetKey - Target DE CustomerKey (optional)
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Create result with success flag and objectId
 */
export async function createQueryActivity(queryData, logger = null) {
  const {
    Name,
    CustomerKey = Name,
    QueryText,
    TargetType = 'DE',
    TargetUpdateType = 'Overwrite',
    CategoryID,
    DataExtensionTargetKey
  } = queryData;

  if (!Name || !QueryText) {
    return { success: false, error: 'Name and QueryText are required' };
  }

  // Build target DE reference if provided
  let targetDeXml = '';
  if (DataExtensionTargetKey) {
    targetDeXml = `
      <DataExtensionTarget>
        <CustomerKey>${escapeXml(DataExtensionTargetKey)}</CustomerKey>
      </DataExtensionTarget>`;
  }

  // Build category reference if provided
  let categoryXml = '';
  if (CategoryID) {
    categoryXml = `<CategoryID>${escapeXml(String(CategoryID))}</CategoryID>`;
  }

  const soapBody = `
    <CreateRequest xmlns="${NAMESPACES.et}">
      <Objects xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="QueryDefinition">
        <Name>${escapeXml(Name)}</Name>
        <CustomerKey>${escapeXml(CustomerKey)}</CustomerKey>
        <QueryText>${escapeXml(QueryText)}</QueryText>
        <TargetType>${escapeXml(TargetType)}</TargetType>
        <TargetUpdateType>${escapeXml(TargetUpdateType)}</TargetUpdateType>
        ${categoryXml}
        ${targetDeXml}
      </Objects>
    </CreateRequest>`;

  try {
    const body = await makeSoapRequest(soapBody, logger, 0, 'Create');

    if (logger) {
      logger.debug(`Create response body: ${JSON.stringify(body)}`);
    }

    const response = body.CreateResponse;

    if (!response) {
      return { success: false, error: 'Invalid SOAP response: missing CreateResponse' };
    }

    // Parse results
    const results = Array.isArray(response.Results) ? response.Results : [response.Results];
    const result = results[0];

    if (result.StatusCode === 'OK') {
      return {
        success: true,
        objectId: result.NewObjectID || result.Object?.ObjectID,
        statusCode: result.StatusCode
      };
    } else {
      return {
        success: false,
        error: result.StatusMessage || `StatusCode: ${result.StatusCode}`,
        statusCode: result.StatusCode
      };
    }
  } catch (error) {
    if (logger) {
      logger.error(`Create QueryDefinition failed: ${error.message}`);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Create a Data Extension
 * @param {object} deData - Data Extension data
 * @param {string} deData.Name - DE name
 * @param {string} deData.CustomerKey - Customer key
 * @param {string} deData.Description - Description (optional)
 * @param {number} deData.CategoryID - Folder category ID
 * @param {boolean} deData.IsSendable - Whether DE is sendable
 * @param {boolean} deData.IsTestable - Whether DE is testable
 * @param {object} deData.SendableSubscriberField - Sendable subscriber field (optional)
 * @param {object} deData.SendableDataExtensionField - Sendable DE field (optional)
 * @param {array} deData.Fields - Array of field definitions
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Create result with success flag and objectId
 */
export async function createDataExtension(deData, logger = null) {
  const {
    Name,
    CustomerKey,
    Description = '',
    CategoryID,
    IsSendable = false,
    IsTestable = false,
    SendableSubscriberField = null,
    SendableDataExtensionField = null,
    Fields = []
  } = deData;

  if (!Name || !CustomerKey) {
    return { success: false, error: 'Name and CustomerKey are required' };
  }

  if (!Fields || Fields.length === 0) {
    return { success: false, error: 'At least one field is required' };
  }

  // Determine if we can actually make this sendable
  // A sendable DE requires both SendableSubscriberField and SendableDataExtensionField
  const canBeSendable = IsSendable && SendableSubscriberField && SendableDataExtensionField;
  const actualIsSendable = canBeSendable;

  if (logger && IsSendable && !canBeSendable) {
    logger.debug(`DE "${Name}" marked as sendable but missing sendable field config - creating as non-sendable`);
  }

  // Build fields XML - fields should be wrapped in <Fields><Field>...</Field></Fields>
  const fieldElements = Fields.map((field) => {
    const parts = [];
    parts.push('<Field>');
    parts.push(`<Name>${escapeXml(field.name)}</Name>`);
    parts.push(`<FieldType>${escapeXml(field.fieldType)}</FieldType>`);

    if (field.isPrimaryKey) {
      parts.push('<IsPrimaryKey>true</IsPrimaryKey>');
    }
    if (field.isRequired) {
      parts.push('<IsRequired>true</IsRequired>');
    }
    if (field.maxLength !== null && field.maxLength !== undefined) {
      parts.push(`<MaxLength>${field.maxLength}</MaxLength>`);
    }
    if (field.scale !== null && field.scale !== undefined && field.scale > 0) {
      parts.push(`<Scale>${field.scale}</Scale>`);
    }
    if (field.defaultValue !== null && field.defaultValue !== undefined) {
      parts.push(`<DefaultValue>${escapeXml(String(field.defaultValue))}</DefaultValue>`);
    }

    parts.push('</Field>');
    return parts.join('');
  }).join('\n          ');

  const fieldsXml = `<Fields>\n          ${fieldElements}\n        </Fields>`;

  if (logger) {
    logger.debug(`Building DE with ${Fields.length} fields`);
  }

  // Build sendable fields if applicable
  let sendableXml = '';
  if (actualIsSendable) {
    const subscriberFieldName = typeof SendableSubscriberField === 'string'
      ? SendableSubscriberField
      : (SendableSubscriberField.Name || SendableSubscriberField.name || 'Subscriber Key');
    const deFieldName = typeof SendableDataExtensionField === 'string'
      ? SendableDataExtensionField
      : (SendableDataExtensionField.Name || SendableDataExtensionField.name);

    sendableXml = `
        <SendableSubscriberField>
          <Name>${escapeXml(subscriberFieldName)}</Name>
        </SendableSubscriberField>
        <SendableDataExtensionField>
          <Name>${escapeXml(deFieldName)}</Name>
        </SendableDataExtensionField>`;
  }

  // Build category reference if provided
  let categoryXml = '';
  if (CategoryID) {
    categoryXml = `<CategoryID>${escapeXml(String(CategoryID))}</CategoryID>`;
  }

  const soapBody = `
    <CreateRequest xmlns="${NAMESPACES.et}">
      <Objects xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="DataExtension">
        <Name>${escapeXml(Name)}</Name>
        <CustomerKey>${escapeXml(CustomerKey)}</CustomerKey>
        <Description>${escapeXml(Description)}</Description>
        ${categoryXml}
        <IsSendable>${actualIsSendable}</IsSendable>
        <IsTestable>${IsTestable}</IsTestable>
        ${sendableXml}
        ${fieldsXml}
      </Objects>
    </CreateRequest>`;

  if (logger) {
    // Log first 2000 chars of soap body for debugging
    logger.debug(`SOAP Body (first 2000 chars): ${soapBody.substring(0, 2000)}`);
  }

  try {
    const body = await makeSoapRequest(soapBody, logger, 0, 'Create');

    if (logger) {
      logger.debug(`Create DE response body: ${JSON.stringify(body)}`);
    }

    const response = body.CreateResponse;

    if (!response) {
      return { success: false, error: 'Invalid SOAP response: missing CreateResponse' };
    }

    // Parse results
    const results = Array.isArray(response.Results) ? response.Results : [response.Results];
    const result = results[0];

    if (result.StatusCode === 'OK') {
      return {
        success: true,
        objectId: result.NewObjectID || result.Object?.ObjectID,
        statusCode: result.StatusCode
      };
    } else {
      return {
        success: false,
        error: result.StatusMessage || `StatusCode: ${result.StatusCode}`,
        statusCode: result.StatusCode
      };
    }
  } catch (error) {
    if (logger) {
      logger.error(`Create DataExtension failed: ${error.message}`);
    }
    return { success: false, error: error.message };
  }
}

export default {
  retrieve,
  deleteObjects,
  retrieveFolders,
  retrieveDataExtensions,
  retrieveDataExtensionFields,
  retrieveTriggeredSendDefinitions,
  retrieveQueryDefinitions,
  retrieveQueryTexts,
  retrieveImportDefinitions,
  deleteDataExtension,
  deleteFolder,
  deleteQueryActivity,
  createQueryActivity,
  createDataExtension,
  buildSimpleFilter,
  buildComplexFilter
};
