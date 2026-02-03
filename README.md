# Claude Session Sync

Sync Claude Code sessions between multiple machines via encrypted cloud storage.

## Features

- **Cross-machine sync**: Work on one machine, continue on another
- **End-to-end encryption**: Your session data is encrypted client-side
- **Selective sync**: Sync specific projects or entire sessions
- **Conflict resolution**: Merge strategies for handling conflicts

## Installation

```bash
npm install -g claude-session-sync
```

Or add to your Claude Code MCP config:

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

## Setup

1. Get an API key from https://claude-sync.regios.org
2. Configure Claude Code:
   ```bash
   claude mcp configure claude-session-sync --api-key YOUR_KEY
   ```

## Tools

### sync_push

Push current session to the cloud.

```
sync_push [project="path/to/project"]
```

### sync_pull

Pull session from another machine.

```
sync_pull machineId="abc123" [mergeStrategy="merge"]
```

Merge strategies:
- `overwrite` - Replace local with remote
- `merge` - Combine both (remote wins conflicts)
- `ask` - Report conflicts without changing

### sync_status

Show sync status across all machines.

### sync_list_machines

List all registered machines.

## What Gets Synced

| Data | Priority | Strategy |
|------|----------|----------|
| history.jsonl | High | Incremental (new entries only) |
| todos/ | High | Full sync per session |
| plans/ | Medium | Full sync |
| projects/*.jsonl | Medium | Per-project selective |
| settings.json | Low | Full sync |

**Never synced**: `.credentials.json`, API keys, machine-specific data

## Security

- All data encrypted with TweetNaCl (XSalsa20-Poly1305)
- Encryption key derived from your API key (never sent to server)
- Server stores only encrypted blobs
- Zero-knowledge architecture

## Self-Hosting

The backend can be deployed to Cloudflare Workers:

```bash
cd backend
npm install
wrangler deploy
```

See `backend/wrangler.toml` for configuration.

## License

MIT (client) / Proprietary (hosted service)
