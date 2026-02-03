/**
 * sync_setup Tool
 *
 * Initialize sync with a recovery phrase.
 * Generates a new phrase or accepts an existing one.
 */

import {
  generateRecoveryPhrase,
  initializeWithPhrase,
  isInitialized,
} from '../lib/encryption.js';
import { registerMachine } from '../lib/api-client.js';

export interface SyncSetupParams {
  phrase?: string;        // Existing phrase to restore from
  machineName?: string;   // Name for this machine
  serverUrl?: string;     // Custom server URL (self-hosted)
}

export async function syncSetup(params: SyncSetupParams): Promise<string> {
  const { phrase, machineName, serverUrl } = params;

  try {
    // Check if already initialized
    if (await isInitialized()) {
      return `Sync already initialized on this machine.

To reset, delete ~/.claude/sync-keys.json and run sync_setup again.
WARNING: You'll need your recovery phrase to access existing synced data.`;
    }

    // Generate new phrase or use provided one
    const recoveryPhrase = phrase || generateRecoveryPhrase();
    const isNewPhrase = !phrase;

    // Initialize encryption with the phrase
    const { accountId, authToken } = await initializeWithPhrase(recoveryPhrase);

    // Register this machine with the server
    const machineId = await registerMachine(authToken, machineName, serverUrl);

    // Build response
    let response = `Sync initialized successfully!

Account ID: ${accountId}
Machine ID: ${machineId.substring(0, 8)}...
`;

    if (isNewPhrase) {
      response += `
┌─────────────────────────────────────────────────────────────┐
│  RECOVERY PHRASE - SAVE THIS SECURELY!                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ${recoveryPhrase.padEnd(55)}│
│                                                             │
│  • Write this down and store safely                         │
│  • You need this to sync on other machines                  │
│  • Cannot be recovered if lost                              │
│  • Never share with anyone                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
`;
    } else {
      response += `
Restored from existing phrase. Your synced data is now accessible.
`;
    }

    response += `
Next steps:
1. On other machines, run: sync_setup phrase="${recoveryPhrase}"
2. Push this machine's data: sync_push
3. Pull from other machines: sync_pull`;

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Setup failed: ${message}`;
  }
}
