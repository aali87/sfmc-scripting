# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue in the SFMC DE Toolkit, please report it responsibly.

### How to Report

1. **Do NOT create a public GitHub issue** for security vulnerabilities
2. Email your findings to the maintainers privately
3. Include the following information:
   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact
   - Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 48 hours
- **Assessment**: We will assess the vulnerability and determine its severity
- **Updates**: We will keep you informed of our progress
- **Resolution**: We aim to resolve critical vulnerabilities within 7 days

### Security Best Practices for Users

When using this toolkit:

1. **Protect your credentials**: Never commit your `.env` file or SFMC credentials to version control
2. **Use environment variables**: Store sensitive configuration in environment variables
3. **Limit API permissions**: Use SFMC API credentials with the minimum required permissions
4. **Review before deletion**: Always use `--dry-run` mode before performing bulk deletions
5. **Audit access**: Regularly review who has access to your SFMC credentials

### Credential Security

This toolkit requires SFMC API credentials. To keep them secure:

```bash
# Add to .gitignore (already included)
.env
*.env
.env.*

# Use environment variables
export SFMC_CLIENT_ID=your_client_id
export SFMC_CLIENT_SECRET=your_client_secret
```

### Scope

This security policy applies to:

- The SFMC DE Toolkit codebase
- Official releases and packages
- Documentation

This policy does not cover:

- Third-party dependencies (report to their maintainers)
- Salesforce Marketing Cloud platform vulnerabilities (report to Salesforce)
- User misconfiguration or misuse

## Acknowledgments

We appreciate the security research community and will acknowledge reporters who help us improve security (with their permission).
