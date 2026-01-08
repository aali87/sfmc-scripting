# SFMC Data Extension Toolkit

A Node.js CLI toolkit for Salesforce Marketing Cloud (SFMC) Data Extension management. Safely audit, analyze dependencies, and delete Data Extensions, Query Activities, Automations, and Folders.

## Features

- **Safe by Default** - All deletions are dry-run; use `--confirm` for live execution
- **Smart Dependency Analysis** - Detects references in queries, automations, journeys, and triggered sends
- **Multi-Business Unit Support** - Analyze and manage DEs across different Business Units
- **Bulk Metadata Caching** - 24-hour cache minimizes API calls for fast repeated analysis
- **Automatic Backups** - Schema backups created before any deletion
- **Resumable Operations** - Interrupted operations can be resumed from saved state

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/yourusername/sfmc-de-toolkit.git
cd sfmc-de-toolkit
npm install

# 2. Configure credentials
cp .env.example .env
# Edit .env with your SFMC credentials (see Configuration section)

# 3. Test connection
node src/index.js test

# 4. Audit a folder (read-only)
node src/scripts/audit-folder.js --folder "Data Extensions/Archive"

# 5. Preview deletion (dry-run)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive"

# 6. Delete with confirmation
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --confirm
```

---

## Prerequisites

### SFMC Installed Package

Create a **Server-to-Server** installed package in SFMC with these permissions:

| Scope | Access Level | Purpose |
|-------|--------------|---------|
| Data Extensions | Read, Write | Query and delete DEs |
| Automations | Read, Write | Check dependencies, delete stale automations |
| Journeys | Read | Check journey dependencies |
| Email | Read | Check Triggered Send dependencies |

### System Requirements

- Node.js 18.0.0 or higher
- npm

---

## Configuration

Create a `.env` file with your SFMC credentials:

```env
# Required - from your SFMC Installed Package
SFMC_CLIENT_ID=your_client_id
SFMC_CLIENT_SECRET=your_client_secret
SFMC_ACCOUNT_ID=your_mid
SFMC_SUBDOMAIN=your_subdomain

# Optional - explicit URLs (auto-generated from subdomain if not set)
SFMC_AUTH_URL=https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com
SFMC_SOAP_URL=https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/Service.asmx
SFMC_REST_URL=https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com

# Optional - logging
LOG_LEVEL=info

# Optional - webhook notifications
WEBHOOK_URL=https://hooks.slack.com/services/...
```

### Environment Variable Reference

| Category | Variable | Default | Description |
|----------|----------|---------|-------------|
| **Timeouts** | `SOAP_TIMEOUT_MS` | 120000 | SOAP API timeout (2 min) |
| | `REST_TIMEOUT_MS` | 60000 | REST API timeout (1 min) |
| **Pagination** | `DEFAULT_PAGE_SIZE` | 500 | API pagination size |
| | `JOURNEY_PAGE_SIZE` | 100 | Journey API page size |
| **Concurrency** | `QUERY_TEXT_CONCURRENCY` | 25 | Parallel query SQL requests |
| | `AUTOMATION_DETAILS_CONCURRENCY` | 10 | Parallel automation requests |
| **Safety** | `PROTECTED_FOLDER_PATTERNS` | System,CASL,... | Folders to protect |
| | `PROTECTED_DE_PREFIXES` | SYS_,CASL_,... | DE prefixes to protect |

---

## Commands

### Test Connection

```bash
node src/index.js test
```

Verifies your SFMC credentials and API connectivity.

### Sync Cache

```bash
node src/index.js sync              # Refresh folder cache
node src/index.js sync --status     # Check cache status
node src/index.js sync --clear      # Clear all cached data
```

### Audit Folder

Generate a read-only report of folder contents with dependency analysis:

```bash
node src/scripts/audit-folder.js --folder "Data Extensions/Archive"
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder path to audit (required) | - |
| `--output, -o` | Format: console, json, csv, all | all |
| `--check-dependencies, -d` | Run dependency analysis | true |
| `--include-row-counts, -r` | Include record counts | true |
| `--refresh-cache` | Force refresh from API | false |

**Output files** are saved to the `audit/` directory.

### Analyze Business Unit

Analyze all DEs in a Business Unit with deletion recommendations:

```bash
node src/index.js analyze-bu --bu 123456
node src/index.js analyze-bu --bu 123456 -o report.csv --stale-years 2
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--business-unit, --bu` | Business Unit MID (required) | - |
| `--stale-years` | Years of inactivity threshold | 3 |
| `--output, -o` | CSV output file path | auto-generated |
| `--refresh-cache` | Force refresh cached data | false |
| `--verbose, -v` | Verbose output | false |
| `--limit` | Limit DEs (for testing) | - |

**Recommendation Categories:**

| Category | Description |
|----------|-------------|
| KEEP | Recent activity detected |
| RECOMMEND_DELETE | All automations inactive for 3+ years |
| SAFE_TO_DELETE | No dependencies found |
| REVIEW | Used in Journey/Triggered Send |

### Delete Data Extensions

Delete DEs within a folder with dependency handling:

```bash
# Dry-run (preview only)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive"

# Live deletion
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --confirm

# With automatic cleanup of safe dependencies
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" \
  --delete-safe-dependencies --confirm
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder containing DEs (required) | - |
| `--confirm` | Enable actual deletion | false |
| `--delete-safe-dependencies` | Auto-delete safe deps | false |
| `--delete-query-dependencies` | Also delete Query Activities | false |
| `--skip-protected` | Skip protected DEs | false |
| `--older-than-days` | Only delete if not modified in X days | - |
| `--include-pattern` | Regex for DE names to include | - |
| `--exclude-pattern` | Regex for DE names to exclude | - |
| `--interactive, -i` | Select DEs interactively | false |
| `--resume` | Resume previous operation by ID | - |

### Delete Folders

Delete folders (must be empty unless `--force`):

```bash
node src/scripts/delete-folders.js --folder "Data Extensions/Archive" --confirm
```

### Delete Automations

Delete automations by name:

```bash
node src/scripts/delete-automations.js --file automations.txt --confirm
node src/scripts/delete-automations.js --names "Auto1,Auto2" --confirm
```

### Audit CloudPages

Scan CloudPage HTML for patterns (e.g., font references):

```bash
node src/scripts/audit-cloudpages.js --bu 123456
node src/scripts/audit-cloudpages.js --bu 123456 --search "DAX,Arial" -o report.csv
```

### Update Automation Query ObjectIDs

Update query references in automations after query recreation:

```bash
# Dry-run
node src/scripts/update-automation-query-objectids.js --automation-id "guid" --bu 123456

# Apply changes
node src/scripts/update-automation-query-objectids.js --automation-id "guid" --bu 123456 --confirm
```

---

## Safety Features

### Dry-Run by Default

All delete operations preview changes without modifying anything. Use `--confirm` to execute.

### Multi-Step Confirmation

Live deletions require typing an exact phrase:

```
Type 'DELETE 15 DATA EXTENSIONS' to confirm:
```

### Protected Items

System folders and DEs are automatically protected:

**Protected Folders:** System, CASL, Platform, Salesforce, Einstein, Contact Builder, MobileConnect, CloudPages, Synchronized

**Protected DE Prefixes:** SYS_, CASL_, _Subscribers, _Bounce, _Click, _Job, _Journey, _Open, _Sent, ent., ContactMaster

### Dependency Checking

Before deletion, checks for references in:
- Query Activities (SQL text parsing)
- Automations (Query, Import, Filter, Data Extract activities)
- Journey Builder (entry events, decision splits)
- Triggered Send Definitions

### Automatic Backups

Schema backups are saved to `backup/` before any deletion.

### Resumable Operations

If interrupted (Ctrl+C, error), resume with:

```bash
node src/scripts/delete-data-extensions.js --resume [operation-id]
```

---

## Debug Scripts

For troubleshooting specific issues:

```bash
# Test SOAP connectivity
node src/scripts/debug-soap.js

# Test dependency detection for a DE
node src/scripts/debug-de-dependencies.js "DE_CustomerKey"

# Inspect automation details
node src/scripts/debug-automation.js "Automation Name"

# Inspect filter activity
node src/scripts/debug-filter.js "FilterId"
```

Enable debug logging:

```bash
LOG_LEVEL=debug node src/scripts/audit-folder.js --folder "Archive"
```

---

## Output Directories

| Directory | Contents |
|-----------|----------|
| `audit/` | JSON and CSV audit reports |
| `logs/` | Detailed operation logs |
| `backup/` | DE schema backups before deletion |
| `state/` | Operation state for resume |
| `cache/` | Cached folder and metadata |

---

## Scheduled Execution

For cron or CI/CD:

```bash
node src/scripts/delete-data-extensions.js \
  --folder "Data Extensions/Archive" \
  --confirm \
  --non-interactive \
  --confirm-phrase "DELETE 15 DATA EXTENSIONS" \
  --delete-safe-dependencies \
  --older-than-days 365 \
  --webhook-url "https://hooks.slack.com/services/..."
```

---

## Troubleshooting

### Authentication Errors

| Error | Solution |
|-------|----------|
| `invalid_client` | Verify SFMC_CLIENT_ID and SFMC_CLIENT_SECRET |
| `Host not found` | Check SFMC_SUBDOMAIN or explicit URLs |
| `HTTP 405` | Ensure SFMC_SOAP_URL ends with `/Service.asmx` |

### Permission Errors

`403 Forbidden` or `Insufficient privileges`:
- Verify Installed Package has Data Extension Read/Write permissions
- For automations, ensure Automation Read/Write access
- For dependency checks, ensure Journey Read access

### Folder Not Found

The toolkit suggests similar folders:

```
Did you mean one of these?
  - Data Extensions/Archive/2023
  - Data Extensions/Archive/Campaigns
```

---

## Project Structure

```
src/
├── index.js              # CLI entry point (yargs)
├── config/
│   └── index.js          # Configuration and validation
├── lib/
│   ├── sfmc-auth.js      # OAuth 2.0 token management
│   ├── sfmc-rest.js      # REST API client
│   ├── sfmc-soap.js      # SOAP API client
│   ├── folder-service.js # Folder hierarchy and caching
│   ├── data-extension-service.js  # DE operations
│   ├── dependency-analyzer.js     # Dependency detection
│   ├── bulk-data-loader.js        # Metadata loading
│   ├── cache.js          # File-based cache
│   ├── logger.js         # Logging and audit trails
│   └── utils.js          # Shared utilities
└── scripts/
    ├── audit-folder.js
    ├── analyze-bu.js
    ├── delete-data-extensions.js
    ├── delete-folders.js
    ├── delete-automations.js
    ├── audit-cloudpages.js
    └── debug-*.js        # Debug utilities
```

---

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

---

## License

MIT License - See [LICENSE](LICENSE) for details.
