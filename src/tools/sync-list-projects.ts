/**
 * sync_list_projects Tool
 *
 * Lists available local projects with human-readable names and sizes.
 */

import {
  listAvailableProjects,
  formatBytes,
  claudeDirExists,
} from '../lib/claude-data.js';

export async function syncListProjects(): Promise<string> {
  // Check if Claude directory exists
  if (!(await claudeDirExists())) {
    return 'Error: Claude directory (~/.claude) not found. Is Claude Code installed?';
  }

  try {
    const projects = await listAvailableProjects();

    if (projects.length === 0) {
      return 'No projects found in ~/.claude/projects/';
    }

    // Build nice table output
    let output = `Local Projects (${projects.length} total)\n`;
    output += '─'.repeat(60) + '\n\n';

    // Calculate column widths
    const nameWidth = Math.max(...projects.map(p => p.displayName.length), 12);

    for (const project of projects) {
      const size = formatBytes(project.sizeBytes);
      const sessions = `${project.sessionCount} sessions`;
      output += `  ${project.displayName.padEnd(nameWidth)}  ${size.padStart(10)}  (${sessions})\n`;
    }

    output += '\n' + '─'.repeat(60) + '\n';
    output += `\nUse sync_push with projects parameter to include project data:\n`;
    output += `  sync_push projects=["${projects[0]?.displayName || 'ProjectName'}"]`;

    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to list projects: ${message}`;
  }
}
