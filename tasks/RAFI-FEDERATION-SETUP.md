# LAN Federation Setup for Rafi's Mac

Claude-peers-mcp now supports LAN federation — Claude Code sessions on different machines can discover each other and exchange messages.

## Step 1: Update the repo
```bash
cd ~/MCPs/claude-peers-mcp
git pull origin main
bun install
```

If not cloned yet:
```bash
git clone https://github.com/RichelynScott/claude-peers-mcp.git
cd claude-peers-mcp
bun install
```

## Step 2: Install the shared PSK token
Both machines must share the same token for authentication:
```bash
echo 'c5aa534cc2d5fb0c0cf64a868a5dc1544eb4810686e789a3cb0b3a405ba95c22' > ~/.claude-peers-token
chmod 600 ~/.claude-peers-token
```

## Step 3: Enable federation
```bash
echo 'export CLAUDE_PEERS_FEDERATION_ENABLED=true' >> ~/.zshrc
source ~/.zshrc
```

## Step 4: Restart broker
```bash
cd ~/MCPs/claude-peers-mcp
bun src/cli.ts kill-broker
```
Next Claude session auto-restarts it with federation. Look for in MCP logs:
`[CPM-federation] Listening on 0.0.0.0:7900 (TLS)`

## Step 5: macOS firewall
macOS may prompt to allow connections on port 7900. Accept it. Or manually:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which bun) --unblockapp $(which bun)
```

## Step 6: Tell Riche your Mac's IP
Run `ifconfig | grep "inet " | grep -v 127.0.0.1` to find your LAN IP.

Then Riche runs from his machine:
```bash
cd ~/MCPs/claude-peers-mcp
bun src/cli.ts federation connect <your-mac-ip>:7900
```

## Verify
Both machines:
- `bun src/cli.ts federation status` — shows connection
- In any Claude session: `list_peers(scope="lan")` — shows cross-machine peers
- `send_message` to a remote peer ID (format: `hostname:peer_id`)
