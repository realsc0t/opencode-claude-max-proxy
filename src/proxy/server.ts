import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { opencodeMcpServer } from "../mcpTools"
import { randomUUID } from "crypto"
import { withClaudeLogContext } from "../logger"

// Block SDK built-in tools so Claude only uses MCP tools (which have correct param names)
const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

const MCP_SERVER_NAME = "opencode"

const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`
]

function resolveClaudeExecutable(): string {
  // 1. Try the SDK's bundled cli.js (same dir as this module's SDK)
  try {
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkCliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(sdkCliJs)) return sdkCliJs
  } catch {}

  // 2. Try the system-installed claude binary
  try {
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
  } catch {}

  throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
}

const claudeExecutable = resolveClaudeExecutable()

function mapModelToClaudeModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
}

function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.0.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  const handleMessages = async (
    c: Context,
    requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }
  ) => {
    const requestStartAt = Date.now()

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      try {
        const body = await c.req.json()
        const model = mapModelToClaudeModel(body.model || "sonnet")
        const stream = body.stream ?? true

        // Debug: log request details
        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        console.error(`[PROXY] ${requestMeta.requestId} model=${model} stream=${stream} tools=${body.tools?.length ?? 0} msgs=${msgSummary}`)

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

      // Build system context from the request's system prompt
      let systemContext = ""
      if (body.system) {
        if (typeof body.system === "string") {
          systemContext = body.system
        } else if (Array.isArray(body.system)) {
          systemContext = body.system
            .filter((b: any) => b.type === "text" && b.text)
            .map((b: any) => b.text)
            .join("\n")
        }
      }

      // Extract available agent types from the Task tool definition and inject as a hint.
      // This prevents Claude from guessing wrong agent names (e.g., "Explore" instead of "explore").
      if (Array.isArray(body.tools)) {
        const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
        if (taskTool?.description) {
          const agentMatch = taskTool.description.match(/Available agent types.*?:\n((?:- \w[\w-]*:.*\n?)+)/s)
          if (agentMatch) {
            const agentNames = [...agentMatch[1].matchAll(/^- (\w[\w-]*):/gm)].map(m => m[1])
            if (agentNames.length > 0) {
              systemContext += `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${agentNames.join(", ")}. Do NOT capitalize or modify these names.`
            }
          }
        }
      }

      // Convert messages to a text prompt, preserving all content types
      const conversationParts = body.messages
        ?.map((m: { role: string; content: string | Array<{ type: string; text?: string; content?: string; tool_use_id?: string; name?: string; input?: unknown; id?: string }> }) => {
          const role = m.role === "assistant" ? "Assistant" : "Human"
          let content: string
          if (typeof m.content === "string") {
            content = m.content
          } else if (Array.isArray(m.content)) {
            content = m.content
              .map((block: any) => {
                if (block.type === "text" && block.text) return block.text
                if (block.type === "tool_use") return `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`
                if (block.type === "tool_result") return `[Tool Result for ${block.tool_use_id}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}]`
                return ""
              })
              .filter(Boolean)
              .join("\n")
          } else {
            content = String(m.content)
          }
          return `${role}: ${content}`
        })
        .join("\n\n") || ""

      // Combine system context with conversation
      const prompt = systemContext
        ? `${systemContext}\n\n${conversationParts}`
        : conversationParts

        if (!stream) {
          const contentBlocks: Array<Record<string, unknown>> = []
          let assistantMessages = 0
          const upstreamStartAt = Date.now()
          let firstChunkAt: number | undefined

          claudeLog("upstream.start", { mode: "non_stream", model })

          try {
            const response = query({
              prompt,
              options: {
                maxTurns: 100,
                model,
                pathToClaudeCodeExecutable: claudeExecutable,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
                allowedTools: [...ALLOWED_MCP_TOOLS],
                mcpServers: {
                  [MCP_SERVER_NAME]: opencodeMcpServer
                }
              }
            })

            for await (const message of response) {
              if (message.type === "assistant") {
                assistantMessages += 1
                if (!firstChunkAt) {
                  firstChunkAt = Date.now()
                  claudeLog("upstream.first_chunk", {
                    mode: "non_stream",
                    model,
                    ttfbMs: firstChunkAt - upstreamStartAt
                  })
                }

                // Preserve ALL content blocks (text, tool_use, thinking, etc.)
                for (const block of message.message.content) {
                  contentBlocks.push(block as Record<string, unknown>)
                }
              }
            }

            claudeLog("upstream.completed", {
              mode: "non_stream",
              model,
              assistantMessages,
              durationMs: Date.now() - upstreamStartAt
            })
          } catch (error) {
            claudeLog("upstream.failed", {
              mode: "non_stream",
              model,
              durationMs: Date.now() - upstreamStartAt,
              error: error instanceof Error ? error.message : String(error)
            })
            throw error
          }

          // Determine stop_reason based on content: tool_use if any tool blocks, else end_turn
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const stopReason = hasToolUse ? "tool_use" : "end_turn"

          // If no content at all, add a fallback text block
          if (contentBlocks.length === 0) {
            contentBlocks.push({
              type: "text",
              text: "I can help with that. Could you provide more details about what you'd like me to do?"
            })
            claudeLog("response.fallback_used", { mode: "non_stream", reason: "no_content_blocks" })
          }

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: Date.now() - requestStartAt,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          return c.json({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: body.model,
            stop_reason: stopReason,
            usage: { input_tokens: 0, output_tokens: 0 }
          })
        }

        const encoder = new TextEncoder()
        const readable = new ReadableStream({
          async start(controller) {
            const upstreamStartAt = Date.now()
            let firstChunkAt: number | undefined
            let heartbeatCount = 0
            let streamEventsSeen = 0
            let eventsForwarded = 0
            let textEventsForwarded = 0
            let bytesSent = 0
            let streamClosed = false

            claudeLog("upstream.start", { mode: "stream", model })

            const safeEnqueue = (payload: Uint8Array, source: string): boolean => {
              if (streamClosed) return false
              try {
                controller.enqueue(payload)
                bytesSent += payload.byteLength
                return true
              } catch (error) {
                if (isClosedControllerError(error)) {
                  streamClosed = true
                  claudeLog("stream.client_closed", { source, streamEventsSeen, eventsForwarded })
                  return false
                }

                claudeLog("stream.enqueue_failed", {
                  source,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            }

            try {
              const response = query({
                prompt,
                options: {
                  maxTurns: 100,
                  model,
                  pathToClaudeCodeExecutable: claudeExecutable,
                  includePartialMessages: true,
                  permissionMode: "bypassPermissions",
                  allowDangerouslySkipPermissions: true,
                  disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
                  allowedTools: [...ALLOWED_MCP_TOOLS],
                  mcpServers: {
                    [MCP_SERVER_NAME]: opencodeMcpServer
                  }
                }
              })

              const heartbeat = setInterval(() => {
                heartbeatCount += 1
                try {
                  const payload = encoder.encode(`: ping\n\n`)
                  if (!safeEnqueue(payload, "heartbeat")) {
                    clearInterval(heartbeat)
                    return
                  }
                  if (heartbeatCount % 5 === 0) {
                    claudeLog("stream.heartbeat", { count: heartbeatCount })
                  }
                } catch (error) {
                  claudeLog("stream.heartbeat_failed", {
                    count: heartbeatCount,
                    error: error instanceof Error ? error.message : String(error)
                  })
                  clearInterval(heartbeat)
                }
              }, 15_000)

              const skipBlockIndices = new Set<number>()

              try {
                for await (const message of response) {
                  if (streamClosed) {
                    break
                  }

                  if (message.type === "stream_event") {
                    streamEventsSeen += 1
                    if (!firstChunkAt) {
                      firstChunkAt = Date.now()
                      claudeLog("upstream.first_chunk", {
                        mode: "stream",
                        model,
                        ttfbMs: firstChunkAt - upstreamStartAt
                      })
                    }

                    const event = message.event
                    const eventType = (event as any).type
                    const eventIndex = (event as any).index as number | undefined

                    // Track MCP tool blocks (mcp__opencode__*) — these are internal tools
                    // that the SDK executes. Don't forward them to OpenCode.
                    if (eventType === "message_start") {
                      skipBlockIndices.clear()
                    }

                    if (eventType === "content_block_start") {
                      const block = (event as any).content_block
                      if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp__")) {
                        if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                        continue
                      }
                    }

                    // Skip deltas and stops for MCP tool blocks
                    if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                      continue
                    }

                    // For message_delta/message_stop: only skip if ALL content blocks in this
                    // message were MCP tools (i.e., nothing was forwarded to the client)
                    if (eventType === "message_delta" || eventType === "message_stop") {
                      // If we forwarded any content blocks, forward the message events too
                      const hasForwardedContent = eventsForwarded > 0 || skipBlockIndices.size === 0
                      if (!hasForwardedContent && (event as any).delta?.stop_reason === "tool_use") {
                        continue
                      }
                    }

                    // Forward all other events (text, non-MCP tool_use like Task, message events)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                      break
                    }
                    eventsForwarded += 1

                    if (eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "text_delta") {
                        textEventsForwarded += 1
                      }
                    }
                  }
                }
              } finally {
                clearInterval(heartbeat)
              }

              claudeLog("upstream.completed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                eventsForwarded,
                textEventsForwarded
              })

              if (!streamClosed) {
                controller.close()
                streamClosed = true

                claudeLog("stream.ended", {
                  model,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  bytesSent,
                  durationMs: Date.now() - requestStartAt
                })

                claudeLog("response.completed", {
                  mode: "stream",
                  model,
                  durationMs: Date.now() - requestStartAt,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded
                })

                if (textEventsForwarded === 0) {
                  claudeLog("response.empty_stream", {
                    model,
                    streamEventsSeen,
                    eventsForwarded,
                    reason: "no_text_deltas_forwarded"
                  })
                }
              }
            } catch (error) {
              if (isClosedControllerError(error)) {
                streamClosed = true
                claudeLog("stream.client_closed", {
                  source: "stream_catch",
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  durationMs: Date.now() - requestStartAt
                })
                return
              }

              claudeLog("upstream.failed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: error instanceof Error ? error.message : String(error)
              })
              claudeLog("proxy.anthropic.error", { error: error instanceof Error ? error.message : String(error) })
              safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" }
              })}\n\n`), "error_event")
              if (!streamClosed) {
                controller.close()
                streamClosed = true
              }
            }
          }
        })

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        })
      } catch (error) {
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: error instanceof Error ? error.message : String(error)
        })
        claudeLog("proxy.error", { error: error instanceof Error ? error.message : String(error) })
        return c.json({
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : "Unknown error"
          }
        }, 500)
      }
    })
  }

  app.post("/v1/messages", (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID()
    const startedAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint: "/v1/messages" })
    return handleMessages(c, { requestId, endpoint: "/v1/messages", queueEnteredAt: startedAt, queueStartedAt: startedAt })
  })

  app.post("/messages", (c) => {
    const requestId = c.req.header("x-request-id") || randomUUID()
    const startedAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint: "/messages" })
    return handleMessages(c, { requestId, endpoint: "/messages", queueEnteredAt: startedAt, queueStartedAt: startedAt })
  })

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  let server
  try {
    server = Bun.serve({
      port: finalConfig.port,
      hostname: finalConfig.host,
      idleTimeout: finalConfig.idleTimeoutSeconds,
      fetch: app.fetch
    })
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      console.error(`\nError: Port ${finalConfig.port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${finalConfig.port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${finalConfig.port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  CLAUDE_PROXY_PORT=4567 bun run proxy`)
      process.exit(1)
    }
    throw error
  }

  console.log(`Claude Max Proxy (Anthropic API) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`\nTo use with OpenCode, run:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
