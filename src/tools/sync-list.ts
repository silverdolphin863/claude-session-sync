/**
 * sync_list_machines Tool
 *
 * Lists all machines registered with this sync account.
 */

import {
  listMachines,
  isConfigured,
  getCurrentMachineId,
} from '../lib/api-client.js';

export async function syncListMachines(): Promise<string> {
  // Check if sync is configured
  if (!(await isConfigured())) {
    return `Sync not configured yet.

Run sync_setup first to initialize with a recovery phrase.`;
  }

  try {
    const machines = await listMachines();
    const currentMachineId = await getCurrentMachineId();

    if (machines.length === 0) {
      return 'No machines registered yet. This machine will be registered on first sync_push.';
    }

    let report = `Registered Machines (${machines.length})\n${'='.repeat(40)}\n`;

    for (const machine of machines) {
      const isThisMachine = machine.id === currentMachineId;
      const marker = isThisMachine ? ' [CURRENT]' : '';
      const lastSeen = new Date(machine.lastSeen).toLocaleString();
      const createdAt = new Date(machine.createdAt).toLocaleDateString();

      report += `
${machine.name}${marker}
  ID: ${machine.id}
  Platform: ${machine.platform}
  Hostname: ${machine.hostname}
  Last seen: ${lastSeen}
  Registered: ${createdAt}
`;
    }

    report += `
${'='.repeat(40)}
To pull from a machine, use:
  sync_pull machineId="<machine-id>"`;

    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to list machines: ${message}`;
  }
}
