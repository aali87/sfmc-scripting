# Contributing to SFMC DE Toolkit

Thank you for your interest in contributing to this project! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- Access to a Salesforce Marketing Cloud account (for testing)

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/sfmc-de-toolkit.git
   cd sfmc-de-toolkit
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
5. Configure your SFMC credentials in `.env`

## Development Workflow

### Branch Naming

Use descriptive branch names:
- `feature/add-new-command` - New features
- `fix/dependency-detection` - Bug fixes
- `docs/update-readme` - Documentation updates
- `refactor/improve-caching` - Code refactoring

### Making Changes

1. Create a new branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following the coding standards below

3. Test your changes:
   ```bash
   # Run with dry-run mode first
   node src/scripts/your-script.js --dry-run
   ```

4. Commit your changes with a clear message:
   ```bash
   git commit -m "Add feature: description of what was added"
   ```

5. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

6. Open a Pull Request

## Coding Standards

### JavaScript Style

- Use ES modules (`import`/`export`)
- Use `const` by default, `let` when reassignment is needed
- Use async/await for asynchronous operations
- Add JSDoc comments for public functions

### File Organization

```
src/
  lib/           # Shared libraries and utilities
  scripts/       # CLI scripts
```

### Error Handling

- Always handle errors gracefully
- Provide meaningful error messages
- Use the logger for debug information
- Never expose sensitive data in logs

### Example Function

```javascript
/**
 * Brief description of what the function does
 * @param {string} param1 - Description of param1
 * @param {object} logger - Logger instance
 * @returns {Promise<object>} Description of return value
 */
export async function exampleFunction(param1, logger = null) {
  try {
    // Implementation
    return result;
  } catch (error) {
    if (logger) {
      logger.error(`Failed to do thing: ${error.message}`);
    }
    throw error;
  }
}
```

## Testing

### Manual Testing

Before submitting a PR, test your changes:

1. **Dry Run Mode**: Always test with `--dry-run` first
2. **Non-Production**: Test against a non-production SFMC account when possible
3. **Edge Cases**: Test with empty results, large datasets, and error conditions

### Test Checklist

- [ ] Changes work as expected
- [ ] No breaking changes to existing functionality
- [ ] Error messages are clear and helpful
- [ ] Dry-run mode accurately reflects what would happen

## Pull Request Guidelines

### Before Submitting

- Ensure your code follows the coding standards
- Test your changes thoroughly
- Update documentation if needed
- Keep PRs focused on a single change

### PR Description

Include:
- What the change does
- Why the change is needed
- How to test the change
- Any breaking changes or migration steps

### Review Process

1. A maintainer will review your PR
2. Address any feedback or requested changes
3. Once approved, a maintainer will merge the PR

## Reporting Issues

### Bug Reports

When reporting bugs, include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- SFMC account type (if relevant)
- Node.js version
- Any error messages or logs

### Feature Requests

When requesting features, include:
- Use case description
- Proposed solution (if any)
- Alternative solutions considered

## Questions?

If you have questions about contributing:
- Open a Discussion on GitHub
- Check existing issues for similar questions
- Review the README for usage information

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
