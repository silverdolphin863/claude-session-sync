/**
 * sync_push Tool
 *
 * Pushes current Claude session data to the sync server.
 * Data is encrypted client-side before upload.
 * Supports syncing specific projects with full conversation context.
 */

import type { SyncPushParams, SyncChunk, ChunkType, EncryptedBlob } from '../types.js';
import {
  readAllSessionData,
  getStorageStats,
  claudeDirExists,
  readProjects,
  getProjectDisplayName,
  formatBytes,
} from '../lib/claude-data.js';
import {
  encryptSessionData,
} from '../lib/encryption.js';
import {
  pushData,
  pushDataChunked,
  isConfigured,
  getCurrentMachineName,
  getServerCapabilities,
} from '../lib/api-client.js';

export interface SyncPushParamsExtended extends SyncPushParams {
  projects?: string[];  // Project names to include (e.g., ["StarWhisper", "Lunoo"])
}

export async function syncPush(params: SyncPushParamsExtended): Promise<string> {
  // Check if Claude directory exists
  if (!(await claudeDirExists())) {
    return 'Error: Claude directory (~/.claude) not found. Is Claude Code installed?';
  }

  // Check if sync is configured
  if (!(await isConfigured())) {
    return `Sync not configured yet.

Run sync_setup first to initialize with a recovery phrase.`;
  }

  const machineName = await getCurrentMachineName() || 'this machine';

  try {
    // Check server capabilities
    const capabilities = await getServerCapabilities();
    console.error(`Server capabilities: chunkedSync=${capabilities.chunkedSync}`);

    // Get stats before sync
    const stats = await getStorageStats();

    // Read session data
    const sessionData = await readAllSessionData({
      includeProjects: false,  // We'll add projects separately if specified
      maxHistoryEntries: 1000, // Only sync recent history
    });

    // If specific projects requested, read those project folders
    let projectsIncluded: string[] = [];
    if (params.projects && params.projects.length > 0) {
      console.error(`Reading projects: ${params.projects.join(', ')}...`);
      const projectData = await readProjects(params.projects);
      sessionData.projects = projectData;
      // Get human-readable names
      const folderNames = [...new Set(Object.keys(projectData).map(k => k.split('/')[0]))];
      projectsIncluded = folderNames.map(f => getProjectDisplayName(f));
    }

    // Use chunked sync if supported
    if (capabilities.chunkedSync) {
      return await pushChunked(sessionData, machineName, stats, projectsIncluded);
    }

    // Fall back to legacy single-blob push
    return await pushLegacy(sessionData, machineName, stats, projectsIncluded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Push failed: ${message}`;
  }
}

/**
 * Push using chunked sync (breaks data into separate encrypted chunks)
 */
async function pushChunked(
  sessionData: Awaited<ReturnType<typeof readAllSessionData>>,
  machineName: string,
  stats: Awaited<ReturnType<typeof getStorageStats>>,
  projectsIncluded: string[]
): Promise<string> {
  const chunks: SyncChunk[] = [];
  const timestamp = Date.now();

  console.error('Using chunked sync...');

  // Create chunk for history
  if (sessionData.history.length > 0) {
    console.error(`  Encrypting history (${sessionData.history.length} entries)...`);
    const historyEncrypted = await encryptSessionData({ history: sessionData.history });
    chunks.push({
      chunkType: 'history',
      chunkId: 'history',
      timestamp,
      data: historyEncrypted,
      sizeBytes: Buffer.byteLength(historyEncrypted.ciphertext, 'utf8'),
    });
  }

  // Create chunk for todos
  if (Object.keys(sessionData.todos).length > 0) {
    console.error(`  Encrypting todos (${Object.keys(sessionData.todos).length} sessions)...`);
    const todosEncrypted = await encryptSessionData({ todos: sessionData.todos });
    chunks.push({
      chunkType: 'todos',
      chunkId: 'todos',
      timestamp,
      data: todosEncrypted,
      sizeBytes: Buffer.byteLength(todosEncrypted.ciphertext, 'utf8'),
    });
  }

  // Create chunk for plans
  if (Object.keys(sessionData.plans).length > 0) {
    console.error(`  Encrypting plans (${Object.keys(sessionData.plans).length} plans)...`);
    const plansEncrypted = await encryptSessionData({ plans: sessionData.plans });
    chunks.push({
      chunkType: 'plans',
      chunkId: 'plans',
      timestamp,
      data: plansEncrypted,
      sizeBytes: Buffer.byteLength(plansEncrypted.ciphertext, 'utf8'),
    });
  }

  // Create chunk for each project separately (they can be large)
  for (const [projectKey, content] of Object.entries(sessionData.projects)) {
    const displayName = getProjectDisplayName(projectKey.split('/')[0]);
    const sizeMB = (Buffer.byteLength(content, 'utf8') / (1024 * 1024)).toFixed(1);
    console.error(`  Encrypting project: ${displayName} (${sizeMB} MB)...`);

    const projectEncrypted = await encryptSessionData({ project: content });
    chunks.push({
      chunkType: 'project',
      chunkId: `project:${projectKey}`,
      timestamp,
      data: projectEncrypted,
      sizeBytes: Buffer.byteLength(projectEncrypted.ciphertext, 'utf8'),
    });
  }

  console.error(`Uploading ${chunks.length} chunks to server...`);

  // Push all chunks
  const result = await pushDataChunked(chunks);

  // Format success message
  const projectInfo = projectsIncluded.length > 0
    ? `\n- Projects: ${projectsIncluded.length} (${projectsIncluded.join(', ')})`
    : '';

  const totalSizeMB = (result.totalSizeBytes / (1024 * 1024)).toFixed(1);

  return `Successfully pushed session data from ${machineName} (chunked sync)

Synced:
- History: ${sessionData.history.length.toLocaleString()} recent entries (of ${stats.historyLines.toLocaleString()} total)
- Todos: ${Object.keys(sessionData.todos).length.toLocaleString()} sessions
- Plans: ${Object.keys(sessionData.plans).length.toLocaleString()} plans${projectInfo}
- Chunks: ${result.chunksStored}
- Upload size: ${totalSizeMB} MB (encrypted)

Data is encrypted end-to-end. The server never sees your conversation content.`;
}

/**
 * Push using legacy single-blob method (for backward compatibility)
 */
async function pushLegacy(
  sessionData: Awaited<ReturnType<typeof readAllSessionData>>,
  machineName: string,
  stats: Awaited<ReturnType<typeof getStorageStats>>,
  projectsIncluded: string[]
): Promise<string> {
  // Estimate size from project data without creating full JSON string
  let estimatedSize = 0;
  for (const content of Object.values(sessionData.projects)) {
    estimatedSize += Buffer.byteLength(content, 'utf8');
  }
  // Add overhead for history, todos, plans (usually much smaller)
  estimatedSize += 5 * 1024 * 1024; // 5MB buffer for other data
  const dataSizeMB = (estimatedSize / (1024 * 1024)).toFixed(1);

  console.error(`Encrypting ~${dataSizeMB} MB of data (legacy mode)...`);

  // Encrypt the data (handles large data with buffers internally)
  const encrypted = await encryptSessionData(sessionData);

  // Generate checksum from encrypted ciphertext (avoids creating massive JSON string)
  const checksum = encrypted.ciphertext.slice(0, 64);

  console.error('Uploading to server...');

  // Push to server
  await pushData(encrypted, checksum);

  // Format success message
  const projectInfo = projectsIncluded.length > 0
    ? `\n- Projects: ${projectsIncluded.length} (${projectsIncluded.join(', ')})`
    : '';

  return `Successfully pushed session data from ${machineName}

Synced:
- History: ${sessionData.history.length.toLocaleString()} recent entries (of ${stats.historyLines.toLocaleString()} total)
- Todos: ${Object.keys(sessionData.todos).length.toLocaleString()} sessions
- Plans: ${Object.keys(sessionData.plans).length.toLocaleString()} plans${projectInfo}
- Upload size: ~${dataSizeMB} MB (compressed)

Data is encrypted end-to-end. The server never sees your conversation content.`;
}

// formatBytes is now imported from claude-data.js
