# SFMC DE Toolkit - Claude Code Context

## Project Summary

A Node.js CLI toolkit for Salesforce Marketing Cloud (SFMC) Data Extension management. Provides safe auditing, dependency analysis, and deletion of DEs, Query Activities, Automations, and Folders.

## Quick Start Commands

```bash
# Test connection
node src/index.js test

# Audit a folder (read-only)
node src/scripts/audit-folder.js --folder "Data Extensions/Archive"

# Preview DE deletion (dry-run)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive"

# Delete with confirmation
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --confirm
```

## Key Architecture Points

### Module Organization

| Directory | Purpose |
|-----------|---------|
| `src/index.js` | CLI entry point using yargs |
| `src/config/` | Environment config, validation, protected patterns |
| `src/lib/` | Core services (auth, REST/SOAP clients, caching) |
| `src/scripts/` | CLI command implementations |

### Core Services

- **utils.js** - Shared utilities (sleep, error handling, retry config, cache config)
- **sfmc-auth.js** - OAuth 2.0 token management with caching
- **sfmc-rest.js** - REST API client (Automations, Journeys, Filters)
- **sfmc-soap.js** - SOAP API client (DEs, Folders, Queries, Imports)
- **folder-service.js** - Folder hierarchy with multi-level caching
- **data-extension-service.js** - DE operations (CRUD, schema, filtering)
- **dependency-analyzer.js** - Smart dependency detection & classification
- **bulk-data-loader.js** - Efficient metadata loading for analysis
- **cache.js** - File-based cache with process locking
- **logger.js** - Winston logging + audit trails + state persistence

### Data Flow

1. CLI parses args, spawns script as child process
2. Script validates config, tests connection
3. Loads folder cache or fetches from SFMC
4. Operations performed with safety checks
5. Results logged, audit trail created

### Safety Features

- **Dry-run by default** - Use `--confirm` for actual deletions
- **Protected patterns** - System folders/DEs automatically protected
- **Dependency checking** - Analyzes references before deletion
- **Multi-step confirmation** - Type phrase to confirm destructive actions
- **Automatic backups** - Schema backups before deletion
- **Resumable operations** - State persistence for interruption recovery

## Code Style & Patterns

### ES Modules

All files use ES modules (`import`/`export`):

```javascript
import config from '../config/index.js';
import { getAccessToken } from './sfmc-auth.js';
export async function myFunction() { ... }
export default { myFunction };
```

### Logger Pattern

Logger is optional, passed to functions:

```javascript
export async function myFunction(params, logger = null) {
  if (logger) logger.info('Starting operation');
  if (logger) logger.debug('Debug details', { data });
  if (logger) logger.api('GET', '/endpoint', { params });
}
```

### Error Handling

Retry with exponential backoff for transient errors (uses shared utils):

```javascript
import { sleep, isRetryableError, calculateBackoffDelay, RETRY_CONFIG } from './utils.js';

const { MAX_RETRIES } = RETRY_CONFIG;

async function makeRequest(endpoint, retryCount = 0) {
  try {
    return await apiCall(endpoint);
  } catch (error) {
    if (isRetryableError(error) && retryCount < MAX_RETRIES) {
      await sleep(calculateBackoffDelay(retryCount));
      return makeRequest(endpoint, retryCount + 1);
    }
    throw error;
  }
}
```

### SOAP XML Building

XML built as strings with escaping:

```javascript
function buildSoapEnvelope(accessToken, bodyContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="..." xmlns:et="...">
  <soapenv:Header>
    <fueloauth xmlns="...">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>${bodyContent}</soapenv:Body>
</soapenv:Envelope>`;
}
```

### Caching Pattern

Multi-level cache with file locking:

```javascript
// L1: In-memory (Map)
// L2: File cache (24h TTL)
// L3: API call

async function getData() {
  if (memoryCache.has(key)) return memoryCache.get(key);
  const cached = await readCache(type, accountId);
  if (cached && !isExpired(cached)) return cached.data;
  const fresh = await fetchFromApi();
  await writeCache(type, accountId, fresh);
  return fresh;
}
```

## Common Development Tasks

### Adding a New Script

1. Create `src/scripts/my-script.js`
2. Add yargs command in `src/index.js`
3. Use existing services from `src/lib/`
4. Follow logging/audit patterns

### Adding a New API Endpoint

REST:
```javascript
// In src/lib/sfmc-rest.js
export async function getNewThing(id, logger = null) {
  return makeRequest('get', `/api/v1/things/${id}`, null, null, logger);
}
```

SOAP:
```javascript
// In src/lib/sfmc-soap.js
export async function retrieveNewObject(logger = null) {
  const properties = ['ID', 'Name', 'Property'];
  return retrieve('ObjectType', properties, null, logger);
}
```

### Modifying Protected Patterns

Edit `src/config/index.js`:

```javascript
protectedFolderPatterns: parseCommaSeparated(
  process.env.PROTECTED_FOLDER_PATTERNS,
  ['System', 'CASL', 'Platform', ...]  // Add patterns here
),
protectedDePrefixes: parseCommaSeparated(
  process.env.PROTECTED_DE_PREFIXES,
  ['SYS_', 'CASL_', ...]  // Add prefixes here
)
```

## Testing & Debugging

### Debug Scripts

```bash
# Test SOAP connectivity
node src/scripts/debug-soap.js

# Test dependency detection for single DE
node src/scripts/debug-de-dependencies.js "DE_CustomerKey"

# Inspect automation details
node src/scripts/debug-automation.js "Automation Name"

# Inspect filter activity
node src/scripts/debug-filter.js "FilterId"
```

### Enable Debug Logging

```bash
LOG_LEVEL=debug node src/scripts/audit-folder.js --folder "Archive"
```

### Check Cache Status

```bash
node src/index.js sync --status
node src/index.js sync --clear  # Clear cache
```

## Key Files to Know

| File | Purpose | When to Modify |
|------|---------|----------------|
| `src/config/index.js` | All configuration | Add env vars, safety patterns |
| `src/lib/utils.js` | Shared utilities | Add common helpers, constants |
| `src/lib/sfmc-auth.js` | OAuth tokens | Auth changes |
| `src/lib/sfmc-rest.js` | REST API calls | Add REST endpoints |
| `src/lib/sfmc-soap.js` | SOAP API calls | Add SOAP operations |
| `src/lib/data-extension-service.js` | DE operations | CRUD, schema, filtering |
| `src/lib/dependency-analyzer.js` | Dependency logic | Change classification rules |
| `src/lib/bulk-data-loader.js` | Metadata loading | Add data types to load |
| `src/scripts/delete-data-extensions.js` | Main delete workflow | Modify deletion behavior |

## SFMC API Notes

### REST vs SOAP

| Use REST For | Use SOAP For |
|--------------|--------------|
| Automations | Data Extensions |
| Journeys | Folders |
| Filter Activities | Query Definitions |
| Data Extracts | Import Definitions |
| Row counts | Triggered Sends |

### Common SOAP Object Types

- `DataExtension` - DE metadata
- `DataExtensionField` - DE fields
- `DataFolder` - Folders (all types)
- `QueryDefinition` - SQL Query Activities
- `ImportDefinition` - Import Activities
- `TriggeredSendDefinition` - Triggered Sends

### Rate Limiting

- Default 200ms delay between API calls
- Automatic retry with exponential backoff
- 24-hour cache for bulk metadata

## Dependencies

| Package | Purpose |
|---------|---------|
| axios | HTTP requests |
| xml2js | XML parsing |
| winston | Logging |
| yargs | CLI parsing |
| chalk | Terminal colors |
| ora | Spinners |
| inquirer | Interactive prompts |
| dayjs | Date handling |
| dotenv | Environment config |
