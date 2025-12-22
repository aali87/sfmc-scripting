/**
 * Data Extension Service
 * Operations for working with SFMC Data Extensions
 */

import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import {
  retrieveDataExtensions,
  retrieveDataExtensionFields,
  deleteDataExtension as soapDeleteDataExtension,
  buildSimpleFilter
} from './sfmc-soap.js';
import { getDataExtensionRowCount } from './sfmc-rest.js';
import { isDeProtected } from '../config/index.js';
import config from '../config/index.js';

// PII field name patterns (common patterns for identifying PII)
const PII_PATTERNS = [
  /email/i,
  /e-mail/i,
  /firstname/i,
  /first_name/i,
  /lastname/i,
  /last_name/i,
  /phone/i,
  /mobile/i,
  /cell/i,
  /address/i,
  /street/i,
  /city/i,
  /postal/i,
  /zip/i,
  /ssn/i,
  /social.*security/i,
  /date.*birth/i,
  /dob/i,
  /birthdate/i,
  /credit.*card/i,
  /card.*number/i,
  /passport/i,
  /driver.*license/i,
  /salary/i,
  /income/i,
  /sin/i, // Canadian Social Insurance Number
  /nin/i, // UK National Insurance Number
  /_pii$/i,
  /^pii_/i,
  /personal/i
];

/**
 * Check if a field name appears to be PII
 * @param {string} fieldName - Field name to check
 * @returns {boolean} True if field appears to be PII
 */
function isPiiField(fieldName) {
  return PII_PATTERNS.some(pattern => pattern.test(fieldName));
}

/**
 * Normalize DE object from SOAP response
 * @param {object} de - Raw DE object
 * @returns {object} Normalized DE object
 */
function normalizeDataExtension(de) {
  return {
    objectId: de.ObjectID,
    customerKey: de.CustomerKey,
    name: de.Name,
    description: de.Description || '',
    folderId: parseInt(de.CategoryID, 10),
    isSendable: de.IsSendable === 'true',
    isTestable: de.IsTestable === 'true',
    status: de.Status,
    createdDate: de.CreatedDate,
    modifiedDate: de.ModifiedDate,
    sendableSubscriberField: de['SendableSubscriberField.Name'] || null,
    sendableDataExtensionField: de['SendableDataExtensionField.Name'] || null,
    templateKey: de['Template.CustomerKey'] || null,
    retainUntil: de.RetainUntil || null,
    dataRetentionPeriodLength: de.DataRetentionPeriodLength || null,
    dataRetentionPeriodUnit: de.DataRetentionPeriodUnitOfMeasure || null,
    rowBasedRetention: de.RowBasedRetention === 'true',
    resetRetentionOnImport: de.ResetRetentionPeriodOnImport === 'true',
    deleteAtEndOfRetention: de.DeleteAtEndOfRetentionPeriod === 'true',
    isProtected: isDeProtected(de.CustomerKey) || isDeProtected(de.Name)
  };
}

/**
 * Get all Data Extensions in a specific folder
 * @param {number} folderId - Folder CategoryID
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of DE objects
 */
export async function getDataExtensionsInFolder(folderId, logger = null) {
  const filter = buildSimpleFilter('CategoryID', 'equals', folderId.toString());
  const dataExtensions = await retrieveDataExtensions(filter, logger);

  return dataExtensions.map(normalizeDataExtension);
}

/**
 * Get Data Extension details by CustomerKey
 * @param {string} customerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} DE object or null
 */
export async function getDataExtensionDetails(customerKey, logger = null) {
  const filter = buildSimpleFilter('CustomerKey', 'equals', customerKey);
  const dataExtensions = await retrieveDataExtensions(filter, logger);

  if (dataExtensions.length === 0) {
    return null;
  }

  return normalizeDataExtension(dataExtensions[0]);
}

/**
 * Get field schema for a Data Extension
 * @param {string} customerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of field objects
 */
export async function getDataExtensionSchema(customerKey, logger = null) {
  const fields = await retrieveDataExtensionFields(customerKey, logger);

  return fields.map(f => ({
    objectId: f.ObjectID,
    customerKey: f.CustomerKey,
    name: f.Name,
    fieldType: f.FieldType,
    defaultValue: f.DefaultValue || null,
    isPrimaryKey: f.IsPrimaryKey === 'true',
    isRequired: f.IsRequired === 'true',
    maxLength: f.MaxLength ? parseInt(f.MaxLength, 10) : null,
    scale: f.Scale ? parseInt(f.Scale, 10) : null,
    ordinal: f.Ordinal ? parseInt(f.Ordinal, 10) : 0,
    isPii: isPiiField(f.Name)
  })).sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Get row count for a Data Extension
 * @param {string} customerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<number|null>} Row count or null if unavailable
 */
export async function getRowCount(customerKey, logger = null) {
  return getDataExtensionRowCount(customerKey, logger);
}

/**
 * Get detailed information about a DE including fields and row count
 * @param {string} customerKey - DE CustomerKey
 * @param {boolean} includeRowCount - Whether to fetch row count
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Full DE details or null
 */
export async function getFullDataExtensionDetails(customerKey, includeRowCount = true, logger = null) {
  const de = await getDataExtensionDetails(customerKey, logger);

  if (!de) {
    return null;
  }

  // Get fields
  const fields = await getDataExtensionSchema(customerKey, logger);
  de.fields = fields;

  // Identify PII fields
  de.piiFields = fields.filter(f => f.isPii).map(f => f.name);
  de.hasPii = de.piiFields.length > 0;

  // Get row count if requested
  if (includeRowCount) {
    de.rowCount = await getRowCount(customerKey, logger);
  }

  return de;
}

/**
 * Delete a Data Extension
 * @param {string} customerKey - DE CustomerKey
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteDataExtension(customerKey, logger = null) {
  // Check protection
  if (isDeProtected(customerKey)) {
    return {
      success: false,
      error: `Data Extension "${customerKey}" is protected and cannot be deleted`
    };
  }

  try {
    const result = await soapDeleteDataExtension(customerKey, logger);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Backup DE schema to JSON file
 * @param {string} customerKey - DE CustomerKey
 * @param {string} outputDir - Output directory path
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Backup result with file path
 */
export async function backupDataExtensionSchema(customerKey, outputDir, logger = null) {
  // Get full DE details
  const de = await getFullDataExtensionDetails(customerKey, true, logger);

  if (!de) {
    return {
      success: false,
      error: `Data Extension "${customerKey}" not found`
    };
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create backup object
  const backup = {
    backupMetadata: {
      createdAt: new Date().toISOString(),
      toolVersion: config.version,
      businessUnit: config.sfmc.accountId
    },
    dataExtension: {
      customerKey: de.customerKey,
      name: de.name,
      description: de.description,
      folderId: de.folderId,
      isSendable: de.isSendable,
      isTestable: de.isTestable,
      sendableSubscriberField: de.sendableSubscriberField,
      sendableDataExtensionField: de.sendableDataExtensionField,
      templateKey: de.templateKey,
      retainUntil: de.retainUntil,
      dataRetentionPeriodLength: de.dataRetentionPeriodLength,
      dataRetentionPeriodUnit: de.dataRetentionPeriodUnit,
      rowBasedRetention: de.rowBasedRetention,
      resetRetentionOnImport: de.resetRetentionOnImport,
      deleteAtEndOfRetention: de.deleteAtEndOfRetention
    },
    fields: de.fields.map(f => ({
      name: f.name,
      fieldType: f.fieldType,
      defaultValue: f.defaultValue,
      isPrimaryKey: f.isPrimaryKey,
      isRequired: f.isRequired,
      maxLength: f.maxLength,
      scale: f.scale,
      ordinal: f.ordinal
    })),
    rowCountAtBackup: de.rowCount
  };

  // Write to file
  const safeFilename = customerKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(outputDir, `${safeFilename}.json`);

  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));

  if (logger) {
    logger.debug(`Schema backed up to ${filePath}`);
  }

  return {
    success: true,
    filePath,
    rowCount: de.rowCount
  };
}

/**
 * Generate undo script for recreating deleted DEs
 * @param {object[]} dataExtensions - Array of DE details with fields
 * @param {string} outputDir - Output directory path
 * @returns {string} Path to undo script
 */
export function generateUndoScript(dataExtensions, outputDir) {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const scriptPath = path.join(outputDir, `undo-${timestamp}.js`);

  const scriptContent = `/**
 * UNDO SCRIPT - Recreate Deleted Data Extensions
 * Generated: ${new Date().toISOString()}
 *
 * WARNING: This script recreates the DATA EXTENSION STRUCTURE only.
 * The actual DATA cannot be recovered.
 *
 * Usage:
 * 1. Review the Data Extensions to recreate
 * 2. Run: node ${path.basename(scriptPath)}
 */

import { createDataExtension } from './src/lib/sfmc-soap.js'; // You may need to implement this

const dataExtensionsToRecreate = ${JSON.stringify(dataExtensions.map(de => ({
  name: de.name,
  customerKey: de.customerKey,
  description: de.description,
  folderId: de.folderId,
  isSendable: de.isSendable,
  fields: de.fields ? de.fields.map(f => ({
    name: f.name,
    fieldType: f.fieldType,
    maxLength: f.maxLength,
    isPrimaryKey: f.isPrimaryKey,
    isRequired: f.isRequired,
    defaultValue: f.defaultValue
  })) : []
})), null, 2)};

console.log('Data Extensions to recreate:', dataExtensionsToRecreate.length);
console.log('\\nNOTE: This is a template script. Implement createDataExtension function to use.');
console.log('\\nData Extensions:');
dataExtensionsToRecreate.forEach((de, i) => {
  console.log(\`  \${i + 1}. \${de.name} (Folder ID: \${de.folderId})\`);
});
`;

  fs.writeFileSync(scriptPath, scriptContent);

  return scriptPath;
}

/**
 * Filter DEs by date criteria
 * @param {object[]} dataExtensions - Array of DE objects
 * @param {object} filters - Filter criteria
 * @returns {object[]} Filtered DEs
 */
export function filterByDate(dataExtensions, filters = {}) {
  return dataExtensions.filter(de => {
    const createdDate = de.createdDate ? dayjs(de.createdDate) : null;
    const modifiedDate = de.modifiedDate ? dayjs(de.modifiedDate) : null;

    // Created before
    if (filters.createdBefore) {
      const threshold = dayjs(filters.createdBefore);
      if (!createdDate || createdDate.isAfter(threshold)) {
        return false;
      }
    }

    // Created after
    if (filters.createdAfter) {
      const threshold = dayjs(filters.createdAfter);
      if (!createdDate || createdDate.isBefore(threshold)) {
        return false;
      }
    }

    // Modified before
    if (filters.modifiedBefore) {
      const threshold = dayjs(filters.modifiedBefore);
      if (!modifiedDate || modifiedDate.isAfter(threshold)) {
        return false;
      }
    }

    // Modified after
    if (filters.modifiedAfter) {
      const threshold = dayjs(filters.modifiedAfter);
      if (!modifiedDate || modifiedDate.isBefore(threshold)) {
        return false;
      }
    }

    // Last modified days (not modified in X days)
    if (filters.lastModifiedDays) {
      const threshold = dayjs().subtract(filters.lastModifiedDays, 'day');
      if (modifiedDate && modifiedDate.isAfter(threshold)) {
        return false;
      }
    }

    // Older than days (not modified in X days)
    if (filters.olderThanDays) {
      const threshold = dayjs().subtract(filters.olderThanDays, 'day');
      if (modifiedDate && modifiedDate.isAfter(threshold)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Filter DEs by name pattern
 * @param {object[]} dataExtensions - Array of DE objects
 * @param {object} patterns - Pattern criteria
 * @returns {object[]} Filtered DEs
 */
export function filterByPattern(dataExtensions, patterns = {}) {
  return dataExtensions.filter(de => {
    // Exclude pattern
    if (patterns.exclude) {
      const excludeRegex = new RegExp(patterns.exclude, 'i');
      if (excludeRegex.test(de.name) || excludeRegex.test(de.customerKey)) {
        return false;
      }
    }

    // Include pattern (if set, must match)
    if (patterns.include) {
      const includeRegex = new RegExp(patterns.include, 'i');
      if (!includeRegex.test(de.name) && !includeRegex.test(de.customerKey)) {
        return false;
      }
    }

    return true;
  });
}

export default {
  getDataExtensionsInFolder,
  getDataExtensionDetails,
  getDataExtensionSchema,
  getRowCount,
  getFullDataExtensionDetails,
  deleteDataExtension,
  backupDataExtensionSchema,
  generateUndoScript,
  filterByDate,
  filterByPattern
};
