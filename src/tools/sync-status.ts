/**
 * sync_status Tool
 *
 * Shows sync status for all registered machines.
 */

import {
  getStorageStats,
  claudeDirExists,
  getMachineInfo,
} from '../lib/claude-data.js';
import {
  getSyncStatus,
  isConfigured,
  getCurrentMachineId,
} from '../lib/api-client.js';

export async function syncStatus(): Promise<string> {
  // Check if Claude directory exists
  if (!(await claudeDirExists())) {
    return 'Error: Claude directory (~/.claude) not found. Is Claude Code installed?';
  }

  // Check if sync is configured
  if (!(await isConfigured())) {
    return `Sync not configured yet.

Run sync_setup first to initialize with a recovery phrase.`;
  }

  try {
    const currentMachineId = await getCurrentMachineId();
    const machineInfo = getMachineInfo();
    const localStats = await getStorageStats();

    // Get remote status
    const remoteStatus = await getSyncStatus();

    // Build status report
    let report = `Claude Session Sync Status
${'='.repeat(40)}

This Machine: ${machineInfo.hostname} (${machineInfo.platform})
Machine ID: ${currentMachineId?.substring(0, 8)}...

Local Data:
- History entries: ${localStats.historyLines.toLocaleString()}
- Todos: ${localStats.todoCount.toLocaleString()}
- Plans: ${localStats.planCount.toLocaleString()}
- Projects: ${localStats.projectCount.toLocaleString()}
- Storage used: ${formatBytes(localStats.totalSizeBytes)}

`;

    if (remoteStatus.length === 0) {
      report += 'No sync data found on server. Run sync_push to upload.';
    } else {
      report += `Synced Machines:\n${'-'.repeat(40)}\n`;

      for (const status of remoteStatus) {
        const isThisMachine = status.machineId === currentMachineId;
        const marker = isThisMachine ? ' (this machine)' : '';
        const lastPush = status.lastPush
          ? new Date(status.lastPush).toLocaleString()
          : 'never';
        const lastPull = status.lastPull
          ? new Date(status.lastPull).toLocaleString()
          : 'never';

        report += `
${status.machineName}${marker}
  ID: ${status.machineId.substring(0, 8)}...
  Last push: ${lastPush}
  Last pull: ${lastPull}
  History: ${status.historyLines.toLocaleString()} entries
  Storage: ${formatBytes(status.storageUsedBytes)}
`;
      }
    }

    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to get sync status: ${message}`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
