# SFMC Data Extension Toolkit

A comprehensive Node.js toolkit for Salesforce Marketing Cloud (SFMC) to audit, analyze dependencies, and safely delete Data Extensions and folders. Designed for platform teams managing production SFMC instances containing significant PII.

## Features

- **Audit Mode** - Generate comprehensive reports of folder contents without making changes
- **Dependency Checking** - Identify Automations, Journeys, Triggered Sends, and Query Activities that reference DEs
- **Safety First** - Protected item patterns, dry-run mode by default, and multi-step confirmations
- **Schema Backups** - Automatically backup DE schemas before deletion
- **Progress Persistence** - Resume interrupted operations
- **Detailed Logging** - Full audit trail for compliance
- **Multiple Output Formats** - Console, JSON, and CSV reports

## Prerequisites

### SFMC Requirements

1. **Installed Package** with the following permissions:
   - Data Extensions: Read, Write, Delete
   - Automations: Read
   - Journeys: Read
   - Triggered Sends: Read
   - List and Subscribers: Read

2. **API Credentials**:
   - Client ID
   - Client Secret
   - Authentication Base URL (subdomain)
   - Account ID (MID)

### System Requirements

- Node.js 18.0.0 or higher
- npm or yarn

## Installation

```bash
# Clone or download the toolkit
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
# Required
SFMC_CLIENT_ID=your_client_id
SFMC_CLIENT_SECRET=your_client_secret
SFMC_SUBDOMAIN=your_subdomain
SFMC_ACCOUNT_ID=your_mid

# Safety Settings (customize as needed)
PROTECTED_FOLDER_PATTERNS=System,CASL,Shared Data Extensions,SYS_,Platform
PROTECTED_DE_PREFIXES=SYS_,CASL_,CAD_,_Subscribers,_Bounce

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

## Usage

> **Note:** If your folder path contains spaces or special characters (parentheses, etc.), run scripts directly with `node` instead of using `npm run` to avoid shell parsing issues.

### Test Connection

```bash
npm start test
# or
node src/index.js test
```

### Audit a Folder (Read-Only)

Generate a comprehensive report without making any changes:

```bash
# Basic audit - use full path from "Data Extensions" root
node src/scripts/audit-folder.js --folder "Data Extensions/Campaigns/2016/5471 - Cash Offer (resend)"

# Audit with a simpler folder path
node src/scripts/audit-folder.js --folder "Data Extensions/Archive/Old Campaigns"

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
| `--folder, -f` | Folder path or name (required) | - |
| `--output, -o` | Output format: console, json, csv, all | all |
| `--check-dependencies, -d` | Run dependency checks | true |
| `--include-row-counts, -r` | Include record counts | true |
| `--max-depth` | Maximum subfolder depth | unlimited |

### Delete Data Extensions

Delete all DEs within a folder and its subfolders:

```bash
# Dry run (default) - see what would be deleted
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Campaigns/2016/5471 - Cash Offer (resend)"

# Interactive mode - select which DEs to delete
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --interactive

# Actually delete (requires confirmation) - deletes all DEs in folder and subfolders
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Campaigns/2016/5471 - Cash Offer (resend)" --confirm

# Delete DEs not modified in 90 days
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --older-than-days 90 --confirm

# Skip dependency check (dangerous)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --skip-dependency-check --confirm

# Force delete even with dependencies (very dangerous)
node src/scripts/delete-data-extensions.js --folder "Data Extensions/Archive" --force-delete-with-dependencies --confirm
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

### Delete Folders

Delete a folder and all its subfolders (must be empty unless --force):

```bash
# Dry run - preview folder deletion
node src/scripts/delete-folders.js --folder "Data Extensions/Archive/Old Campaigns"

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
    "createdAt": "2025-12-22T14:30:00Z",
    "toolVersion": "1.0.0"
  },
  "dataExtension": {
    "name": "Campaign_Data_2023",
    "customerKey": "Campaign_Data_2023",
    "fields": [...]
  }
}
```

### Progress Persistence

If an operation is interrupted (Ctrl+C, error):
- State is saved to `state/[operation-id].json`
- Resume with `--resume [operation-id]`

## Output Files

### Audit Reports
- `audit/audit-[timestamp].json` - Full JSON report
- `audit/audit-[timestamp].csv` - Spreadsheet-friendly format

### Logs
- `logs/[script]-[timestamp].log` - Detailed operation log

### Audit Logs (Deletion)
- `audit/delete-des-[timestamp].json` - Deletion audit trail
- `audit/delete-folders-[timestamp].json` - Folder deletion audit

### Backups
- `backup/[timestamp]/[de-key].json` - Schema backups

### Undo Scripts
- `undo/undo-[timestamp].js` - Template to recreate deleted DEs (schema only)

## Scheduled Execution

For running via cron or scheduled tasks:

```bash
# Non-interactive mode requires confirmation phrase
node src/scripts/delete-data-extensions.js \
  --folder "Archive" \
  --confirm \
  --non-interactive \
  --confirm-phrase "DELETE 15 DATA EXTENSIONS" \
  --older-than-days 365
```

### Webhook Notifications

Send results to Slack, Teams, or monitoring systems:

```bash
node src/scripts/delete-data-extensions.js \
  --folder "Archive" \
  --confirm \
  --webhook-url "https://hooks.slack.com/services/..."
```

Or configure in `.env`:
```env
WEBHOOK_URL=https://hooks.slack.com/services/...
```

## Troubleshooting

### Command Line Parsing Issues

**Problem:** npm run commands fail with special characters in folder names

When folder paths contain spaces or parentheses (e.g., "5471 - Cash Offer (resend)"), npm's argument parsing may fail:
```
npm warn could not parse: --folder "Data Extensions/Campaigns/5471 - Cash Offer (resend)"
```

**Solution:** Run scripts directly with node:
```bash
node src/scripts/audit-folder.js --folder "Data Extensions/Campaigns/5471 - Cash Offer (resend)"
```

### Authentication Errors

**Error:** `SFMC Authentication failed: invalid_client`
- Verify SFMC_CLIENT_ID and SFMC_CLIENT_SECRET
- Ensure the Installed Package is active
- Check the package has required permissions

**Error:** `Host not found`
- Verify SFMC_SUBDOMAIN is correct
- Format should be just the subdomain, not the full URL

**Error:** `HTTP 405 - Method Not Allowed`
- SFMC_SOAP_URL must end with `/Service.asmx`
- The toolkit auto-appends this, but verify your URL format

### Permission Errors

**Error:** `403 Forbidden` or `Insufficient privileges`
- Verify the Installed Package has Data Extension Read/Write/Delete permissions
- For dependency checks, ensure Automation and Journey read access

### Folder Not Found

If your folder path isn't found, the toolkit suggests similar folders:
```
Did you mean one of these?
  - Data Extensions/Archive/Old Campaigns
  - Data Extensions/Archive/2023 Campaigns
```

**Tip:** Pay attention to spacing - "5471- Cash" is different from "5471 - Cash" (space before dash).

### Rate Limiting

If you see `429 Too Many Requests`:
- Increase `API_RATE_LIMIT_DELAY_MS` in `.env`
- Reduce `--batch-size` for deletion operations

### Debug Mode

For detailed debugging, set `LOG_LEVEL=debug` in your `.env` file. You can also run the included debug scripts:
```bash
# Test SOAP connectivity
node debug-soap.js

# Test Delete operation format
node debug-delete.js
```

## Best Practices

1. **Always run audit first** - Understand what's in a folder before deleting
2. **Use dry-run mode** - Preview all deletions before confirming
3. **Start with a test folder** - Create a test folder in a sandbox BU first
4. **Check dependencies** - Don't skip dependency checks in production
5. **Keep backups** - Schema backups are created by default; keep them
6. **Review logs** - Check audit logs after operations for compliance
7. **Use date filters** - Only delete DEs older than X days to avoid accidents

## API Rate Limits

SFMC recommends 200-500ms between API calls. The toolkit defaults to 200ms delay and implements:
- Automatic retry with exponential backoff for rate limit errors
- Configurable batch sizes with progress checkpoints
- Token caching with automatic refresh

## Support

For issues and feature requests, please open an issue on the repository.

## License

MIT License - See LICENSE file for details.
