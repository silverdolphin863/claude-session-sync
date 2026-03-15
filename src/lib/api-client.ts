/**
 * API Client for Sync Backend
 *
 * Handles communication with the sync server.
 * Uses auth token derived from recovery phrase (never the phrase itself).
 */

import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getAuthToken, getAccountId, isInitialized } from './encryption.js';
import type {
  EncryptedBlob,
  Machine,
  SyncStatus,
  PullResponse,
  ServerCapabilities,
  SyncChunk,
  ChunkedPushResponse,
  ChunkedPullResponse,
} from '../types.js';

// Config file path
const CONFIG_PATH = path.join(os.homedir(), '.claude', 'sync-config.json');

// Default backend URL
const DEFAULT_API_URL = 'http://claude-sync.130.162.144.114.nip.io';

interface SyncConfig {
  apiUrl: string;
  machineId: string;
  machineName: string;
}

/**
 * Load sync config
 */
export async function getConfig(): Promise<SyncConfig | null> {
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(content) as SyncConfig;
  } catch {
    return null;
  }
}

/**
 * Save sync config
 */
export async function saveConfig(config: SyncConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Check if sync is configured
 */
export async function isConfigured(): Promise<boolean> {
  const initialized = await isInitialized();
  const config = await getConfig();
  return initialized && config !== null;
}

/**
 * Get machine info for registration
 */
export function getMachineInfo(): { hostname: string; platform: string } {
  return {
    hostname: os.hostname(),
    platform: process.platform,
  };
}

/**
 * Register this machine with the sync service
 */
export async function registerMachine(
  authToken: string,
  machineName?: string,
  serverUrl?: string
): Promise<string> {
  const apiUrl = serverUrl || DEFAULT_API_URL;
  const name = machineName || os.hostname();

  const response = await fetch(`${apiUrl}/machines/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      name,
      platform: process.platform,
      hostname: os.hostname(),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register machine: ${error}`);
  }

  const data = await response.json() as { machineId: string };

  // Save config
  await saveConfig({
    apiUrl,
    machineId: data.machineId,
    machineName: name,
  });

  return data.machineId;
}

/**
 * Push encrypted data to sync server
 * Uses buffer-based JSON construction to handle large data
 */
export async function pushData(data: EncryptedBlob, checksum: string): Promise<void> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  // Build JSON body using buffers to avoid string length limits
  // Structure: {"machineId":"...","data":{"version":2,"nonce":"...","ciphertext":"...","compressed":true},"timestamp":...,"checksum":"..."}
  const parts: Buffer[] = [];

  parts.push(Buffer.from('{"machineId":'));
  parts.push(Buffer.from(JSON.stringify(config.machineId)));
  parts.push(Buffer.from(',"data":{"version":'));
  parts.push(Buffer.from(String(data.version)));
  parts.push(Buffer.from(',"nonce":'));
  parts.push(Buffer.from(JSON.stringify(data.nonce)));
  parts.push(Buffer.from(',"ciphertext":"'));
  // Ciphertext is already base64 encoded, insert directly
  parts.push(Buffer.from(data.ciphertext));
  parts.push(Buffer.from('"'));

  // Add compressed flag if present
  if ((data as { compressed?: boolean }).compressed) {
    parts.push(Buffer.from(',"compressed":true'));
  }

  parts.push(Buffer.from('},"timestamp":'));
  parts.push(Buffer.from(String(Date.now())));
  parts.push(Buffer.from(',"checksum":'));
  parts.push(Buffer.from(JSON.stringify(checksum)));
  parts.push(Buffer.from('}'));

  const bodyBuffer = Buffer.concat(parts);
  console.error(`Request body size: ${(bodyBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  const response = await fetch(`${config.apiUrl}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'Content-Length': String(bodyBuffer.length),
    },
    body: bodyBuffer,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Push failed: ${error}`);
  }
}

/**
 * Pull encrypted data from another machine
 */
export async function pullData(fromMachineId: string, lastKnownTimestamp?: number): Promise<PullResponse> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  const params = new URLSearchParams({
    machineId: config.machineId,
    fromMachineId,
  });

  if (lastKnownTimestamp) {
    params.set('since', lastKnownTimestamp.toString());
  }

  const response = await fetch(`${config.apiUrl}/sync/pull?${params}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Pull failed: ${error}`);
  }

  return await response.json() as PullResponse;
}

/**
 * Get list of machines
 */
export async function listMachines(): Promise<Machine[]> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  const response = await fetch(`${config.apiUrl}/machines`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list machines: ${error}`);
  }

  return await response.json() as Machine[];
}

/**
 * Get sync status for all machines
 */
export async function getSyncStatus(): Promise<SyncStatus[]> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  const response = await fetch(`${config.apiUrl}/sync/status`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get sync status: ${error}`);
  }

  return await response.json() as SyncStatus[];
}

/**
 * Get current machine ID
 */
export async function getCurrentMachineId(): Promise<string | null> {
  const config = await getConfig();
  return config?.machineId || null;
}

/**
 * Get current machine name
 */
export async function getCurrentMachineName(): Promise<string | null> {
  const config = await getConfig();
  return config?.machineName || null;
}

/**
 * List available projects on a machine
 */
export async function listProjects(machineId?: string): Promise<Array<{
  path: string;
  historyCount: number;
  todoCount: number;
  lastModified: number;
  sizeBytes: number;
}>> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();
  const targetMachine = machineId || config.machineId;

  const response = await fetch(`${config.apiUrl}/machines/${targetMachine}/projects`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list projects: ${error}`);
  }

  return await response.json() as Array<{
    path: string;
    historyCount: number;
    todoCount: number;
    lastModified: number;
    sizeBytes: number;
  }>;
}

/**
 * Get server capabilities (check if chunked sync is supported)
 */
export async function getServerCapabilities(): Promise<ServerCapabilities> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  try {
    const response = await fetch(`${config.apiUrl}/sync/capabilities`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      // Server doesn't support capabilities endpoint - assume legacy
      return { chunkedSync: false, maxChunkSizeBytes: 0 };
    }

    return await response.json() as ServerCapabilities;
  } catch {
    // Network error or old server - assume legacy
    return { chunkedSync: false, maxChunkSizeBytes: 0 };
  }
}

/**
 * Push data using chunked sync
 */
export async function pushDataChunked(chunks: SyncChunk[]): Promise<ChunkedPushResponse> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  const body = JSON.stringify({
    machineId: config.machineId,
    chunks: chunks.map(chunk => ({
      chunkType: chunk.chunkType,
      chunkId: chunk.chunkId,
      timestamp: chunk.timestamp,
      data: chunk.data,
      sizeBytes: chunk.sizeBytes,
    })),
  });

  console.error(`Pushing ${chunks.length} chunks (${(Buffer.byteLength(body) / 1024 / 1024).toFixed(1)} MB)...`);

  const response = await fetch(`${config.apiUrl}/sync/push/chunked`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Chunked push failed: ${error}`);
  }

  return await response.json() as ChunkedPushResponse;
}

/**
 * Pull data using chunked sync
 */
export async function pullDataChunked(
  fromMachineId: string,
  options?: {
    since?: number;
    chunkIds?: string[];
  }
): Promise<ChunkedPullResponse> {
  const config = await getConfig();
  if (!config) {
    throw new Error('Sync not configured. Run sync_setup first.');
  }

  const authToken = await getAuthToken();

  const params = new URLSearchParams({
    machineId: config.machineId,
    fromMachineId,
  });

  if (options?.since) {
    params.set('since', options.since.toString());
  }

  if (options?.chunkIds && options.chunkIds.length > 0) {
    params.set('chunks', options.chunkIds.join(','));
  }

  const response = await fetch(`${config.apiUrl}/sync/pull/chunked?${params}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Chunked pull failed: ${error}`);
  }

  return await response.json() as ChunkedPullResponse;
}
