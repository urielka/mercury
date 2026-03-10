# MCP Support Inside Docker Containers

Mercury agents can now use external MCP tool servers via [`mcp-cli`](https://github.com/philschmid/mcp-cli) — a lightweight Bun-based CLI that runs inside the agent container.

## Setup

1. **Set the env var** pointing to your MCP servers config file:
   ```bash
   export MERCURY_MCP_SERVERS_CONFIG=/path/to/mcp_servers.json
   ```

2. **Create the config file** using mcp-cli's native format (compatible with Claude Desktop/VS Code):
   ```json
   {
     "mcpServers": {
       "my-tools": { "url": "https://mcp.example.com/sse" },
       "github": {
         "url": "https://mcp-github.example.com/sse",
         "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
       }
     }
   }
   ```
   Any `${VAR}` references in the config are automatically detected and the corresponding host env vars are passed into the container.

3. **Rebuild the Docker image** (if using a local build):
   ```bash
   docker build -t mercury-agent:latest -f container/Dockerfile .
   ```

4. **Send a message** asking the agent to use an MCP tool. The agent auto-discovers the `mcp-cli` skill and knows how to list servers/tools and call them.

## What was changed

| File | Change |
|------|--------|
| `src/config.ts` | Added `mcpServersConfig` field (`MERCURY_MCP_SERVERS_CONFIG` env var) |
| `src/agent/container-runner.ts` | Added `--add-host=host.docker.internal:host-gateway` for Linux host access; mounts MCP config to `/root/.config/mcp/mcp_servers.json:ro`; passes through env vars referenced in config `${VAR}` substitutions |
| `src/agent/container-entry.ts` | Appends MCP Tools hint to system prompt when config file is detected in container |
| `resources/skills/mcp-cli/SKILL.md` | New built-in skill — teaches the agent how to discover and call MCP tools via `mcp-cli` |
| `container/Dockerfile` | Installs `mcp-cli` globally via `bun add -g` |
| `container/Dockerfile.minimal` | Same as above |

## How it works

- `mcp-cli` is installed globally in the Docker image.
- The MCP config file is bind-mounted read-only to `~/.config/mcp/mcp_servers.json` (one of mcp-cli's default search paths — no extra flags needed).
- The `mcp-cli` SKILL.md is installed as a built-in Mercury skill via the existing `installBuiltinSkills()` mechanism, so `pi` auto-discovers it inside the container.
- When the config file is present, the system prompt gets a brief nudge telling the agent about MCP tools.
- `--add-host=host.docker.internal:host-gateway` ensures containers on Linux can reach the host (needed if MCP servers run on localhost).

## What's left to do

- [ ] Add tests for the MCP config mounting logic in `container-runner.ts`
- [ ] Test end-to-end with a real MCP server (set `MERCURY_MCP_SERVERS_CONFIG`, rebuild image, send a message)
- [ ] Verify `host.docker.internal` resolves inside the container on Linux
- [ ] Consider adding `MCP_DEBUG` passthrough for troubleshooting (already works via `MERCURY_MCP_DEBUG` → `MCP_DEBUG` through existing passthrough logic)
