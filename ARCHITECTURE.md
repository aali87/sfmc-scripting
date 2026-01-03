# SFMC DE Toolkit - Architecture Documentation

## Overview

The SFMC DE Toolkit is a comprehensive Node.js CLI application for auditing, analyzing dependencies, and safely managing Data Extensions, Query Activities, Automations, and Folders in Salesforce Marketing Cloud (SFMC).

**Core Philosophy:** Safety-first approach with dry-run defaults, comprehensive dependency analysis, and protection of system items.

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 18+ (ES Modules) | JavaScript runtime |
| CLI Framework | yargs | Command-line argument parsing |
| HTTP Client | axios | REST API calls |
| XML Parsing | xml2js | SOAP API response handling |
| Logging | winston | Structured logging with rotation |
| UI/UX | chalk, ora, inquirer | Colors, spinners, interactive prompts |
| Date/Time | dayjs | Date manipulation |
| Configuration | dotenv | Environment variable management |

## Project Structure

```
sfmc-de-toolkit/
├── src/
│   ├── config/
│   │   └── index.js              # Environment config & validation
│   ├── lib/                       # Core libraries & services
│   │   ├── utils.js              # Shared utilities (sleep, errors, constants)
│   │   ├── sfmc-auth.js          # OAuth 2.0 token management
│   │   ├── sfmc-rest.js          # REST API client
│   │   ├── sfmc-soap.js          # SOAP API client
│   │   ├── data-extension-service.js  # DE operations
│   │   ├── folder-service.js     # Folder operations with caching
│   │   ├── dependency-analyzer.js # Smart dependency detection
│   │   ├── bulk-data-loader.js   # Efficient metadata loading
│   │   ├── cache.js              # File-based cache with locking
│   │   └── logger.js             # Winston logging + audit trails
│   ├── scripts/                   # CLI command implementations
│   │   ├── audit-folder.js       # Read-only folder audits
│   │   ├── delete-data-extensions.js  # DE deletion
│   │   ├── delete-folders.js     # Folder deletion
│   │   ├── delete-automations.js # Automation deletion
│   │   ├── restore-data-extensions.js # Restore from backups
│   │   ├── restore-queries.js    # Restore query activities
│   │   └── debug-*.js            # Debug utilities
│   └── index.js                  # Main CLI entry point
├── .env.example                  # Configuration template
├── package.json                  # Dependencies & scripts
└── README.md                     # User documentation
```

### Auto-Generated Directories

| Directory | Purpose |
|-----------|---------|
| `backup/` | DE schema backups before deletion |
| `cache/` | File-based metadata cache |
| `audit/` | Audit logs in JSON format |
| `logs/` | Operational logs |
| `state/` | Operation state for resumption |
| `undo/` | Undo scripts for recovery |

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Layer (src/index.js)                  │
│            yargs command parsing, child process spawning     │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                 Script Layer (src/scripts/)                  │
│        Command implementations, orchestration logic          │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                 Service Layer (src/lib/)                     │
│   Business logic: DE ops, folder ops, dependency analysis    │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                 API Client Layer (src/lib/)                  │
│         sfmc-auth.js, sfmc-rest.js, sfmc-soap.js            │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│            Infrastructure Layer (src/lib/, src/config/)      │
│           Config, logging, caching, state management         │
└─────────────────────────────────────────────────────────────┘
```

## Core Modules

### 0. Shared Utilities (`src/lib/utils.js`)

**Responsibility:** Common utilities shared across all modules.

**Key Exports:**
- `sleep(ms)` - Promise-based delay for rate limiting and retries
- `extractErrorMessage(error)` - Extract meaningful error messages from axios errors
- `isRetryableError(error)` - Check if an error is transient and retryable
- `calculateBackoffDelay(retryCount, baseDelay)` - Exponential backoff calculation
- `RETRY_CONFIG` - Centralized retry configuration (`MAX_RETRIES`, `RETRY_DELAY_MS`)
- `CACHE_CONFIG` - Centralized cache configuration (`DEFAULT_EXPIRY_MS`, lock settings)

**Why It Exists:** Eliminates duplicate code across REST client, SOAP client, cache module, and services. Provides a single source of truth for retry/cache behavior.

### 1. Authentication (`src/lib/sfmc-auth.js`)

**Responsibility:** OAuth 2.0 Client Credentials flow with token caching.

**Key Features:**
- Token caching with 5-minute expiry buffer
- Automatic token refresh
- Connection testing

**Token Lifecycle:**
```
Request Token → Check Cache → Valid? → Return Cached
                     ↓ (expired)
              Fetch from SFMC → Cache → Return New Token
```

### 2. REST API Client (`src/lib/sfmc-rest.js`)

**Responsibility:** REST API requests for Automations, Journeys, Filters, Data Extracts.

**Key Features:**
- Automatic retry with exponential backoff (3 retries)
- Pagination handling (500 items/page)
- Rate limiting (configurable delay)
- Retry-After header detection

**Endpoints:**
- `/automation/v1/automations` - Automation Studio
- `/interaction/v1/interactions` - Journey Builder
- `/automation/v1/filters` - Filter Activities
- `/automation/v1/dataextracts` - Data Extracts
- `/data/v1/customobjectdata/key/{key}/rowset` - Row counts

### 3. SOAP API Client (`src/lib/sfmc-soap.js`)

**Responsibility:** SOAP API requests for DEs, Folders, Queries, Imports.

**Key Features:**
- XML envelope building with fueloauth header
- SOAP Fault detection and error extraction
- Pagination via RequestID continuation
- Support for Retrieve, Create, Delete operations

**Object Types:**
- `DataExtension` - DE metadata and fields
- `DataFolder` - Folder hierarchy
- `QueryDefinition` - SQL Query Activities
- `ImportDefinition` - Import Activities
- `TriggeredSendDefinition` - Triggered Sends

### 4. Folder Service (`src/lib/folder-service.js`)

**Responsibility:** Folder hierarchy navigation with multi-level caching.

**Caching Strategy:**
```
L1: In-Memory Cache (fastest, current session)
         ↓ (miss)
L2: File-Based Cache (24-hour TTL, atomic writes)
         ↓ (miss or expired)
L3: SFMC SOAP API (slowest)
```

**Key Functions:**
- `loadAllFolders()` - Load all folders with cache
- `getFolderByPath()` - Resolve path like "Data Extensions/Archive"
- `getFolderTree()` - Get tree structure with depth control

### 5. Data Extension Service (`src/lib/data-extension-service.js`)

**Responsibility:** CRUD operations for Data Extensions.

**Key Functions:**
- `getDataExtensionsInFolder()` - Fetch DEs by folder
- `getDataExtensionSchema()` - Get field definitions
- `getRowCount()` - Row count via REST API
- `deleteDataExtension()` - Delete via SOAP
- `backupDataExtensionSchema()` - JSON backup

**Data Normalization:**
- Consistent object structure from SOAP responses
- PII field detection (email, phone, SSN patterns)
- Protected DE detection

### 6. Bulk Data Loader (`src/lib/bulk-data-loader.js`)

**Responsibility:** Efficient loading of all SFMC metadata for dependency analysis.

**Why It Exists:** Solves the N+1 API problem by bulk-loading all metadata upfront.

**Loading Pipeline:**
```
1. Check in-memory cache
2. Check file cache (24h expiry)
3. Fetch from SFMC APIs:
   - Automations list + details (parallel, 10 at a time)
   - Filter activities
   - Query activities + SQL text (parallel)
   - Import definitions
   - Triggered sends
   - Journeys
   - Data extracts
4. Build lookup Maps for O(1) access
5. Cache to file
```

### 7. Dependency Analyzer (`src/lib/dependency-analyzer.js`)

**Responsibility:** Smart dependency detection and classification.

**Classification Categories:**

| Classification | Criteria | Auto-Deletable |
|---------------|----------|----------------|
| `safe_to_delete` | Standalone filter, stale/inactive automation | Yes |
| `requires_review` | Active automation, journey, triggered send | No |
| `unknown` | Metadata unavailable | No |

**Analysis Algorithm:**
```
For each DE:
  1. Search in Automations (JSON serialization search)
  2. Search in Queries (CustomerKey + SQL text)
  3. Search in Filters (ObjectID match)
  4. Search in Imports (destination key)
  5. Search in Journeys, Triggered Sends, Data Extracts

Deduplicate by type + ID
Classify each unique dependency
Return categorized report
```

### 8. Cache Module (`src/lib/cache.js`)

**Responsibility:** Thread-safe file-based caching.

**Features:**
- Atomic writes (temp file + rename)
- Process locking with stale lock detection
- Lock retry with backoff (50 retries, 100ms each)
- Metadata tracking (age, source process)

### 9. Logger Module (`src/lib/logger.js`)

**Components:**

1. **Operational Logger (Winston)**
   - Console output with colors
   - File output with full debug
   - Custom methods: `logger.api()`, `logger.progress()`, `logger.section()`

2. **Audit Logger**
   - JSON format for compliance
   - Operation tracking with pre/post state
   - Success/failure/skipped counts

3. **State Manager**
   - Operation state persistence
   - Resume capability after interruption

## Data Flow

### Audit Workflow

```
CLI: audit --folder "Archive"
         ↓
Validate config
         ↓
Load folder cache or fetch from API
         ↓
Resolve folder path → get folder ID
         ↓
Get all DEs in folder
         ↓
For each DE: Get schema, row count, details
         ↓
Analyze dependencies (if enabled)
         ↓
Generate reports (console, JSON, CSV)
         ↓
Create audit log
```

### Delete Workflow

```
CLI: delete-des --folder "Archive"
         ↓
Validate config, test connection
         ↓
Load folder structure, resolve path
         ↓
Get all DEs, apply filters
         ↓
Analyze dependencies
         ↓
PREVIEW MODE: Show summary, exit
         ↓
CONFIRM MODE (--confirm):
    ↓
Multi-step confirmation prompt
    ↓
Create schema backups
    ↓
For each DE (batched):
  - Save pre-delete state
  - Delete via SOAP
  - Record result
  - Pause between batches
    ↓
Optional: Delete safe dependencies
    ↓
Send webhook, create audit log
```

## Safety Mechanisms

### 1. Dry-Run by Default
All delete operations preview changes without modifications unless `--confirm` is specified.

### 2. Protected Patterns

**Folders:**
- System, CASL, Platform, Salesforce, Einstein
- Contact Builder, MobileConnect, CloudPages, Synchronized

**DE Prefixes:**
- SYS_, CASL_, _Subscribers, _Bounce, _Click
- _Job, _Journey, _Open, _Sent, ent.

### 3. Multi-Step Confirmation
Live deletions require typing exact confirmation phrases.

### 4. Automatic Backups
Schema backups created before deletion.

### 5. Interruption Recovery
State persistence enables resumption after interruption.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SFMC_CLIENT_ID` | Yes | OAuth client ID |
| `SFMC_CLIENT_SECRET` | Yes | OAuth client secret |
| `SFMC_ACCOUNT_ID` | Yes | Business Unit MID |
| `SFMC_SUBDOMAIN` | Yes* | Tenant subdomain |
| `PROTECTED_FOLDER_PATTERNS` | No | Comma-separated folder patterns |
| `PROTECTED_DE_PREFIXES` | No | Comma-separated DE prefixes |
| `MAX_DELETE_BATCH_SIZE` | No | Batch size limit (default: 50) |
| `API_RATE_LIMIT_DELAY_MS` | No | API delay (default: 200ms) |
| `LOG_LEVEL` | No | Log verbosity (default: info) |
| `WEBHOOK_URL` | No | Notification endpoint |

*Or provide explicit URLs: `SFMC_AUTH_URL`, `SFMC_SOAP_URL`, `SFMC_REST_URL`

## Error Handling

| Error Type | Handling | Recovery |
|------------|----------|----------|
| Auth Errors | Validate credentials | Exit with message |
| Network Errors | Exponential backoff retry | Fail gracefully after 3 retries |
| API Errors | Extract error from response | Log and continue/exit |
| Validation Errors | Multi-step validation | Show helpful message |
| Lock Contention | Retry with backoff | Wait 5s total, then skip |

## Performance Characteristics

| Operation | Typical Time | Notes |
|-----------|--------------|-------|
| Auth token | ~500ms | First call only, then cached |
| Load folder cache | 50ms | From disk |
| Fetch folder structure | ~5s | Initial API call only |
| Audit single folder | 10-30s | Includes row counts & dependencies |
| Load bulk SFMC data | 30-120s | First run (depends on org size) |
| Bulk data from cache | 100ms | Cached version |
| Delete single DE | ~1-2s | Including backup |

## Design Decisions

| Decision | Rationale | Trade-off |
|----------|-----------|-----------|
| ES Modules | Modern JS, tree-shakeable | Requires Node 18+ |
| Multi-level caching | Fast repeated operations | Staleness risk (24h TTL) |
| Child process per command | State isolation | Slightly slower startup |
| Dry-run by default | Safety first | More steps for live operations |
| Bulk metadata loading | Avoids N+1 API problem | Higher initial memory |
| File-based cache | Survives restarts | Filesystem dependency |
| Process locking | Prevents concurrent writes | Small overhead on reads |
