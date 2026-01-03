/**
 * Folder Service
 * Operations for working with SFMC Data Extension folders
 * Supports persistent file-based caching to reduce API calls
 */

import {
  retrieveFolders,
  deleteFolder as soapDeleteFolder,
  buildSimpleFilter
} from './sfmc-soap.js';
import { isFolderProtected } from '../config/index.js';
import { readCache, writeCache, clearCache, getCacheInfo } from './cache.js';
import config from '../config/index.js';
import { CACHE_CONFIG } from './utils.js';

// Cache type identifier
const FOLDER_CACHE_TYPE = 'folders';

// Use shared cache expiry constant
const DEFAULT_CACHE_EXPIRY_MS = CACHE_CONFIG.DEFAULT_EXPIRY_MS;

// In-memory cache for current session (faster than file reads)
let memoryCache = {
  folders: null,
  loadedAt: null
};

/**
 * Clear both in-memory and file-based cache
 * @param {object} logger - Logger instance
 * @returns {Promise<boolean>} True if cleared
 */
export async function clearFolderCache(logger = null) {
  memoryCache = { folders: null, loadedAt: null };
  const cleared = await clearCache(FOLDER_CACHE_TYPE, config.sfmc.accountId);
  if (logger && cleared) {
    logger.info('Folder cache cleared');
  }
  return cleared;
}

/**
 * Get cache status information
 * @returns {Promise<object>} Cache info
 */
export async function getFolderCacheStatus() {
  return getCacheInfo(FOLDER_CACHE_TYPE, config.sfmc.accountId);
}

/**
 * Load all folders (with persistent file caching)
 * @param {object} logger - Logger instance
 * @param {boolean} forceRefresh - Force cache refresh (--refresh-cache flag)
 * @returns {Promise<object[]>} Array of folder objects
 */
async function loadAllFolders(logger = null, forceRefresh = false) {
  const now = Date.now();
  const accountId = config.sfmc.accountId;

  // Check in-memory cache first (fastest)
  if (!forceRefresh && memoryCache.folders && memoryCache.loadedAt) {
    if (logger) {
      logger.debug('Using in-memory folder cache');
    }
    return memoryCache.folders;
  }

  // Check file cache (unless force refresh)
  if (!forceRefresh) {
    const cached = await readCache(FOLDER_CACHE_TYPE, accountId, {
      maxAgeMs: DEFAULT_CACHE_EXPIRY_MS,
      ignoreExpiry: false
    });

    if (cached && cached.data) {
      const info = await getCacheInfo(FOLDER_CACHE_TYPE, accountId);
      if (logger) {
        logger.info(`Using cached folder data (${info.ageString}, ${cached.data.length} folders)`);
      }

      // Store in memory cache for this session
      memoryCache = {
        folders: cached.data,
        loadedAt: now
      };

      return cached.data;
    }
  }

  // Fetch from SFMC API
  if (logger) {
    logger.info('Fetching folder structure from SFMC API (this may take a moment)...');
  }

  // Filter to only get dataextension content type folders
  const filter = buildSimpleFilter('ContentType', 'equals', 'dataextension');
  const folders = await retrieveFolders(filter, logger);

  // Normalize folder data
  const normalizedFolders = folders.map(f => ({
    id: parseInt(f.ID, 10),
    name: f.Name,
    description: f.Description || '',
    contentType: f.ContentType,
    parentFolderId: f.ParentFolder?.ID ? parseInt(f.ParentFolder.ID, 10) : null,
    parentFolderName: f.ParentFolder?.Name || null,
    customerKey: f.CustomerKey,
    isActive: f.IsActive === 'true',
    isEditable: f.IsEditable === 'true',
    allowChildren: f.AllowChildren === 'true',
    createdDate: f.CreatedDate,
    modifiedDate: f.ModifiedDate,
    objectId: f.ObjectID,
    isProtected: isFolderProtected(f.Name)
  }));

  // Save to file cache
  await writeCache(FOLDER_CACHE_TYPE, accountId, normalizedFolders, {
    folderCount: normalizedFolders.length
  });

  // Update in-memory cache
  memoryCache = {
    folders: normalizedFolders,
    loadedAt: now
  };

  if (logger) {
    logger.info(`Cached ${normalizedFolders.length} folders (cache will be used for future operations)`);
  }

  return normalizedFolders;
}

/**
 * Build folder path by traversing parent folders
 * @param {number} folderId - Folder ID
 * @param {object[]} allFolders - All folders array
 * @returns {string} Full folder path
 */
function buildFolderPath(folderId, allFolders) {
  const pathParts = [];
  let currentId = folderId;

  while (currentId) {
    const folder = allFolders.find(f => f.id === currentId);
    if (!folder) break;

    pathParts.unshift(folder.name);
    currentId = folder.parentFolderId;
  }

  return pathParts.join('/');
}

/**
 * Find folder by path (e.g., "Shared Data Extensions/Archive/Old")
 * @param {string} path - Folder path (forward-slash separated)
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Folder object or null if not found
 */
export async function getFolderByPath(path, logger = null) {
  const allFolders = await loadAllFolders(logger);

  // Normalize path
  const pathParts = path.split('/').map(p => p.trim()).filter(Boolean);

  if (pathParts.length === 0) {
    throw new Error('Empty folder path provided');
  }

  // Find matching folder by traversing the path
  let currentParentId = null;

  for (let i = 0; i < pathParts.length; i++) {
    const partName = pathParts[i].toLowerCase();

    const matches = allFolders.filter(f => {
      const nameMatch = f.name.toLowerCase() === partName;
      const parentMatch = currentParentId === null ?
        f.parentFolderId === null || f.parentFolderId === 0 :
        f.parentFolderId === currentParentId;
      return nameMatch && parentMatch;
    });

    if (matches.length === 0) {
      // If this is the first part and we didn't find an exact match,
      // try finding by name only (more lenient)
      if (i === 0) {
        const looseMatch = allFolders.find(f =>
          f.name.toLowerCase() === partName
        );
        if (looseMatch) {
          currentParentId = looseMatch.id;
          continue;
        }
      }

      if (logger) {
        logger.debug(`Folder not found at path part "${pathParts[i]}"`);
      }
      return null;
    }

    currentParentId = matches[0].id;
  }

  // Get the final folder
  const folder = allFolders.find(f => f.id === currentParentId);
  if (folder) {
    folder.path = buildFolderPath(folder.id, allFolders);
  }

  return folder || null;
}

/**
 * Find folder by name (returns first match if multiple)
 * @param {string} name - Folder name
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Folder object or null
 */
export async function getFolderByName(name, logger = null) {
  const allFolders = await loadAllFolders(logger);
  const folder = allFolders.find(f => f.name.toLowerCase() === name.toLowerCase());

  if (folder) {
    folder.path = buildFolderPath(folder.id, allFolders);
  }

  return folder || null;
}

/**
 * Get folder by ID
 * @param {number} folderId - Folder CategoryID
 * @param {object} logger - Logger instance
 * @returns {Promise<object|null>} Folder object or null
 */
export async function getFolderById(folderId, logger = null) {
  const allFolders = await loadAllFolders(logger);
  const folder = allFolders.find(f => f.id === folderId);

  if (folder) {
    folder.path = buildFolderPath(folder.id, allFolders);
  }

  return folder || null;
}

/**
 * Get all subfolders of a parent folder
 * @param {number} parentId - Parent folder ID
 * @param {boolean} recursive - Include nested subfolders
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Array of subfolder objects
 */
export async function getSubfolders(parentId, recursive = true, logger = null) {
  const allFolders = await loadAllFolders(logger);

  // Find direct children
  const directChildren = allFolders.filter(f => f.parentFolderId === parentId);

  if (!recursive) {
    return directChildren.map(f => ({
      ...f,
      path: buildFolderPath(f.id, allFolders)
    }));
  }

  // Recursively collect all descendants
  const collectDescendants = (parentIds) => {
    const children = allFolders.filter(f => parentIds.includes(f.parentFolderId));
    if (children.length === 0) {
      return [];
    }
    const childIds = children.map(c => c.id);
    return [...children, ...collectDescendants(childIds)];
  };

  const allDescendants = collectDescendants([parentId]);

  return allDescendants.map(f => ({
    ...f,
    path: buildFolderPath(f.id, allFolders)
  }));
}

/**
 * Build a hierarchical tree structure for display
 * @param {number} parentId - Root folder ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Tree structure
 */
export async function getFolderTree(parentId, logger = null) {
  const allFolders = await loadAllFolders(logger);
  const rootFolder = allFolders.find(f => f.id === parentId);

  if (!rootFolder) {
    return null;
  }

  const buildTree = (folderId, depth = 0) => {
    const folder = allFolders.find(f => f.id === folderId);
    if (!folder) return null;

    const children = allFolders
      .filter(f => f.parentFolderId === folderId)
      .map(f => buildTree(f.id, depth + 1))
      .filter(Boolean);

    return {
      ...folder,
      path: buildFolderPath(folder.id, allFolders),
      depth,
      children,
      hasChildren: children.length > 0
    };
  };

  return buildTree(parentId);
}

/**
 * Check if a folder is empty (no DEs or subfolders)
 * @param {number} folderId - Folder ID
 * @param {function} getDesInFolder - Function to get DEs in folder
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Empty status and contents info
 */
export async function isFolderEmpty(folderId, getDesInFolder, logger = null) {
  const subfolders = await getSubfolders(folderId, false, logger);

  // Get DEs in this folder
  const dataExtensions = await getDesInFolder(folderId, logger);

  return {
    isEmpty: subfolders.length === 0 && dataExtensions.length === 0,
    subfolderCount: subfolders.length,
    dataExtensionCount: dataExtensions.length,
    subfolders: subfolders.map(f => ({ id: f.id, name: f.name })),
    dataExtensions: dataExtensions.map(de => ({ customerKey: de.customerKey, name: de.name }))
  };
}

/**
 * Delete a single folder
 * @param {number} folderId - Folder ID to delete
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Delete result
 */
export async function deleteFolder(folderId, logger = null) {
  const folder = await getFolderById(folderId, logger);

  if (!folder) {
    return {
      success: false,
      error: 'Folder not found'
    };
  }

  if (folder.isProtected) {
    return {
      success: false,
      error: `Folder "${folder.name}" is protected and cannot be deleted`
    };
  }

  try {
    const result = await soapDeleteFolder(folderId, logger);

    if (result.success) {
      // Clear cache after successful deletion
      clearFolderCache();
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get deletion order for folders (deepest first)
 * @param {number} parentId - Root folder ID
 * @param {object} logger - Logger instance
 * @returns {Promise<object[]>} Folders in deletion order
 */
export async function getDeletionOrder(parentId, logger = null) {
  const allFolders = await loadAllFolders(logger);

  // Get all folders to delete (including parent)
  const subfolders = await getSubfolders(parentId, true, logger);
  const parentFolder = await getFolderById(parentId, logger);

  const allToDelete = parentFolder ? [...subfolders, parentFolder] : subfolders;

  // Sort by depth (deepest first)
  const calculateDepth = (folderId) => {
    let depth = 0;
    let currentId = folderId;

    while (currentId) {
      const folder = allFolders.find(f => f.id === currentId);
      if (!folder || folder.id === parentId) break;
      depth++;
      currentId = folder.parentFolderId;
    }

    return depth;
  };

  return allToDelete
    .map(f => ({
      ...f,
      deleteDepth: calculateDepth(f.id)
    }))
    .sort((a, b) => b.deleteDepth - a.deleteDepth);
}

/**
 * Find similar folder names (for suggestions when folder not found)
 * @param {string} name - Search name
 * @param {object} logger - Logger instance
 * @returns {Promise<string[]>} Similar folder names
 */
export async function findSimilarFolders(name, logger = null) {
  const allFolders = await loadAllFolders(logger);
  const searchLower = name.toLowerCase();

  // Find folders containing the search term
  const matches = allFolders
    .filter(f => f.name.toLowerCase().includes(searchLower))
    .map(f => ({
      name: f.name,
      path: buildFolderPath(f.id, allFolders)
    }))
    .slice(0, 10);

  return matches;
}

export default {
  clearFolderCache,
  getFolderCacheStatus,
  getFolderByPath,
  getFolderByName,
  getFolderById,
  getSubfolders,
  getFolderTree,
  isFolderEmpty,
  deleteFolder,
  getDeletionOrder,
  findSimilarFolders
};
