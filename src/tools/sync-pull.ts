/**
 * sync_pull Tool
 *
 * Pulls Claude session data from another machine.
 * Supports interactive machine/project selection.
 * Data is decrypted client-side after download.
 */

import type { SyncPullParams, SessionData, MergeStrategy, SyncChunk } from '../types.js';
import {
  readAllSessionData,
  appendHistory,
  writeTodos,
  writePlans,
  writeProjects,
  claudeDirExists,
} from '../lib/claude-data.js';
import { decryptSessionData } from '../lib/encryption.js';
import {
  pullData,
  pullDataChunked,
  isConfigured,
  listMachines,
  listProjects,
  getCurrentMachineId,
  getServerCapabilities,
} from '../lib/api-client.js';

export interface SyncPullParamsExtended extends SyncPullParams {
  project?: string;        // Source project to pull
  targetProject?: string;  // Local project to merge into
}

export async function syncPull(params: SyncPullParamsExtended): Promise<string> {
  // Check if Claude directory exists
  if (!(await claudeDirExists())) {
    return 'Error: Claude directory (~/.claude) not found. Is Claude Code installed?';
  }

  // Check if sync is configured
  if (!(await isConfigured())) {
    return `Sync not configured yet.

Run sync_setup first to initialize with a recovery phrase.`;
  }

  const currentMachineId = await getCurrentMachineId();

  // If no machineId provided, show interactive selection
  if (!params.machineId || params.machineId === '') {
    return await showMachineSelection(currentMachineId);
  }

  // If machineId provided but wants to see projects first (no project specified and no mergeStrategy override)
  // For now, just proceed to pull. User can run sync_list_machines first to see projects.

  // Full pull with machine and project specified
  const { machineId, mergeStrategy = 'merge', project, targetProject } = params;

  try {
    // Check server capabilities
    const capabilities = await getServerCapabilities();
    console.error(`Server capabilities: chunkedSync=${capabilities.chunkedSync}`);

    // Get machine name for display
    const machines = await listMachines();
    const sourceMachine = machines.find(m => m.id === machineId);
    const sourceName = sourceMachine?.name || machineId;

    // Read local data for comparison
    const localData = await readAllSessionData();

    let remoteData: SessionData;
    let timestamp: string;
    let useChunked = false;

    // Use chunked sync if supported
    if (capabilities.chunkedSync) {
      useChunked = true;
      console.error('Using chunked pull...');

      const response = await pullDataChunked(machineId, {
        chunkIds: project ? [`project:${project}`] : undefined,
      });

      // Reassemble data from chunks
      remoteData = await reassembleFromChunks(response.chunks);
      timestamp = new Date(response.serverTimestamp).toLocaleString();
    } else {
      // Fall back to legacy pull
      console.error('Using legacy pull...');
      const response = await pullData(machineId);
      remoteData = await decryptSessionData<SessionData>(response.data);
      timestamp = new Date(response.timestamp).toLocaleString();
    }

    // Filter by project if specified (for legacy mode or if we pulled everything)
    let filteredRemoteData = remoteData;
    if (project && !useChunked) {
      filteredRemoteData = filterByProject(remoteData, project);
    }

    // Apply merge strategy
    const result = await applyMerge(
      localData,
      filteredRemoteData,
      mergeStrategy,
      targetProject || project
    );

    const projectInfo = project ? ` (project: ${project})` : '';
    const syncMode = useChunked ? ' (chunked sync)' : '';

    const projectsLine = result.projectsMerged > 0
      ? `\n- Projects synced: ${result.projectsMerged}`
      : '';

    return `Successfully pulled session data from ${sourceName}${projectInfo}${syncMode}

Last updated: ${timestamp}
Merge strategy: ${mergeStrategy}

Changes applied:
- History entries added: ${result.historyAdded}
- Todos merged: ${result.todosMerged}
- Plans merged: ${result.plansMerged}${projectsLine}

${result.conflicts.length > 0 ? `Conflicts detected:\n${result.conflicts.join('\n')}` : 'No conflicts.'}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Pull failed: ${message}`;
  }
}

/**
 * Reassemble SessionData from encrypted chunks
 */
async function reassembleFromChunks(chunks: SyncChunk[]): Promise<SessionData> {
  const data: SessionData = {
    history: [],
    todos: {},
    plans: {},
    projects: {},
    settings: {},
  };

  for (const chunk of chunks) {
    console.error(`  Decrypting chunk: ${chunk.chunkId}...`);

    const decrypted = await decryptSessionData<{
      history?: SessionData['history'];
      todos?: SessionData['todos'];
      plans?: SessionData['plans'];
      project?: string;
    }>(chunk.data);

    switch (chunk.chunkType) {
      case 'history':
        if (decrypted.history) {
          data.history = decrypted.history;
        }
        break;
      case 'todos':
        if (decrypted.todos) {
          data.todos = decrypted.todos;
        }
        break;
      case 'plans':
        if (decrypted.plans) {
          data.plans = decrypted.plans;
        }
        break;
      case 'project':
        if (decrypted.project) {
          // Extract project path from chunkId (e.g., "project:/path/to/project")
          const projectPath = chunk.chunkId.replace('project:', '');
          data.projects[projectPath] = decrypted.project;
        }
        break;
    }
  }

  return data;
}

/**
 * Show interactive machine selection
 */
async function showMachineSelection(currentMachineId: string | null): Promise<string> {
  try {
    const machines = await listMachines();

    if (machines.length === 0) {
      return `No machines registered yet.

Run sync_setup on your other machines with the same recovery phrase first.`;
    }

    // Filter out current machine
    const otherMachines = machines.filter(m => m.id !== currentMachineId);

    if (otherMachines.length === 0) {
      return `Only this machine is registered.

Run sync_setup on your other machines with the same recovery phrase to enable syncing.`;
    }

    let response = `Select a machine to pull from:\n${'─'.repeat(50)}\n\n`;

    for (let i = 0; i < otherMachines.length; i++) {
      const m = otherMachines[i];
      const lastSeen = new Date(m.lastSeen).toLocaleString();
      response += `${i + 1}. ${m.name} (${m.platform})\n`;
      response += `   ID: ${m.id.substring(0, 8)}...\n`;
      response += `   Last seen: ${lastSeen}\n\n`;
    }

    response += `${'─'.repeat(50)}
To pull, run:
  sync_pull machineId="${otherMachines[0].id}"

Or to see available projects first:
  sync_pull machineId="${otherMachines[0].id}"`;

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to list machines: ${message}`;
  }
}

/**
 * Show interactive project selection for a machine
 */
async function showProjectSelection(
  machineId: string,
  currentMachineId: string | null
): Promise<string> {
  try {
    const machines = await listMachines();
    const machine = machines.find(m => m.id === machineId);
    const machineName = machine?.name || machineId;

    // Try to get project list from server
    let projects: Array<{
      path: string;
      historyCount: number;
      todoCount: number;
      lastModified: number;
      sizeBytes: number;
    }> = [];

    try {
      projects = await listProjects(machineId);
    } catch {
      // Server might not support project listing yet
      // Fall back to full sync option only
    }

    let response = `Projects on ${machineName}:\n${'─'.repeat(50)}\n\n`;

    if (projects.length === 0) {
      response += `No project data available (server may not support project listing).\n\n`;
      response += `To pull everything from ${machineName}:\n`;
      response += `  sync_pull machineId="${machineId}" mergeStrategy="merge"\n`;
      return response;
    }

    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const lastMod = new Date(p.lastModified).toLocaleString();
      const size = formatBytes(p.sizeBytes);
      response += `${i + 1}. ${p.path}\n`;
      response += `   History: ${p.historyCount} entries, Todos: ${p.todoCount}\n`;
      response += `   Last modified: ${lastMod} (${size})\n\n`;
    }

    response += `${'─'.repeat(50)}

To pull a specific project:
  sync_pull machineId="${machineId}" project="${projects[0]?.path || '/path/to/project'}"

To pull everything:
  sync_pull machineId="${machineId}" mergeStrategy="merge"

To pull and map to a different local project:
  sync_pull machineId="${machineId}" project="RemoteProject" targetProject="LocalProject"`;

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to list projects: ${message}`;
  }
}

/**
 * Filter session data to only include a specific project
 */
function filterByProject(data: SessionData, projectPath: string): SessionData {
  const normalizedPath = projectPath.toLowerCase();

  return {
    history: data.history.filter(h =>
      h.project?.toLowerCase().includes(normalizedPath)
    ),
    todos: Object.fromEntries(
      Object.entries(data.todos).filter(([key]) =>
        key.toLowerCase().includes(normalizedPath)
      )
    ),
    plans: Object.fromEntries(
      Object.entries(data.plans).filter(([key]) =>
        key.toLowerCase().includes(normalizedPath)
      )
    ),
    projects: Object.fromEntries(
      Object.entries(data.projects).filter(([key]) =>
        key.toLowerCase().includes(normalizedPath)
      )
    ),
    settings: data.settings,
  };
}

interface MergeResult {
  historyAdded: number;
  todosMerged: number;
  plansMerged: number;
  projectsMerged: number;
  conflicts: string[];
}

async function applyMerge(
  local: SessionData,
  remote: SessionData,
  strategy: MergeStrategy,
  targetProject?: string
): Promise<MergeResult> {
  const result: MergeResult = {
    historyAdded: 0,
    todosMerged: 0,
    plansMerged: 0,
    projectsMerged: 0,
    conflicts: [],
  };

  // Merge history (append new entries based on timestamp)
  const localTimestamps = new Set(local.history.map(h => h.timestamp));
  let newHistory = remote.history.filter(h => !localTimestamps.has(h.timestamp));

  // Remap project paths if targetProject specified
  if (targetProject) {
    newHistory = newHistory.map(h => ({
      ...h,
      project: targetProject,
    }));
  }

  if (newHistory.length > 0) {
    await appendHistory(newHistory);
    result.historyAdded = newHistory.length;
  }

  // Merge todos based on strategy
  if (strategy === 'overwrite') {
    // Replace local with remote
    await writeTodos(remote.todos);
    result.todosMerged = Object.keys(remote.todos).length;
  } else if (strategy === 'merge') {
    // Combine both, remote wins on conflict
    const mergedTodos = { ...local.todos, ...remote.todos };
    await writeTodos(mergedTodos);
    result.todosMerged = Object.keys(mergedTodos).length;
  } else {
    // 'ask' - just report conflicts for now
    for (const sessionId of Object.keys(remote.todos)) {
      if (local.todos[sessionId]) {
        result.conflicts.push(`- Todo conflict in session ${sessionId.substring(0, 8)}...`);
      }
    }
  }

  // Merge plans based on strategy
  if (strategy === 'overwrite') {
    await writePlans(remote.plans);
    result.plansMerged = Object.keys(remote.plans).length;
  } else if (strategy === 'merge') {
    const mergedPlans = { ...local.plans, ...remote.plans };
    await writePlans(mergedPlans);
    result.plansMerged = Object.keys(mergedPlans).length;
  } else {
    // 'ask' - just report conflicts
    for (const planName of Object.keys(remote.plans)) {
      if (local.plans[planName] && local.plans[planName] !== remote.plans[planName]) {
        result.conflicts.push(`- Plan conflict: ${planName}`);
      }
    }
  }

  // Merge projects (full conversation context)
  if (Object.keys(remote.projects).length > 0) {
    if (strategy === 'overwrite') {
      await writeProjects(remote.projects);
      result.projectsMerged = Object.keys(remote.projects).length;
    } else if (strategy === 'merge') {
      // For projects, remote always wins (we want the full context)
      const mergedProjects = { ...local.projects, ...remote.projects };
      await writeProjects(mergedProjects);
      result.projectsMerged = Object.keys(remote.projects).length;
    } else {
      // 'ask' - report which projects would be synced
      for (const projectKey of Object.keys(remote.projects)) {
        if (local.projects[projectKey]) {
          result.conflicts.push(`- Project would be updated: ${projectKey}`);
        }
      }
    }
  }

  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
