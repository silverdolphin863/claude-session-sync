#!/usr/bin/env node

/**
 * Claude Session Sync - MCP Server
 *
 * Syncs Claude Code sessions between machines via encrypted cloud storage.
 *
 * Tools:
 * - sync_setup: Initialize sync with a recovery phrase
 * - sync_push: Push current session to cloud
 * - sync_pull: Pull session from another machine
 * - sync_status: Show sync status across machines
 * - sync_list_machines: List all registered machines
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { syncSetup, type SyncSetupParams } from './tools/sync-setup.js';
import { syncPush } from './tools/sync-push.js';
import { syncPull, type SyncPullParamsExtended } from './tools/sync-pull.js';
import { syncStatus } from './tools/sync-status.js';
import { syncListMachines } from './tools/sync-list.js';
import type { SyncPushParams } from './types.js';

// Server instance
const server = new Server(
  {
    name: 'claude-session-sync',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: 'sync_setup',
    description: 'Initialize sync with a 6-word recovery phrase. Run this first on each machine.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        phrase: {
          type: 'string',
          description: 'Existing 6-word recovery phrase to restore from. If not provided, generates a new one.',
        },
        machineName: {
          type: 'string',
          description: 'Friendly name for this machine (e.g., "Work Laptop", "Home Desktop").',
        },
        serverUrl: {
          type: 'string',
          description: 'Custom sync server URL for self-hosted deployments.',
        },
      },
      required: [],
    },
  },
  {
    name: 'sync_push',
    description: 'Push current Claude session to the sync server. Encrypts data locally before upload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Optional session ID to push. Defaults to current session.',
        },
        project: {
          type: 'string',
          description: 'Optional project path to sync only that project.',
        },
      },
      required: [],
    },
  },
  {
    name: 'sync_pull',
    description: 'Pull Claude session data from another machine. Run with no args to see available machines interactively.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        machineId: {
          type: 'string',
          description: 'ID of the machine to pull from. Omit to see available machines.',
        },
        project: {
          type: 'string',
          description: 'Specific project path to pull. Omit to see available projects or pull everything.',
        },
        targetProject: {
          type: 'string',
          description: 'Local project path to merge into (if different from source project).',
        },
        mergeStrategy: {
          type: 'string',
          enum: ['overwrite', 'merge', 'ask'],
          description: 'How to handle conflicts. "overwrite" replaces local, "merge" combines, "ask" reports conflicts.',
          default: 'merge',
        },
      },
      required: [],
    },
  },
  {
    name: 'sync_status',
    description: 'Show sync status for all machines, including last sync times and storage usage.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'sync_list_machines',
    description: 'List all machines registered with this sync account.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'sync_setup': {
        const params: SyncSetupParams = {
          phrase: args?.phrase as string | undefined,
          machineName: args?.machineName as string | undefined,
          serverUrl: args?.serverUrl as string | undefined,
        };
        const result = await syncSetup(params);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'sync_push': {
        const params: SyncPushParams = {
          sessionId: args?.sessionId as string | undefined,
          project: args?.project as string | undefined,
        };
        const result = await syncPush(params);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'sync_pull': {
        const params: SyncPullParamsExtended = {
          machineId: args?.machineId as string || '',
          project: args?.project as string | undefined,
          targetProject: args?.targetProject as string | undefined,
          mergeStrategy: (args?.mergeStrategy as SyncPullParamsExtended['mergeStrategy']) || 'merge',
        };
        const result = await syncPull(params);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'sync_status': {
        const result = await syncStatus();
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'sync_list_machines': {
        const result = await syncListMachines();
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Claude Session Sync MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
