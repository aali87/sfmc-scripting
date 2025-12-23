# SFMC Data Extension Toolkit

A comprehensive Node.js toolkit for Salesforce Marketing Cloud (SFMC) to audit, analyze dependencies, and safely delete Data Extensions and folders. Designed for platform teams managing production SFMC instances.

## Features

- **Audit Mode** - Generate comprehensive reports of folder contents without making changes
- **Dependency Checking** - Identify Automations, Journeys, Triggered Sends, and Query Activities that reference DEs
- **Safety First** - Protected item patterns, dry-run mode by default, and multi-step confirmations
- **Schema Backups** - Automatically backup DE schemas before deletion
- **Folder Caching** - Reduces API calls by caching folder structure locally
- **Progress Persistence** - Resume interrupted operations
- **Detailed Logging** - Full audit trail for compliance
- **Multiple Output Formats** - Console, JSON, and CSV reports

## Prerequisites

### SFMC Installed Package Setup

Create a **Server-to-Server** installed package in SFMC with these permissions:

| Scope | Access Level | Purpose |
|-------|--------------|---------|
| Data Extensions | Read, Write | Query and delete DEs (Write includes delete capability) |
| Automations | Read | Check for automation dependencies |
| Journeys | Read | Check for journey dependencies |
| Email | Read | Check Triggered Send dependencies |

> **Note:** There is no separate "Delete" permission for Data Extensions. The "Write" permission encompasses create, update, AND delete operations.

### System Requirements

- Node.js 18.0.0 or higher
- npm or yarn

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

# SFMC API URLs (replace YOUR_SUBDOMAIN with your tenant subdomain)
SFMC_AUTH_URL=https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com
SFMC_SOAP_URL=https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/Service.asmx
SFMC_REST_URL=https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com

# Safety Settings
PROTECTED_FOLDER_PATTERNS=System,CASL,Shared Data Extensions,Platform
PROTECTED_DE_PREFIXES=SYS_,CASL_,_Subscribers,_Bounce

# Rate Limiting
API_RATE_LIMIT_DELAY_MS=200
MAX_DELETE_BATCH_SIZE=50
```

### Protected Patterns

The toolkit includes safety patterns to prevent accidental deletion of system Data Extensions:

**Protected Folder Patterns** (folders containing these strings are protected):
- System, CASL, Platform, Salesforce, Einstein
- Contact Builder, MobileConnect, CloudPages

**Protected DE Prefixes** (DEs starting with these are protected):
- SYS_, CASL_, CAD_, IDP_
- _Subscribers, _Bounce, _Click, _Job, _Journey
- ent., ContactMaster

## Quick Start

```bash
# 1. Test your connection
node src/index.js test

# 2. Sync folder structure (caches locally for faster operations)
node src/index.js sync

# 3. Audit a folder to see what's inside
node src/scripts/audit-folder.js --folder "Data Extensions/YourFolder"

# 4. Preview what would be deleted (dry-run mode)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/YourFolder"

# 5. Actually delete (requires --confirm flag)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/YourFolder" --confirm
```

## Usage

> **Note:** If your folder path contains spaces or special characters (parentheses, etc.), run scripts directly with `node` instead of using `npm run` to avoid shell parsing issues.

### Test Connection

```bash
node src/index.js test
```

### Sync Folder Structure (Cache Management)

The toolkit caches folder structure locally to reduce API calls. On first run, it fetches all folders from SFMC and caches them for 24 hours.

```bash
# Sync/refresh folder cache from SFMC
node src/index.js sync

# Check cache status
node src/index.js sync --status

# Clear cache
node src/index.js sync --clear
```

To force a fresh fetch during any operation, use `--refresh-cache`:

```bash
node src/scripts/audit-folder.js --folder "Data Extensions/MyFolder" --refresh-cache
```

### Audit a Folder (Read-Only)

Generate a comprehensive report without making any changes:

```bash
# Basic audit
node src/scripts/audit-folder.js --folder "Data Extensions/Archive/2023"

# Output JSON only
node src/scripts/audit-folder.js --folder "Data Extensions/Archive" --output json

# Skip dependency checks (faster)
node src/scripts/audit-folder.js --folder "Data Extensions/Archive" --check-dependencies false

# Skip row counts (faster)
node src/scripts/audit-folder.js --folder "Data Extensions/Archive" --include-row-counts false
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder path (required) | - |
| `--output, -o` | Output format: console, json, csv, all | all |
| `--check-dependencies, -d` | Run dependency checks | true |
| `--include-row-counts, -r` | Include record counts | true |
| `--max-depth` | Maximum subfolder depth | unlimited |
| `--refresh-cache` | Force refresh cache from API | false |

### Delete Data Extensions

Delete all DEs within a folder and its subfolders:

```bash
# Dry run (default) - preview what would be deleted
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive/OldCampaigns"

# Interactive mode - select which DEs to delete
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --interactive

# Actually delete (requires confirmation)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive/OldCampaigns" --confirm

# Delete DEs not modified in 90 days
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --older-than-days 90 --confirm
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder containing DEs (required) | - |
| `--dry-run` | Preview only, no deletions | true |
| `--confirm` | Enable actual deletion mode | false |
| `--interactive, -i` | Select DEs interactively | false |
| `--skip-dependency-check` | Skip dependency validation | false |
| `--force-delete-with-dependencies` | Delete despite dependencies | false |
| `--skip-protected` | Skip protected DEs vs abort | false |
| `--backup-schemas` | Backup DE schemas before deletion | true |
| `--older-than-days` | Only delete DEs not modified in X days | - |
| `--exclude-pattern` | Regex pattern to exclude | - |
| `--include-pattern` | Regex pattern to include | - |
| `--batch-size` | DEs per batch | 10 |
| `--refresh-cache` | Force refresh cache from API | false |

### Delete Folders

Delete a folder and all its subfolders (must be empty unless --force):

```bash
# Dry run - preview folder deletion
node src/scripts/delete-folders.js --folder "Data Extensions/Archive/OldCampaigns"

# Actually delete empty folders
node src/scripts/delete-folders.js --folder "Data Extensions/Archive" --confirm

# Delete folders AND their contents (force mode)
node src/scripts/delete-folders.js --folder "Data Extensions/Archive" --force --confirm
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--folder, -f` | Folder to delete (required) | - |
| `--dry-run` | Preview only | true |
| `--confirm` | Enable actual deletion | false |
| `--force` | Delete contents before folders | false |
| `--skip-protected` | Skip protected folders vs abort | false |
| `--refresh-cache` | Force refresh cache from API | false |

## Safety Features

### Dry Run by Default

All delete operations run in dry-run mode by default. You must explicitly use `--confirm` to enable actual deletions.

### Multi-Step Confirmation

When deleting in live mode, you must type a confirmation phrase:
```
Type 'DELETE 15 DATA EXTENSIONS' to confirm:
```

### Dependency Checking

Before deletion, the toolkit checks for references in:
- Automation Studio (Query, Import, Filter, Data Extract activities)
- Journey Builder (entry events, decision splits)
- Triggered Send Definitions
- SQL Query Activities (target DE and SQL text)
- Import Activities (destination)

### Protected Items

Items matching protected patterns are:
1. Listed in the audit report
2. Blocked from deletion by default
3. Can be skipped with `--skip-protected` (not deleted, just skipped)

### Schema Backups

Before deletion, DE schemas are backed up to `backup/[timestamp]/`:
```json
{
  "backupMetadata": {
    "createdAt": "2025-01-15T10:30:00Z",
    "toolVersion": "1.0.0"
  },
  "dataExtension": {
    "name": "My_Data_Extension",
    "customerKey": "My_Data_Extension",
    "fields": [...]
  }
}
```

### Progress Persistence

If an operation is interrupted (Ctrl+C, error):
- State is saved to `state/[operation-id].json`
- Resume with `--resume [operation-id]`

## Output Files

| Directory | Contents |
|-----------|----------|
| `audit/` | JSON and CSV audit reports |
| `logs/` | Detailed operation logs |
| `backup/` | DE schema backups before deletion |
| `state/` | Operation state for resume capability |
| `undo/` | Templates to recreate deleted DEs |
| `cache/` | Cached folder structure |

## Scheduled Execution

For running via cron or scheduled tasks:

```bash
node src/scripts/delete-data-extensions.js \
  --folder "Data Extensions/Archive" \
  --confirm \
  --non-interactive \
  --confirm-phrase "DELETE 15 DATA EXTENSIONS" \
  --older-than-days 365
```

### Webhook Notifications

Send results to Slack, Teams, or monitoring systems:

```bash
node src/scripts/delete-data-extensions.js \
  --folder "Data Extensions/Archive" \
  --confirm \
  --webhook-url "https://hooks.slack.com/services/..."
```

Or configure in `.env`:
```env
WEBHOOK_URL=https://hooks.slack.com/services/...
```

## Troubleshooting

### Command Line Issues

**Problem:** Arguments with spaces or special characters fail

**Solution:** Run scripts directly with node (not npm run):
```bash
node src/scripts/audit-folder.js --folder "Data Extensions/My Folder (2023)"
```

### Authentication Errors

| Error | Solution |
|-------|----------|
| `invalid_client` | Verify SFMC_CLIENT_ID and SFMC_CLIENT_SECRET |
| `Host not found` | Check your subdomain in the API URLs |
| `HTTP 405` | Ensure SFMC_SOAP_URL ends with `/Service.asmx` |

### Permission Errors

`403 Forbidden` or `Insufficient privileges`:
- Verify the Installed Package has Data Extension Read/Write permissions
- For dependency checks, ensure Automation and Journey read access

### Folder Not Found

The toolkit suggests similar folders when a path isn't found:
```
Did you mean one of these?
  - Data Extensions/Archive/2023
  - Data Extensions/Archive/Campaigns
```

### Debug Mode

Set `LOG_LEVEL=debug` in `.env` for detailed logging. Debug scripts are also available:
```bash
node debug-soap.js    # Test SOAP connectivity
node debug-delete.js  # Test delete operation format
```

## Best Practices

1. **Always run audit first** - Understand what's in a folder before deleting
2. **Use dry-run mode** - Preview all deletions before confirming
3. **Start with a test folder** - Test in a sandbox BU first
4. **Check dependencies** - Don't skip dependency checks in production
5. **Keep backups** - Schema backups are created by default; retain them
6. **Review logs** - Check audit logs after operations for compliance
7. **Use date filters** - Delete only DEs older than X days to avoid accidents
8. **Sync first** - Run `sync` before operations to cache folder structure

## API Rate Limits

SFMC recommends 200-500ms between API calls. The toolkit:
- Defaults to 200ms delay between calls
- Implements automatic retry with exponential backoff
- Caches folder structure to minimize API calls
- Supports configurable batch sizes

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT License - See [LICENSE](LICENSE) file for details.
