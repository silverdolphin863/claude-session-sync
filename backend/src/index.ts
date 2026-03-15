/**
 * Claude Session Sync - Cloudflare Workers Backend
 *
 * Handles machine registration, session data storage, and sync operations.
 * All session data is encrypted client-side - server never sees plaintext.
 */

export interface Env {
  MACHINES: KVNamespace;
  SESSION_DATA: R2Bucket;
  ENVIRONMENT: string;
  MAX_MACHINES_PER_USER: string;
  MAX_STORAGE_BYTES_FREE: string;
  MAX_STORAGE_BYTES_PRO: string;
}

interface Machine {
  id: string;
  name: string;
  platform: string;
  hostname: string;
  createdAt: string;
  lastSeen: string;
}

interface UserData {
  machines: Machine[];
  tier: 'free' | 'pro' | 'team';
  storageUsedBytes: number;
}

interface SyncMetadata {
  machineId: string;
  machineName: string;
  timestamp: number;
  checksum: string;
  sizeBytes: number;
  lastPush: number | null;
  lastPull: number | null;
  historyLines: number;
}

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Generate a unique machine ID
function generateMachineId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Hash API key for storage lookup
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Extract and validate API key from request
async function getApiKeyHash(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const apiKey = authHeader.substring(7);
  if (!apiKey || apiKey.length < 32) {
    return null;
  }
  return hashApiKey(apiKey);
}

// Get user data from KV
async function getUserData(env: Env, apiKeyHash: string): Promise<UserData | null> {
  const data = await env.MACHINES.get(`user:${apiKeyHash}`, 'json');
  return data as UserData | null;
}

// Save user data to KV
async function saveUserData(env: Env, apiKeyHash: string, userData: UserData): Promise<void> {
  await env.MACHINES.put(`user:${apiKeyHash}`, JSON.stringify(userData));
}

// Handle OPTIONS preflight
function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// JSON response helper
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Error response helper
function errorResponse(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: corsHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    }

    // All other routes require authentication
    const apiKeyHash = await getApiKeyHash(request);
    if (!apiKeyHash) {
      return errorResponse('Unauthorized: Invalid or missing API key', 401);
    }

    try {
      // Route handling
      if (path === '/machines/register' && request.method === 'POST') {
        return handleRegisterMachine(request, env, apiKeyHash);
      }

      if (path === '/machines' && request.method === 'GET') {
        return handleListMachines(env, apiKeyHash);
      }

      if (path === '/sync/push' && request.method === 'POST') {
        return handlePush(request, env, apiKeyHash);
      }

      if (path === '/sync/pull' && request.method === 'GET') {
        return handlePull(request, env, apiKeyHash);
      }

      if (path === '/sync/status' && request.method === 'GET') {
        return handleSyncStatus(env, apiKeyHash);
      }

      if (path === '/sync/capabilities' && request.method === 'GET') {
        return handleCapabilities();
      }

      if (path === '/sync/push/chunked' && request.method === 'POST') {
        return handlePushChunked(request, env, apiKeyHash);
      }

      if (path === '/sync/pull/chunked' && request.method === 'GET') {
        return handlePullChunked(request, env, apiKeyHash);
      }

      const projectsMatch = path.match(/^\/machines\/([^/]+)\/projects$/);
      if (projectsMatch && request.method === 'GET') {
        return handleListProjects(env, apiKeyHash, projectsMatch[1]);
      }

      return errorResponse('Not found', 404);
    } catch (error) {
      console.error('Request error:', error);
      const message = error instanceof Error ? error.message : 'Internal error';
      return errorResponse(message, 500);
    }
  },
};

/**
 * Register a new machine
 */
async function handleRegisterMachine(
  request: Request,
  env: Env,
  apiKeyHash: string
): Promise<Response> {
  const body = await request.json() as {
    name: string;
    platform: string;
    hostname: string;
  };

  if (!body.name || !body.platform || !body.hostname) {
    return errorResponse('Missing required fields: name, platform, hostname');
  }

  // Get or create user data
  let userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    userData = {
      machines: [],
      tier: 'free',
      storageUsedBytes: 0,
    };
  }

  // Check machine limit
  const maxMachines = parseInt(env.MAX_MACHINES_PER_USER || '10');
  if (userData.machines.length >= maxMachines) {
    return errorResponse(`Machine limit reached (${maxMachines})`, 403);
  }

  // Check if machine with same hostname already exists
  const existingMachine = userData.machines.find(
    m => m.hostname === body.hostname && m.platform === body.platform
  );

  if (existingMachine) {
    // Update existing machine
    existingMachine.name = body.name;
    existingMachine.lastSeen = new Date().toISOString();
    await saveUserData(env, apiKeyHash, userData);
    return jsonResponse({ machineId: existingMachine.id });
  }

  // Create new machine
  const machineId = generateMachineId();
  const machine: Machine = {
    id: machineId,
    name: body.name,
    platform: body.platform,
    hostname: body.hostname,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  userData.machines.push(machine);
  await saveUserData(env, apiKeyHash, userData);

  return jsonResponse({ machineId });
}

/**
 * List all machines for the user
 */
async function handleListMachines(env: Env, apiKeyHash: string): Promise<Response> {
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return jsonResponse([]);
  }

  return jsonResponse(userData.machines);
}

/**
 * Push encrypted session data
 */
async function handlePush(
  request: Request,
  env: Env,
  apiKeyHash: string
): Promise<Response> {
  const body = await request.json() as {
    machineId: string;
    data: unknown;
    timestamp: number;
    checksum: string;
  };

  if (!body.machineId || !body.data || !body.timestamp || !body.checksum) {
    return errorResponse('Missing required fields');
  }

  // Verify machine belongs to user
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return errorResponse('User not found', 404);
  }

  const machine = userData.machines.find(m => m.id === body.machineId);
  if (!machine) {
    return errorResponse('Machine not found', 404);
  }

  // Serialize the data
  const dataString = JSON.stringify(body.data);
  const sizeBytes = new TextEncoder().encode(dataString).length;

  // Check storage limit
  const maxStorage = userData.tier === 'pro'
    ? parseInt(env.MAX_STORAGE_BYTES_PRO)
    : parseInt(env.MAX_STORAGE_BYTES_FREE);

  // Calculate new storage (remove old, add new)
  const existingMeta = await env.MACHINES.get(`meta:${apiKeyHash}:${body.machineId}`, 'json') as SyncMetadata | null;
  const oldSize = existingMeta?.sizeBytes || 0;
  const newTotalStorage = userData.storageUsedBytes - oldSize + sizeBytes;

  if (newTotalStorage > maxStorage) {
    return errorResponse(`Storage limit exceeded. Used: ${newTotalStorage}, Max: ${maxStorage}`, 403);
  }

  // Store encrypted data in R2
  const r2Key = `${apiKeyHash}/${body.machineId}/session.enc`;
  await env.SESSION_DATA.put(r2Key, dataString, {
    customMetadata: {
      checksum: body.checksum,
      timestamp: body.timestamp.toString(),
    },
  });

  // Update metadata
  const metadata: SyncMetadata = {
    machineId: body.machineId,
    machineName: machine.name,
    timestamp: body.timestamp,
    checksum: body.checksum,
    sizeBytes,
    lastPush: Date.now(),
    lastPull: existingMeta?.lastPull || null,
    historyLines: 0, // Client would need to send this
  };

  await env.MACHINES.put(`meta:${apiKeyHash}:${body.machineId}`, JSON.stringify(metadata));

  // Update user storage stats
  userData.storageUsedBytes = newTotalStorage;
  machine.lastSeen = new Date().toISOString();
  await saveUserData(env, apiKeyHash, userData);

  return jsonResponse({ success: true, sizeBytes });
}

/**
 * Pull encrypted session data from another machine
 */
async function handlePull(
  request: Request,
  env: Env,
  apiKeyHash: string
): Promise<Response> {
  const url = new URL(request.url);
  const machineId = url.searchParams.get('machineId');
  const fromMachineId = url.searchParams.get('fromMachineId');
  const since = url.searchParams.get('since');

  if (!machineId || !fromMachineId) {
    return errorResponse('Missing required params: machineId, fromMachineId');
  }

  // Verify both machines belong to user
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return errorResponse('User not found', 404);
  }

  const requestingMachine = userData.machines.find(m => m.id === machineId);
  const sourceMachine = userData.machines.find(m => m.id === fromMachineId);

  if (!requestingMachine || !sourceMachine) {
    return errorResponse('Machine not found', 404);
  }

  // Get metadata to check timestamp
  const metadata = await env.MACHINES.get(`meta:${apiKeyHash}:${fromMachineId}`, 'json') as SyncMetadata | null;

  if (!metadata) {
    return errorResponse('No sync data found for source machine', 404);
  }

  // Check if data is newer than 'since' parameter
  if (since) {
    const sinceTs = parseInt(since);
    if (metadata.timestamp <= sinceTs) {
      return jsonResponse({
        data: null,
        timestamp: metadata.timestamp,
        upToDate: true,
      });
    }
  }

  // Fetch from R2
  const r2Key = `${apiKeyHash}/${fromMachineId}/session.enc`;
  const object = await env.SESSION_DATA.get(r2Key);

  if (!object) {
    return errorResponse('Session data not found', 404);
  }

  const data = await object.json();

  // Update pull timestamp
  metadata.lastPull = Date.now();
  await env.MACHINES.put(`meta:${apiKeyHash}:${fromMachineId}`, JSON.stringify(metadata));

  // Update requesting machine's lastSeen
  requestingMachine.lastSeen = new Date().toISOString();
  await saveUserData(env, apiKeyHash, userData);

  return jsonResponse({
    data,
    timestamp: metadata.timestamp,
    checksum: metadata.checksum,
  });
}

/**
 * Get sync status for all machines
 */
async function handleSyncStatus(env: Env, apiKeyHash: string): Promise<Response> {
  const userData = await getUserData(env, apiKeyHash);
  if (!userData || userData.machines.length === 0) {
    return jsonResponse([]);
  }

  const statusList: SyncMetadata[] = [];

  for (const machine of userData.machines) {
    const metadata = await env.MACHINES.get(`meta:${apiKeyHash}:${machine.id}`, 'json') as SyncMetadata | null;

    if (metadata) {
      statusList.push({
        ...metadata,
        machineName: machine.name,
      });
    } else {
      // Machine registered but never synced
      statusList.push({
        machineId: machine.id,
        machineName: machine.name,
        timestamp: 0,
        checksum: '',
        sizeBytes: 0,
        lastPush: null,
        lastPull: null,
        historyLines: 0,
        storageUsedBytes: 0,
      } as SyncMetadata & { storageUsedBytes: number });
    }
  }

  return jsonResponse(statusList);
}

/**
 * Return server capabilities for chunked sync
 */
function handleCapabilities(): Response {
  return jsonResponse({
    chunkedSync: true,
    maxChunkSizeBytes: 52428800, // 50 MB
  });
}

interface EncryptedBlob {
  version: number;
  nonce: string;
  ciphertext: string;
  compressed?: boolean;
}

interface ChunkMeta {
  chunkType: string;
  chunkId: string;
  timestamp: number;
  sizeBytes: number;
}

interface ChunkManifest {
  chunks: ChunkMeta[];
  updatedAt: number;
}

/**
 * Push chunks to R2, storing each under a separate key
 */
async function handlePushChunked(
  request: Request,
  env: Env,
  apiKeyHash: string
): Promise<Response> {
  const body = await request.json() as {
    machineId: string;
    chunks: Array<{
      chunkType: string;
      chunkId: string;
      timestamp: number;
      data: EncryptedBlob;
      sizeBytes: number;
    }>;
  };

  if (!body.machineId || !Array.isArray(body.chunks)) {
    return errorResponse('Missing required fields: machineId, chunks');
  }

  // Verify machine belongs to user
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return errorResponse('User not found', 404);
  }

  const machine = userData.machines.find(m => m.id === body.machineId);
  if (!machine) {
    return errorResponse('Machine not found', 404);
  }

  // Load existing manifest (if any) to merge
  const manifestKey = `chunks:${apiKeyHash}:${body.machineId}`;
  const existingManifest = await env.MACHINES.get(manifestKey, 'json') as ChunkManifest | null;
  const existingChunksMap = new Map<string, ChunkMeta>(
    (existingManifest?.chunks ?? []).map(c => [c.chunkId, c])
  );

  let totalSizeBytes = 0;

  for (const chunk of body.chunks) {
    if (!chunk.chunkId || !chunk.chunkType || !chunk.data) {
      return errorResponse(`Invalid chunk: missing chunkId, chunkType, or data`);
    }

    const r2Key = `${apiKeyHash}/${body.machineId}/chunks/${chunk.chunkId}.enc`;
    const encoded = JSON.stringify(chunk.data);

    await env.SESSION_DATA.put(r2Key, encoded, {
      customMetadata: {
        chunkType: chunk.chunkType,
        chunkId: chunk.chunkId,
        timestamp: chunk.timestamp.toString(),
        sizeBytes: chunk.sizeBytes.toString(),
      },
    });

    // Upsert into manifest map
    existingChunksMap.set(chunk.chunkId, {
      chunkType: chunk.chunkType,
      chunkId: chunk.chunkId,
      timestamp: chunk.timestamp,
      sizeBytes: chunk.sizeBytes,
    });

    totalSizeBytes += chunk.sizeBytes;
  }

  // Persist updated manifest
  const updatedManifest: ChunkManifest = {
    chunks: Array.from(existingChunksMap.values()),
    updatedAt: Date.now(),
  };
  await env.MACHINES.put(manifestKey, JSON.stringify(updatedManifest));

  // Update machine lastSeen
  machine.lastSeen = new Date().toISOString();
  await saveUserData(env, apiKeyHash, userData);

  return jsonResponse({
    success: true,
    chunksStored: body.chunks.length,
    totalSizeBytes,
  });
}

/**
 * Pull chunks from R2 for a source machine
 */
async function handlePullChunked(
  request: Request,
  env: Env,
  apiKeyHash: string
): Promise<Response> {
  const url = new URL(request.url);
  const machineId = url.searchParams.get('machineId');
  const fromMachineId = url.searchParams.get('fromMachineId');
  const since = url.searchParams.get('since');
  const chunksFilter = url.searchParams.get('chunks'); // comma-separated chunkIds

  if (!machineId || !fromMachineId) {
    return errorResponse('Missing required params: machineId, fromMachineId');
  }

  // Verify both machines belong to user
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return errorResponse('User not found', 404);
  }

  const requestingMachine = userData.machines.find(m => m.id === machineId);
  const sourceMachine = userData.machines.find(m => m.id === fromMachineId);

  if (!requestingMachine || !sourceMachine) {
    return errorResponse('Machine not found', 404);
  }

  // Load chunk manifest for the source machine
  const manifestKey = `chunks:${apiKeyHash}:${fromMachineId}`;
  const manifest = await env.MACHINES.get(manifestKey, 'json') as ChunkManifest | null;

  if (!manifest || manifest.chunks.length === 0) {
    return jsonResponse({ chunks: [], serverTimestamp: Date.now() });
  }

  // Apply filters
  const sinceTs = since ? parseInt(since) : 0;
  const wantedIds = chunksFilter
    ? new Set(chunksFilter.split(',').map(s => s.trim()).filter(Boolean))
    : null;

  const filteredMeta = manifest.chunks.filter(c => {
    if (sinceTs && c.timestamp <= sinceTs) return false;
    if (wantedIds && !wantedIds.has(c.chunkId)) return false;
    return true;
  });

  // Fetch each chunk's data from R2
  const resultChunks: Array<ChunkMeta & { data: unknown }> = [];

  for (const meta of filteredMeta) {
    const r2Key = `${apiKeyHash}/${fromMachineId}/chunks/${meta.chunkId}.enc`;
    const obj = await env.SESSION_DATA.get(r2Key);
    if (!obj) continue;

    const data = await obj.json();
    resultChunks.push({ ...meta, data });
  }

  // Update requesting machine's lastSeen
  requestingMachine.lastSeen = new Date().toISOString();
  await saveUserData(env, apiKeyHash, userData);

  return jsonResponse({
    chunks: resultChunks,
    serverTimestamp: Date.now(),
  });
}

/**
 * List projects for a machine (chunks with chunkType='project')
 */
async function handleListProjects(
  env: Env,
  apiKeyHash: string,
  machineId: string
): Promise<Response> {
  // Verify machine belongs to user
  const userData = await getUserData(env, apiKeyHash);
  if (!userData) {
    return errorResponse('User not found', 404);
  }

  const machine = userData.machines.find(m => m.id === machineId);
  if (!machine) {
    return errorResponse('Machine not found', 404);
  }

  // Load chunk manifest
  const manifestKey = `chunks:${apiKeyHash}:${machineId}`;
  const manifest = await env.MACHINES.get(manifestKey, 'json') as ChunkManifest | null;

  if (!manifest) {
    return jsonResponse({ machineId, projects: [] });
  }

  const projects = manifest.chunks
    .filter(c => c.chunkType === 'project')
    .map(c => ({
      chunkId: c.chunkId,
      // chunkId format: 'project:/path/to/project' — strip the prefix
      path: c.chunkId.startsWith('project:') ? c.chunkId.slice('project:'.length) : c.chunkId,
      timestamp: c.timestamp,
      sizeBytes: c.sizeBytes,
    }));

  return jsonResponse({ machineId, projects });
}
