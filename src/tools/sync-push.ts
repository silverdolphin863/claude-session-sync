/**
 * sync_push Tool
 *
 * Pushes current Claude session data to the sync server.
 * Data is encrypted client-side before upload.
 */

import type { SyncPushParams } from '../types.js';
import {
  readAllSessionData,
  getStorageStats,
  claudeDirExists,
} from '../lib/claude-data.js';
import {
  encryptSessionData,
  generateChecksum,
} from '../lib/encryption.js';
import {
  pushData,
  isConfigured,
  getCurrentMachineName,
} from '../lib/api-client.js';

export async function syncPush(params: SyncPushParams): Promise<string> {
  // Check if Claude directory exists
  if (!(await claudeDirExists())) {
    return 'Error: Claude directory (~/.claude) not found. Is Claude Code installed?';
  }

  // Check if sync is configured
  if (!(await isConfigured())) {
    return `Sync not configured yet.

To set up sync:
1. Get an API key from https://claude-sync.regios.org
2. Run: claude mcp configure claude-session-sync --api-key YOUR_KEY

Or contact support@regios.org for help.`;
  }

  const machineName = await getCurrentMachineName() || 'this machine';

  try {
    // Get stats before sync
    const stats = await getStorageStats();

    // Read session data (projects are skipped - too large)
    const sessionData = await readAllSessionData({
      includeProjects: false,  // Projects are 100MB+ each, skip by default
      maxHistoryEntries: 1000, // Only sync recent history
    });

    // Encrypt the data
    const encrypted = await encryptSessionData(sessionData);

    // Generate checksum for integrity
    const checksum = generateChecksum(JSON.stringify(sessionData));

    // Push to server
    await pushData(encrypted, checksum);

    // Format success message
    return `Successfully pushed session data from ${machineName}

Synced:
- History: ${sessionData.history.length.toLocaleString()} recent entries (of ${stats.historyLines.toLocaleString()} total)
- Todos: ${Object.keys(sessionData.todos).length.toLocaleString()} sessions
- Plans: ${Object.keys(sessionData.plans).length.toLocaleString()} plans

Data is encrypted end-to-end. The server never sees your conversation content.

Note: Project-specific data is not synced (too large). Use sync_pull to pull history/todos between machines.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Push failed: ${message}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
