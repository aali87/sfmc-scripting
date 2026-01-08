/**
 * CLI helper utilities for SFMC DE Toolkit scripts
 */

import ora from 'ora';
import chalk from 'chalk';
import { testConnection } from './sfmc-auth.js';

/**
 * Connect to SFMC with a spinner for user feedback
 * @param {object} logger - Logger instance (optional)
 * @param {string} accountId - Account ID to connect to (optional)
 * @returns {Promise<object>} Connection result
 * @throws {Error} If connection fails
 */
export async function connectWithSpinner(logger = null, accountId = null) {
  const spinner = ora('Connecting to SFMC...').start();

  try {
    const connectionResult = await testConnection(logger, accountId);

    if (!connectionResult.success) {
      spinner.fail('Connection failed');
      if (logger) logger.error(connectionResult.error);
      throw new Error(connectionResult.error || 'Connection failed');
    }

    spinner.succeed('Connected to SFMC');
    return connectionResult;
  } catch (error) {
    spinner.fail('Connection failed');
    throw error;
  }
}

export default { connectWithSpinner };
