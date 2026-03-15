/**
 * Claude Session Sync - Type Definitions
 */

// Machine registration
export interface Machine {
  id: string;
  name: string;
  platform: 'win32' | 'darwin' | 'linux';
  hostname: string;
  lastSeen: number;
  createdAt: number;
}

// Sync status for a machine
export interface SyncStatus {
  machineId: string;
  machineName: string;
  lastPush: number | null;
  lastPull: number | null;
  historyLines: number;
  todoCount: number;
  planCount: number;
  projectCount: number;
  storageUsedBytes: number;
}

// Session data that gets synced
export interface SessionData {
  history: HistoryEntry[];
  todos: Record<string, TodoItem[]>;  // sessionId -> todos
  plans: Record<string, string>;       // planName -> content
  projects: Record<string, string>;    // projectPath -> raw JSONL content
  settings: ClaudeSettings;
}

// Single history entry from history.jsonl
export interface HistoryEntry {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project?: string;
}

// Todo item structure
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

// Project JSONL entry
export interface ProjectEntry {
  type: 'summary' | 'file-history-snapshot';
  summary?: string;
  leafUuid?: string;
  messageId?: string;
  snapshot?: Record<string, unknown>;
  isSnapshotUpdate?: boolean;
}

// Claude settings.json structure
export interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  hasCompletedOnboarding?: boolean;
  [key: string]: unknown;
}

// Encrypted blob for transport
export interface EncryptedBlob {
  version: 1 | 2;     // v1 = random key, v2 = passphrase-derived
  nonce: string;      // base64
  ciphertext: string; // base64
  compressed?: boolean;
}

// Sync request/response types
export interface PushRequest {
  machineId: string;
  data: EncryptedBlob;
  timestamp: number;
  checksum: string;
}

export interface PullRequest {
  machineId: string;
  fromMachineId: string;
  lastKnownTimestamp?: number;
}

export interface PullResponse {
  data: EncryptedBlob;
  timestamp: number;
  checksum: string;
}

// Conflict detection
export interface ConflictInfo {
  type: 'history' | 'todo' | 'plan' | 'settings';
  localTimestamp: number;
  remoteTimestamp: number;
  description: string;
}

export type MergeStrategy = 'overwrite' | 'merge' | 'ask';

// Chunked sync types
export type ChunkType = 'history' | 'todos' | 'plans' | 'project' | 'settings';

export interface SyncChunk {
  chunkType: ChunkType;
  chunkId: string;           // Unique ID (e.g., "history", "todos", "project:/path/to/project")
  timestamp: number;
  data: EncryptedBlob;       // Each chunk is encrypted separately
  sizeBytes: number;
}

export interface ServerCapabilities {
  chunkedSync: boolean;
  maxChunkSizeBytes: number;
}

export interface ChunkedPushRequest {
  machineId: string;
  chunks: SyncChunk[];
  checksum?: string;
}

export interface ChunkedPushResponse {
  success: boolean;
  chunksStored: number;
  totalSizeBytes: number;
}

export interface ChunkedPullResponse {
  chunks: SyncChunk[];
  serverTimestamp: number;
}

// Tool parameter types
export interface SyncPushParams {
  sessionId?: string;
  project?: string;
}

export interface SyncPullParams {
  machineId: string;
  mergeStrategy?: MergeStrategy;
}

export interface SyncStatusParams {
  // No parameters
}

export interface SyncListMachinesParams {
  // No parameters
}
