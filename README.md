# Claude Session Sync

Sync your Claude Code sessions between machines with end-to-end encryption.

An [MCP server](https://modelcontextprotocol.io/) that encrypts and syncs your `~/.claude/` data (history, todos, plans, and full project conversation context) across machines using a simple 6-word recovery phrase.

## Why?

If you use Claude Code on multiple machines, you've felt the pain: your conversation history, todos, plans, and project context are stuck on whichever machine you used last. Claude Session Sync fixes that.

## Security Model

Your data never leaves your machine unencrypted:

- **6-word BIP39 recovery phrase** generates two separate keys
- **Auth key** — sent to server for identity verification (never the phrase itself)
- **Encryption key** — used locally for AES encryption, **never transmitted**
- **Server stores only encrypted blobs** — even the server operator can't read your data
- **Gzip compression** before encryption for efficient transfer

## Quick Start

### Install

```bash
npm install -g claude-session-sync
```

### Add to Claude Code

```bash
claude mcp add claude-session-sync -- claude-session-sync
```

Or add manually to your MCP config:

```json
{
  "mcpServers": {
    "claude-session-sync": {
      "command": "npx",
      "args": ["-y", "claude-session-sync"]
    }
  }
}
```

### First Machine Setup

In Claude Code, say:

> Set up session sync

Claude will run `sync_setup` which generates a 6-word recovery phrase:

```
+-------------------------------------------------------------+
|  RECOVERY PHRASE - SAVE THIS SECURELY!                      |
+-------------------------------------------------------------+
|                                                             |
|  apple banana cherry delta echo foxtrot                     |
|                                                             |
|  Write this down and store safely.                          |
|  You need this to sync on other machines.                   |
+-------------------------------------------------------------+
```

Then push your data:

> Push my session data to sync

### Second Machine Setup

Install the MCP server the same way, then in Claude Code:

> Set up session sync with phrase "apple banana cherry delta echo foxtrot"

Then pull:

> Pull my session from my other machine

## Available Tools

| Tool | Description |
|------|-------------|
| `sync_setup` | Initialize with a recovery phrase (new or existing) |
| `sync_push` | Encrypt and upload session data |
| `sync_pull` | Download and decrypt from another machine |
| `sync_status` | Show sync status across all machines |
| `sync_list_machines` | List registered machines |
| `sync_list_projects` | List local projects with sizes |

## Syncing Project Context

By default, only history, todos, and plans are synced (lightweight). To include full project conversation context:

> Push my session data including the StarWhisper and Lunoo projects

This syncs the complete conversation context for those projects, so you can continue exactly where you left off on another machine.

## Self-Hosting the Backend

The sync backend runs on Cloudflare Workers with KV + R2 storage. To self-host:

```bash
cd backend
npm install
# Edit wrangler.toml with your KV namespace ID and R2 bucket
wrangler deploy
```

Then point the client to your instance:

> Set up session sync with server url "https://your-worker.workers.dev"

### Storage Tiers

| Tier | Storage | Machines |
|------|---------|----------|
| Free | 100 MB | 10 |
| Pro | 5 GB | 10 |

## What Gets Synced

| Data | Priority | Strategy |
|------|----------|----------|
| history.jsonl | High | Incremental (new entries only) |
| todos/ | High | Full sync per session |
| plans/ | Medium | Full sync |
| projects/*.jsonl | Medium | Per-project selective |
| settings.json | Low | Full sync |

**Never synced**: `.credentials.json`, API keys, machine-specific data

## How It Works

```
Machine A                    Server                    Machine B
---------                    ------                    ---------
~/.claude/ data
    |
    v
Compress (gzip)
    |
    v
Encrypt (NaCl secretbox)
    |
    v
Upload encrypted blob ------> R2 Storage
                                  |
                        Download encrypted blob <------+
                                  |
                                  v
                          Decrypt (NaCl secretbox)
                                  |
                                  v
                          Decompress (gzip)
                                  |
                                  v
                          Merge into ~/.claude/
```

## Merge Strategies

When pulling, you can choose how conflicts are handled:

- **`merge`** (default) — Combines data, remote wins on conflicts
- **`overwrite`** — Replaces local with remote
- **`ask`** — Reports conflicts without making changes

## Requirements

- Node.js 18+
- Claude Code installed (`~/.claude/` directory exists)

## License

MIT
