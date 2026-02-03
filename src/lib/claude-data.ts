/**
 * Claude Data Reader/Writer
 *
 * Handles reading and writing Claude Code's local data from ~/.claude/
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  SessionData,
  HistoryEntry,
  TodoItem,
  ProjectEntry,
  ClaudeSettings,
} from '../types.js';

// Get Claude directory path
export function getClaudeDir(): string {
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(home, '.claude')
    : path.join(home, '.claude');
}

// Check if Claude directory exists
export async function claudeDirExists(): Promise<boolean> {
  try {
    await fs.access(getClaudeDir());
    return true;
  } catch {
    return false;
  }
}

// Read history.jsonl (limited to recent entries to avoid memory issues)
export async function readHistory(maxEntries: number = 1000): Promise<HistoryEntry[]> {
  const historyPath = path.join(getClaudeDir(), 'history.jsonl');

  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Only take the most recent entries (last N lines)
    const recentLines = lines.slice(-maxEntries);

    return recentLines.map((line) => {
      try {
        return JSON.parse(line) as HistoryEntry;
      } catch {
        console.error('Failed to parse history line:', line.substring(0, 100));
        return null;
      }
    }).filter((entry): entry is HistoryEntry => entry !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Write history.jsonl (append mode for incremental sync)
export async function appendHistory(entries: HistoryEntry[]): Promise<void> {
  const historyPath = path.join(getClaudeDir(), 'history.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(historyPath, content, 'utf-8');
}

// Read all todos
export async function readTodos(): Promise<Record<string, TodoItem[]>> {
  const todosDir = path.join(getClaudeDir(), 'todos');
  const todos: Record<string, TodoItem[]> = {};

  try {
    const files = await fs.readdir(todosDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(todosDir, file);
        const content = await fs.readFile(filePath, 'utf-8');

        try {
          const sessionId = file.replace('.json', '');
          todos[sessionId] = JSON.parse(content) as TodoItem[];
        } catch {
          console.error('Failed to parse todo file:', file);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return todos;
}

// Write todos
export async function writeTodos(todos: Record<string, TodoItem[]>): Promise<void> {
  const todosDir = path.join(getClaudeDir(), 'todos');
  await fs.mkdir(todosDir, { recursive: true });

  for (const [sessionId, items] of Object.entries(todos)) {
    const filePath = path.join(todosDir, `${sessionId}.json`);
    await fs.writeFile(filePath, JSON.stringify(items, null, 2), 'utf-8');
  }
}

// Read all plans
export async function readPlans(): Promise<Record<string, string>> {
  const plansDir = path.join(getClaudeDir(), 'plans');
  const plans: Record<string, string> = {};

  try {
    const files = await fs.readdir(plansDir);

    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(plansDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const planName = file.replace('.md', '');
        plans[planName] = content;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return plans;
}

// Write plans
export async function writePlans(plans: Record<string, string>): Promise<void> {
  const plansDir = path.join(getClaudeDir(), 'plans');
  await fs.mkdir(plansDir, { recursive: true });

  for (const [planName, content] of Object.entries(plans)) {
    const filePath = path.join(plansDir, `${planName}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

// Read project data
export async function readProjects(): Promise<Record<string, ProjectEntry[]>> {
  const projectsDir = path.join(getClaudeDir(), 'projects');
  const projects: Record<string, ProjectEntry[]> = {};

  try {
    const projectFolders = await fs.readdir(projectsDir);

    for (const folder of projectFolders) {
      const folderPath = path.join(projectsDir, folder);
      const stat = await fs.stat(folderPath);

      if (stat.isDirectory()) {
        const files = await fs.readdir(folderPath);

        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const filePath = path.join(folderPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);

            const entries = lines.map((line) => {
              try {
                return JSON.parse(line) as ProjectEntry;
              } catch {
                return null;
              }
            }).filter((e): e is ProjectEntry => e !== null);

            const projectKey = `${folder}/${file}`;
            projects[projectKey] = entries;
          }
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return projects;
}

// Read settings
export async function readSettings(): Promise<ClaudeSettings> {
  const settingsPath = path.join(getClaudeDir(), 'settings.json');

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    return {};
  }
}

// Write settings (merge with existing)
export async function writeSettings(settings: ClaudeSettings): Promise<void> {
  const settingsPath = path.join(getClaudeDir(), 'settings.json');
  const existing = await readSettings();
  const merged = { ...existing, ...settings };
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
}

// Read all session data (projects skipped by default - too large)
export async function readAllSessionData(options: {
  includeProjects?: boolean;
  maxHistoryEntries?: number;
} = {}): Promise<SessionData> {
  const { includeProjects = false, maxHistoryEntries = 1000 } = options;

  const [history, todos, plans, settings] = await Promise.all([
    readHistory(maxHistoryEntries),
    readTodos(),
    readPlans(),
    readSettings(),
  ]);

  // Projects are skipped by default (can be 100MB+ each)
  const projects = includeProjects ? await readProjects() : {};

  return { history, todos, plans, projects, settings };
}

// Get storage stats (lightweight version that doesn't load full data)
export async function getStorageStats(): Promise<{
  historyLines: number;
  todoCount: number;
  planCount: number;
  projectCount: number;
  totalSizeBytes: number;
}> {
  const claudeDir = getClaudeDir();

  async function getDirSize(dir: string): Promise<number> {
    let size = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const stat = await fs.stat(entryPath);
          size += stat.size;
        } else if (entry.isDirectory()) {
          size += await getDirSize(entryPath);
        }
      }
    } catch {
      // Ignore errors
    }
    return size;
  }

  // Count history lines without loading full content
  let historyLines = 0;
  try {
    const historyPath = path.join(claudeDir, 'history.jsonl');
    const content = await fs.readFile(historyPath, 'utf-8');
    historyLines = content.split('\n').filter(Boolean).length;
  } catch {
    // File doesn't exist
  }

  // Count todo files
  let todoCount = 0;
  try {
    const todosDir = path.join(claudeDir, 'todos');
    const files = await fs.readdir(todosDir);
    todoCount = files.filter(f => f.endsWith('.json')).length;
  } catch {
    // Directory doesn't exist
  }

  // Count plan files
  let planCount = 0;
  try {
    const plansDir = path.join(claudeDir, 'plans');
    const files = await fs.readdir(plansDir);
    planCount = files.filter(f => f.endsWith('.md')).length;
  } catch {
    // Directory doesn't exist
  }

  // Count project folders
  let projectCount = 0;
  try {
    const projectsDir = path.join(claudeDir, 'projects');
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectCount = entries.filter(e => e.isDirectory()).length;
  } catch {
    // Directory doesn't exist
  }

  const totalSizeBytes = await getDirSize(claudeDir);

  return {
    historyLines,
    todoCount,
    planCount,
    projectCount,
    totalSizeBytes,
  };
}

// Get machine info
export function getMachineInfo(): { hostname: string; platform: string } {
  return {
    hostname: os.hostname(),
    platform: process.platform,
  };
}
