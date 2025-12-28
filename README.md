# SFMC Data Extension Toolkit

A comprehensive Node.js toolkit for Salesforce Marketing Cloud (SFMC) Data Extension management. Audit folder contents, analyze dependencies with smart classification, and safely delete Data Extensions, Query Activities, Automations, and Folders with full audit logging.

## Key Features

### Smart Dependency Analysis
- **Intelligent Classification** - Dependencies are classified as "Safe to Delete" or "Requires Review"
- **Bulk Data Loading** - Loads all SFMC metadata upfront with 24-hour caching for fast analysis
- **Query SQL Parsing** - Detects DE references in SQL queries by CustomerKey AND Name
- **Automation Context** - Identifies stale automations (never run, stopped, 90+ days inactive)

### Safe Deletion Workflows
- **Dry-Run by Default** - All delete operations preview changes without modifying anything
- **Multi-Step Confirmation** - Live deletions require typing confirmation phrases
- **Auto-Delete Safe Dependencies** - Optionally delete standalone filters, stale automations, and queries
- **Schema Backups** - Automatic JSON backups before deletion
- **Undo Scripts** - Templates to recreate deleted DEs

### Comprehensive Auditing
- **Folder Audits** - Generate detailed reports of folder contents
- **Dependency Reports** - Export to CSV with classification details
- **Audit Logging** - Full compliance trail for all operations
- **Protected Items** - System DEs and folders are automatically detected and skipped

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

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/sfmc-de-toolkit.git
cd sfmc-de-toolkit

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your SFMC credentials
```

## Configuration

### Environment Variables

Edit `.env` with your SFMC credentials:

```env
# Required - from your SFMC Installed Package
SFMC_CLIENT_ID=your_client_id
SFMC_CLIENT_SECRET=your_client_secret
SFMC_ACCOUNT_ID=your_mid
SFMC_SUBDOMAIN=your_subdomain

# Or use explicit URLs
SFMC_AUTH_URL=https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com
SFMC_SOAP_URL=https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/Service.asmx
SFMC_REST_URL=https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com

# Safety Settings
PROTECTED_FOLDER_PATTERNS=System,CASL,Shared Data Extensions,Platform
PROTECTED_DE_PREFIXES=SYS_,CASL_,_Subscribers,_Bounce

# Rate Limiting
API_RATE_LIMIT_DELAY_MS=200
MAX_DELETE_BATCH_SIZE=50

# Optional
LOG_LEVEL=info
WEBHOOK_URL=https://hooks.slack.com/services/...
```

### Protected Patterns

The toolkit automatically protects system items from accidental deletion:

**Protected Folder Patterns:**
- System, CASL, Platform, Salesforce, Einstein
- Contact Builder, MobileConnect, CloudPages, Synchronized

**Protected DE Prefixes:**
- SYS_, CASL_, CAD_, IDP_
- _Subscribers, _Bounce, _Click, _Job, _Journey, _Open, _Sent
- ent., ContactMaster

## Quick Start

```bash
# 1. Test your connection
node src/index.js test

# 2. Sync folder cache (optional, auto-syncs on first run)
node src/index.js sync

# 3. Audit a folder (read-only)
node src/scripts/audit-folder.js --folder "Data Extensions/Archive"

# 4. Preview DE deletion (dry-run)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive"

# 5. Delete with auto-cleanup of safe dependencies
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" \
  --delete-safe-dependencies --confirm
```

## Scripts

### Audit Folder (Read-Only)

Generate comprehensive reports of folder contents with dependency analysis:

```bash
node src/scripts/audit-folder.js --folder "Data Extensions/Archive" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder path to audit (required) | - |
| `--output, -o` | Output format: console, json, csv, all | all |
| `--check-dependencies, -d` | Run smart dependency analysis | true |
| `--include-row-counts, -r` | Include record counts per DE | true |
| `--max-depth` | Maximum subfolder depth | unlimited |
| `--refresh-cache` | Force refresh from SFMC API | false |

**Output Files:**
- `audit/audit-des-YYYYMMDD-HHmmss.csv` - DE list with dependency classifications
- `audit/audit-dependencies-YYYYMMDD-HHmmss.csv` - All dependencies with status
- `audit/audit-YYYYMMDD-HHmmss.json` - Complete audit data

### Delete Data Extensions

Delete DEs within a folder with comprehensive dependency handling:

```bash
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder containing DEs (required) | - |
| `--dry-run` | Preview only, no deletions | true |
| `--confirm` | Enable actual deletion mode | false |
| `--delete-safe-dependencies` | Auto-delete safe dependencies (filters, stale automations) | false |
| `--delete-query-dependencies` | Also delete Query Activities referencing DEs | false |
| `--skip-dependency-check` | Skip dependency validation | false |
| `--force-delete-with-dependencies` | Delete despite blocking dependencies | false |
| `--skip-protected` | Skip protected DEs instead of aborting | false |
| `--backup-schemas` | Backup DE schemas before deletion | true |
| `--older-than-days` | Only delete DEs not modified in X days | - |
| `--exclude-pattern` | Regex pattern for DE names to exclude | - |
| `--include-pattern` | Regex pattern for DE names to include | - |
| `--batch-size` | Number of DEs to delete per batch | 10 |
| `--interactive, -i` | Select DEs interactively | false |
| `--resume` | Resume a previous operation by ID | - |
| `--non-interactive` | Non-interactive mode for automation | false |
| `--confirm-phrase` | Confirmation phrase for non-interactive mode | - |
| `--webhook-url` | URL to POST results to | - |
| `--refresh-cache` | Force refresh cache from API | false |

**Dependency Classification:**

| Classification | Description | Auto-Deletable |
|----------------|-------------|----------------|
| Safe to Delete | Standalone filters, stale automations (stopped/never run/90+ days inactive) | Yes |
| Requires Review | Active automations, journeys, triggered sends | No |

**Examples:**

```bash
# Preview what would be deleted
node src/scripts/delete-data-extensions.js --folder "Archive/2023"

# Delete DEs with automatic cleanup of safe dependencies
node src/scripts/delete-data-extensions.js --folder "Archive/2023" \
  --delete-safe-dependencies --confirm

# Delete DEs and their Query Activities
node src/scripts/delete-data-extensions.js --folder "Archive/2023" \
  --delete-safe-dependencies --delete-query-dependencies --confirm

# Delete only DEs older than 90 days
node src/scripts/delete-data-extensions.js --folder "Archive" \
  --older-than-days 90 --confirm

# Interactive selection mode
node src/scripts/delete-data-extensions.js --folder "Archive" --interactive
```

### Delete Automations

Delete automations by name with backup and safety checks:

```bash
node src/scripts/delete-automations.js --file automations.txt [options]
node src/scripts/delete-automations.js --names "Auto1,Auto2,Auto3" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--file, -f` | Path to file with automation names (one per line) | - |
| `--names, -n` | Comma-separated list of automation names | - |
| `--dry-run` | Preview only, no deletions | true |
| `--confirm` | Enable actual deletion mode | false |
| `--backup` | Backup automation configs before deletion | true |
| `--skip-running` | Skip automations currently running | true |
| `--force-delete-running` | Delete even if running (dangerous) | false |
| `--batch-size` | Automations to delete before pausing | 5 |
| `--interactive, -i` | Select automations interactively | false |
| `--non-interactive` | Non-interactive mode for automation | false |
| `--confirm-phrase` | Confirmation phrase for non-interactive mode | - |

### Delete Folders

Delete folders and subfolders (must be empty unless --force):

```bash
node src/scripts/delete-folders.js --folder "Data Extensions/Archive" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder path to delete (required) | - |
| `--dry-run` | Preview only | true |
| `--confirm` | Enable actual deletion | false |
| `--force` | Delete folder contents first | false |
| `--skip-protected` | Skip protected folders instead of aborting | false |
| `--non-interactive` | Non-interactive mode | false |
| `--confirm-phrase` | Confirmation phrase for non-interactive mode | - |
| `--webhook-url` | URL to POST results to | - |
| `--refresh-cache` | Force refresh cache from API | false |

## Debug Scripts

Debug scripts for troubleshooting specific issues:

```bash
# Test dependency detection for a specific DE
node src/scripts/debug-de-dependencies.js "DE CustomerKey"

# Test SOAP connectivity
node debug-soap.js

# Test delete operation format
node debug-delete.js
```

## Caching

The toolkit uses intelligent caching to minimize API calls:

### Folder Cache
- Cached locally for 24 hours
- Auto-refreshes on first run
- Force refresh with `--refresh-cache`

### Bulk Data Cache
- Stores automations, filters, queries, imports, journeys, data extracts
- 24-hour expiry
- Used for dependency analysis

```bash
# Check cache status
node src/index.js sync --status

# Clear cache
node src/index.js sync --clear

# Force refresh
node src/index.js sync --refresh
```

## Output Directories

| Directory | Contents |
|-----------|----------|
| `audit/` | JSON and CSV audit reports, dependency exports |
| `logs/` | Detailed operation logs |
| `backup/` | DE schema backups before deletion |
| `state/` | Operation state for resume capability |
| `undo/` | Templates to recreate deleted DEs |
| `cache/` | Cached folder structure and bulk data |

## Scheduled Execution

For running via cron or CI/CD:

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

## Webhook Notifications

Send operation results to Slack, Teams, or monitoring systems:

```bash
# Via command line
--webhook-url "https://hooks.slack.com/services/..."

# Or via .env
WEBHOOK_URL=https://hooks.slack.com/services/...
```

Webhook payload includes:
- Operation type and ID
- Business Unit
- Target folder
- Success/failure counts
- Completion timestamp

## Safety Features

### Dry Run by Default
All delete operations run in preview mode. Use `--confirm` for live execution.

### Multi-Step Confirmation
Live deletions require typing an exact phrase:
```
Type 'DELETE 15 DATA EXTENSIONS' to confirm:
```

### Dependency Checking
Before deletion, checks for references in:
- Automation Studio (Query, Import, Filter, Data Extract activities)
- Journey Builder (entry events, decision splits)
- Triggered Send Definitions
- SQL Query text (SELECT/FROM/JOIN clauses)

### Protected Items
System items are automatically detected and:
1. Listed in audit reports
2. Blocked from deletion by default
3. Can be skipped with `--skip-protected`

### Interruption Recovery
If interrupted (Ctrl+C, error):
- State saved to `state/[operation-id].json`
- Resume with `--resume [operation-id]`

## Troubleshooting

### Folder Path Issues

If paths with spaces fail, run directly with node:
```bash
node src/scripts/audit-folder.js --folder "Data Extensions/My Folder (2023)"
```

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
- For dependency checks, ensure Journey read access

### Folder Not Found

The toolkit suggests similar folders:
```
Did you mean one of these?
  - Data Extensions/Archive/2023
  - Data Extensions/Archive/Campaigns
```

### Debug Mode

Enable detailed logging:
```bash
LOG_LEVEL=debug node src/scripts/audit-folder.js --folder "Archive"
```

## API Rate Limits

The toolkit respects SFMC rate limits:
- Default 200ms delay between API calls
- Automatic retry with exponential backoff
- Folder caching to minimize calls
- Bulk data loading with 24-hour cache
- Configurable batch sizes

## License

MIT License - See [LICENSE](LICENSE) file for details.
