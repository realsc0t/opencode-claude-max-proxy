# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

A transparent proxy that lets you use your **Claude Max subscription** with [OpenCode](https://opencode.ai) — with full multi-model agent delegation.

## The Idea

OpenCode speaks the Anthropic API. Claude Max gives you unlimited Claude through the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). This proxy bridges the two — but the interesting part isn't the bridging, it's **how tool execution and agent delegation work**.

Most proxy approaches try to handle everything internally: the SDK runs tools, manages subagents, and streams back a finished result. The problem? The SDK only knows about Claude models. If you're using [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) with agents routed to GPT-5.4, Gemini, or other providers, the SDK can't reach them. Your carefully configured multi-model agent setup gets flattened to "everything runs on Claude."

This proxy takes a different approach: **passthrough delegation**. Instead of handling tools internally, the proxy intercepts every tool call *before the SDK executes it*, stops the turn, and forwards the raw `tool_use` back to OpenCode. OpenCode handles execution — including routing `Task` calls through its own agent system with full model routing. The result comes back as a standard `tool_result`, the proxy resumes the SDK session, and Claude continues.

The effect: Claude thinks it's calling tools normally. OpenCode thinks it's talking to the Anthropic API. But behind the scenes, your oracle agent runs on GPT-5.4, your explore agent runs on Gemini, and the main session runs on Claude Max — exactly as configured.

```
┌──────────┐                ┌───────────────┐              ┌──────────────┐
│          │  1. Request    │               │   SDK Auth   │              │
│ OpenCode │ ─────────────► │    Proxy      │ ───────────► │  Claude Max  │
│          │                │  (localhost)  │              │              │
│          │  4. tool_use   │               │  2. Generate │              │
│          │ ◄───────────── │  PreToolUse   │ ◄─────────── │  Response    │
│          │                │  hook blocks  │              │              │
│          │  5. Execute    │               │              └──────────────┘
│          │  ─── Task ───► │               │
│          │  (routes to    │               │              ┌──────────────┐
│          │   GPT-5.4,     │  6. Resume    │              │  oh-my-      │
│          │   Gemini,etc)  │ ◄──────────── │              │  opencode    │
│          │                │  tool_result  │              │  agents      │
│          │  7. Final      │               │              │              │
│          │ ◄───────────── │               │              │  oracle:     │
│          │  response      │               │              │   GPT-5.4    │
└──────────┘                └───────────────┘              │  explore:    │
                                                          │   Gemini     │
                                                          │  librarian:  │
                                                          │   Sonnet     │
                                                          └──────────────┘
```

## How Passthrough Works

The key insight is the Claude Agent SDK's `PreToolUse` hook — an officially supported callback that fires before any tool executes. Combined with `maxTurns: 1`, it gives us precise control over the execution boundary:

1. **Claude generates a response** with `tool_use` blocks (Read a file, delegate to an agent, run a command)
2. **The PreToolUse hook fires** for each tool call — we capture the tool name, input, and ID, then return `decision: "block"` to prevent SDK-internal execution
3. **The SDK stops** (blocked tool + maxTurns:1 = turn complete) and we have the full tool_use payload
4. **The proxy returns it to OpenCode** as a standard Anthropic API response with `stop_reason: "tool_use"`
5. **OpenCode handles everything** — file reads, shell commands, and crucially, `Task` delegation through its own agent system with full model routing
6. **OpenCode sends `tool_result` back**, the proxy resumes the SDK session, and Claude continues

No monkey-patching. No forked SDKs. No fragile stream rewriting. Just a hook and a turn limit.

## Quick Start

### Prerequisites

1. **Claude Max subscription** — [Subscribe here](https://claude.ai/settings/subscription)
2. **Claude CLI** authenticated: `npm install -g @anthropic-ai/claude-code && claude login`

### Option A: npm Install

```bash
npm install -g opencode-claude-max-proxy

# Start in passthrough mode (recommended)
CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy
```

### Option B: From Source

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install

# Start in passthrough mode (recommended)
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy
```

> **Note:** Running from source requires [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`

### Option C: Docker

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy

# Start the container
docker compose up -d

# Login to Claude inside the container (one-time)
docker compose exec proxy claude login

# Verify
curl http://127.0.0.1:3456/health
```

> **Note:** On macOS, `claude login` must be run inside the container (keychain credentials can't be mounted). On Linux, volume-mounting `~/.claude` may work without re-login.

### Connect OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

The `ANTHROPIC_API_KEY` can be any non-empty string — the proxy doesn't use it. Authentication is handled by your `claude login` session.

### Shell Alias

```bash
# Add to ~/.zshrc or ~/.bashrc
alias oc='ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode'
```

## Modes

### Passthrough Mode (recommended)

```bash
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy
```

All tool execution is forwarded to OpenCode. This enables:

- **Multi-model agent delegation** — oh-my-opencode routes each agent to its configured model
- **Full agent system prompts** — not abbreviated descriptions, the real prompts
- **OpenCode manages everything** — tools, agents, permissions, lifecycle

### Internal Mode (default)

```bash
bun run proxy
```

Tools execute inside the proxy via MCP. Subagents run on Claude via the SDK's native agent system. Simpler setup, but all agents use Claude regardless of oh-my-opencode config.

| | Passthrough | Internal |
|---|---|---|
| Tool execution | OpenCode | Proxy (MCP) |
| Agent delegation | OpenCode → multi-model | SDK → Claude only |
| oh-my-opencode models | ✅ Respected | ❌ All Claude |
| Agent system prompts | ✅ Full | ⚠️ Description only |
| Setup complexity | Same | Same |

## Works With Any Agent Framework

The proxy extracts agent definitions from the `Task` tool description that OpenCode sends in each request. This means it works automatically with:

- **Native OpenCode** — `build` and `plan` agents
- **oh-my-opencode** — `oracle`, `explore`, `librarian`, `sisyphus-junior`, `metis`, `momus`, etc.
- **Custom agents** — anything you define in `opencode.json`

In internal mode, a `PreToolUse` hook fuzzy-matches agent names as a safety net (e.g., `general-purpose` → `general`, `Explore` → `explore`, `code-reviewer` → `oracle`). In passthrough mode, OpenCode handles agent names directly.

## Session Resume

The proxy tracks SDK session IDs and resumes conversations on follow-up requests:

- **Faster responses** — no re-processing of conversation history
- **Better context** — the SDK remembers tool results from previous turns

Session tracking works two ways:

1. **Header-based** (recommended) — Add the included OpenCode plugin:
   ```json
   { "plugin": ["./path/to/opencode-claude-max-proxy/src/plugin/claude-max-headers.ts"] }
   ```

2. **Fingerprint-based** (automatic fallback) — hashes the first user message to identify returning conversations

Sessions are cached for 24 hours.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PASSTHROUGH` | (unset) | Enable passthrough mode — forward all tools to OpenCode |
| `CLAUDE_PROXY_PORT` | 3456 | Proxy server port |
| `CLAUDE_PROXY_HOST` | 127.0.0.1 | Proxy server host |
| `CLAUDE_PROXY_WORKDIR` | (cwd) | Working directory for Claude and tools |
| `CLAUDE_PROXY_MAX_CONCURRENT` | 1 | Max concurrent SDK sessions (increase with caution) |
| `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | 120 | Connection idle timeout |

## Concurrency

The proxy supports multiple simultaneous OpenCode instances. Each request spawns its own independent SDK subprocess — run as many terminals as you want. All concurrent responses are delivered correctly.

**Use the auto-restart supervisor** (recommended):

```bash
CLAUDE_PROXY_PASSTHROUGH=1 bun run proxy
# or directly:
CLAUDE_PROXY_PASSTHROUGH=1 ./bin/claude-proxy-supervisor.sh
```

> **⚠️ Known Issue: Bun SSE Crash ([oven-sh/bun#17947](https://github.com/oven-sh/bun/issues/17947))**
>
> The Claude Agent SDK's `cli.js` subprocess is compiled with Bun, which has a known segfault in `structuredCloneForStream` during cleanup of concurrent streaming responses. This affects all runtimes (Bun, Node.js via tsx) because the crash originates in the SDK's child process, not in the proxy itself.
>
> **What this means in practice:**
> - **Sequential requests (1 terminal):** No impact. Never crashes.
> - **Concurrent requests (2+ terminals):** All responses are delivered correctly. The crash occurs *after* responses complete, during stream cleanup. No work is lost.
> - **After a crash:** The supervisor restarts the proxy in ~1-3 seconds. If a new request arrives during this window, OpenCode shows "Unable to connect" — just retry.
>
> We are monitoring the upstream Bun issue for a fix. Once patched, the supervisor becomes optional.

## Model Mapping

| OpenCode Model | Claude SDK |
|----------------|------------|
| `anthropic/claude-opus-*` | opus |
| `anthropic/claude-sonnet-*` | sonnet (default) |
| `anthropic/claude-haiku-*` | haiku |

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It is not affiliated with, endorsed by, or supported by Anthropic.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with [Anthropic's Terms of Service](https://www.anthropic.com/terms) and any applicable usage policies. Terms may change at any time.

This project calls `query()` from Anthropic's public npm package using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## FAQ

<details>
<summary><strong>Why passthrough mode instead of handling tools internally?</strong></summary>

Internal tool execution means the SDK handles everything — but the SDK only speaks Claude. If your agents are configured for GPT-5.4 or Gemini via oh-my-opencode, that routing gets lost. Passthrough mode preserves the full OpenCode agent pipeline, including multi-model routing, full system prompts, and agent lifecycle management.
</details>

<details>
<summary><strong>Does this work without oh-my-opencode?</strong></summary>

Yes. Both modes work with native OpenCode (build + plan agents) and with any custom agents defined in your `opencode.json`. oh-my-opencode just adds more agents and model routing — the proxy handles whatever OpenCode sends.
</details>

<details>
<summary><strong>Why do I need ANTHROPIC_API_KEY=dummy?</strong></summary>

OpenCode requires an API key to be set, but the proxy never uses it. Authentication is handled by your `claude login` session through the Agent SDK.
</details>

<details>
<summary><strong>What about rate limits?</strong></summary>

Your Claude Max subscription has its own usage limits. The proxy doesn't add any additional limits. Concurrent requests are supported.
</details>

<details>
<summary><strong>Is my data sent anywhere else?</strong></summary>

No. The proxy runs locally. Requests go directly to Claude through the official SDK. In passthrough mode, tool execution happens in OpenCode on your machine.
</details>

<details>
<summary><strong>Why does internal mode use MCP tools?</strong></summary>

The Claude Agent SDK uses different parameter names for tools than OpenCode (e.g., `file_path` vs `filePath`). Internal mode provides its own MCP tools with SDK-compatible parameter names. Passthrough mode doesn't need this since OpenCode handles tool execution directly.
</details>

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Authentication failed" | Run `claude login` to authenticate |
| "Connection refused" | Make sure the proxy is running: `bun run proxy` |
| "Port 3456 is already in use" | `kill $(lsof -ti :3456)` or use `CLAUDE_PROXY_PORT=4567` |
| Title generation fails | Set `"small_model": "anthropic/claude-haiku-4-5"` in your OpenCode config |

## Auto-start (macOS)

```bash
cat > ~/Library/LaunchAgents/com.claude-max-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(pwd)/bin/claude-proxy-supervisor.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROXY_PASSTHROUGH</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

## Testing

```bash
bun test
```

106 tests across 13 files covering:
- Passthrough tool forwarding and tool_result acceptance
- PreToolUse hook interception and agent name fuzzy matching
- SDK agent definition extraction (native OpenCode + oh-my-opencode)
- MCP tool filtering (internal mode)
- Session resume (header-based and fingerprint-based)
- Streaming message deduplication
- Working directory propagation
- Concurrent request handling
- Error classification (auth, rate limit, billing, timeout)

### Health Endpoint

```bash
curl http://127.0.0.1:3456/health
```

Returns auth status, subscription type, and proxy mode. Use this to verify the proxy is running and authenticated before connecting OpenCode.

## Architecture

```
src/
├── proxy/
│   ├── server.ts      # HTTP server, passthrough/internal modes, SSE streaming, session resume
│   ├── agentDefs.ts   # Extract SDK agent definitions from OpenCode's Task tool
│   ├── agentMatch.ts  # Fuzzy matching for agent names (6-level priority)
│   └── types.ts       # ProxyConfig types and defaults
├── mcpTools.ts        # MCP tool definitions for internal mode (read, write, edit, bash, glob, grep)
├── logger.ts          # Structured logging with AsyncLocalStorage context
├── plugin/
│   └── claude-max-headers.ts  # OpenCode plugin for session header injection
└── __tests__/         # 106 tests across 13 files
    ├── helpers.ts
    ├── integration.test.ts
    ├── proxy-agent-definitions.test.ts
    ├── proxy-agent-fuzzy-match.test.ts
    ├── proxy-error-handling.test.ts
    ├── proxy-mcp-filtering.test.ts
    ├── proxy-passthrough-concept.test.ts
    ├── proxy-pretooluse-hook.test.ts
    ├── proxy-session-resume.test.ts
    ├── proxy-streaming-message.test.ts
    ├── proxy-subagent-support.test.ts
    ├── proxy-tool-forwarding.test.ts
    ├── proxy-transparent-tools.test.ts
    └── proxy-working-directory.test.ts
```

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
