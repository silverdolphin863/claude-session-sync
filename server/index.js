/**
 * Claude Session Sync - Express Server
 *
 * Simple backend using SQLite for storage.
 * All session data is encrypted client-side.
 */

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync } from 'fs';

const PORT = process.env.PORT || 3847;
const DATA_DIR = process.env.DATA_DIR || './data';

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite database
const db = new Database(`${DATA_DIR}/sync.db`);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    auth_token TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    auth_token TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    hostname TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    last_seen INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (auth_token) REFERENCES users(auth_token)
  );

  CREATE TABLE IF NOT EXISTS sync_data (
    machine_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    checksum TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    FOREIGN KEY (machine_id) REFERENCES machines(id)
  );

  CREATE INDEX IF NOT EXISTS idx_machines_auth ON machines(auth_token);
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }

  const token = auth.slice(7);
  if (!token || token.length < 20) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.authToken = token;

  // Auto-create user if not exists
  const user = db.prepare('SELECT * FROM users WHERE auth_token = ?').get(token);
  if (!user) {
    db.prepare('INSERT INTO users (auth_token) VALUES (?)').run(token);
  }

  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Server capabilities (tells client to use legacy mode)
app.get('/sync/capabilities', authenticate, (req, res) => {
  res.json({ chunkedSync: false, maxChunkSizeBytes: 0 });
});

// Register machine
app.post('/machines/register', authenticate, (req, res) => {
  try {
    const { name, platform, hostname } = req.body;

    if (!name || !platform || !hostname) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if machine already exists for this user
    const existing = db.prepare(`
      SELECT id FROM machines
      WHERE auth_token = ? AND hostname = ? AND platform = ?
    `).get(req.authToken, hostname, platform);

    if (existing) {
      // Update existing machine
      db.prepare(`
        UPDATE machines SET name = ?, last_seen = ? WHERE id = ?
      `).run(name, Date.now(), existing.id);

      return res.json({ machineId: existing.id });
    }

    // Create new machine
    const machineId = randomBytes(16).toString('hex');

    db.prepare(`
      INSERT INTO machines (id, auth_token, name, platform, hostname)
      VALUES (?, ?, ?, ?, ?)
    `).run(machineId, req.authToken, name, platform, hostname);

    res.json({ machineId });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List machines
app.get('/machines', authenticate, (req, res) => {
  try {
    const machines = db.prepare(`
      SELECT id, name, platform, hostname, created_at as createdAt, last_seen as lastSeen
      FROM machines WHERE auth_token = ?
    `).all(req.authToken);

    res.json(machines);
  } catch (error) {
    console.error('List machines error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Push sync data
app.post('/sync/push', authenticate, (req, res) => {
  try {
    const { machineId, data, timestamp, checksum } = req.body;

    if (!machineId || !data || !timestamp || !checksum) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify machine belongs to user
    const machine = db.prepare(`
      SELECT id FROM machines WHERE id = ? AND auth_token = ?
    `).get(machineId, req.authToken);

    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const dataStr = JSON.stringify(data);
    const sizeBytes = Buffer.byteLength(dataStr, 'utf8');

    // Upsert sync data
    db.prepare(`
      INSERT INTO sync_data (machine_id, data, checksum, timestamp, size_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        data = excluded.data,
        checksum = excluded.checksum,
        timestamp = excluded.timestamp,
        size_bytes = excluded.size_bytes
    `).run(machineId, dataStr, checksum, timestamp, sizeBytes);

    // Update machine last_seen
    db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?')
      .run(Date.now(), machineId);

    res.json({ success: true, sizeBytes });
  } catch (error) {
    console.error('Push error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pull sync data
app.get('/sync/pull', authenticate, (req, res) => {
  try {
    const { machineId, fromMachineId, since } = req.query;

    if (!machineId || !fromMachineId) {
      return res.status(400).json({ error: 'Missing machineId or fromMachineId' });
    }

    // Verify both machines belong to user
    const machines = db.prepare(`
      SELECT id FROM machines WHERE auth_token = ? AND id IN (?, ?)
    `).all(req.authToken, machineId, fromMachineId);

    if (machines.length !== 2) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    // Get sync data
    const syncData = db.prepare(`
      SELECT data, checksum, timestamp FROM sync_data WHERE machine_id = ?
    `).get(fromMachineId);

    if (!syncData) {
      return res.status(404).json({ error: 'No sync data found' });
    }

    // Check if up to date
    if (since && syncData.timestamp <= parseInt(since)) {
      return res.json({ data: null, timestamp: syncData.timestamp, upToDate: true });
    }

    // Update requesting machine last_seen
    db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?')
      .run(Date.now(), machineId);

    res.json({
      data: JSON.parse(syncData.data),
      timestamp: syncData.timestamp,
      checksum: syncData.checksum
    });
  } catch (error) {
    console.error('Pull error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync status
app.get('/sync/status', authenticate, (req, res) => {
  try {
    const status = db.prepare(`
      SELECT
        m.id as machineId,
        m.name as machineName,
        s.timestamp as lastPush,
        s.size_bytes as storageUsedBytes,
        0 as historyLines
      FROM machines m
      LEFT JOIN sync_data s ON m.id = s.machine_id
      WHERE m.auth_token = ?
    `).all(req.authToken);

    res.json(status.map(s => ({
      ...s,
      lastPush: s.lastPush || null,
      lastPull: null,
      storageUsedBytes: s.storageUsedBytes || 0
    })));
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List projects for a machine
app.get('/machines/:machineId/projects', authenticate, (req, res) => {
  try {
    const { machineId } = req.params;

    // Verify machine belongs to user
    const machine = db.prepare(`
      SELECT id FROM machines WHERE id = ? AND auth_token = ?
    `).get(machineId, req.authToken);

    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    // Get sync data and extract project info
    const syncData = db.prepare(`
      SELECT data FROM sync_data WHERE machine_id = ?
    `).get(machineId);

    if (!syncData) {
      return res.json([]);
    }

    // Parse and extract project list
    const data = JSON.parse(syncData.data);
    const projects = [];

    if (data.ciphertext) {
      // Data is encrypted, can't list projects server-side
      // Return empty - client will need to decrypt first
      return res.json([]);
    }

    // If somehow unencrypted (shouldn't happen), extract projects
    if (data.projects) {
      for (const [path, entries] of Object.entries(data.projects)) {
        projects.push({
          path,
          historyCount: 0,
          todoCount: 0,
          lastModified: Date.now(),
          sizeBytes: JSON.stringify(entries).length
        });
      }
    }

    res.json(projects);
  } catch (error) {
    console.error('List projects error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Claude Session Sync server running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
