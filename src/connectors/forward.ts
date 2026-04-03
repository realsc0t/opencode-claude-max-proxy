/**
 * API forwarder — forwards requests to OpenAI and Anthropic API endpoints.
 *
 * Handles format translation when the input format doesn't match the
 * connector type (e.g., Anthropic format input → OpenAI connector).
 *
 * Supports both streaming and non-streaming responses.
 */

import type { ConnectorConfig } from "./types"

/** Detect whether a request body is OpenAI or Anthropic format */
export function detectFormat(body: any): "openai" | "anthropic" {
  // OpenAI uses "messages" with role/content AND has no "max_tokens" at top level
  // or uses "model" with chat completion style
  if (body.stream !== undefined && body.messages && body.model) {
    // Both formats have these. Distinguish by field names:
    // Anthropic: max_tokens (required), system (optional string/array)
    // OpenAI: max_tokens (optional), uses different stop_reason etc.
    if (body.stop_reason || (body.system && !body.tools?.some?.((t: any) => t.function))) {
      return "anthropic"
    }
    // If has "functions" or tools with "function" property, it's OpenAI
    if (body.functions || body.tools?.some?.((t: any) => t.function)) {
      return "openai"
    }
  }
  // Default: check endpoint-specific hints
  // Anthropic has required max_tokens; OpenAI does not
  if (body.max_tokens && body.system !== undefined) return "anthropic"
  return "openai"
}

/**
 * Convert Anthropic messages format to OpenAI chat completions format.
 */
export function anthropicToOpenAI(body: any): any {
  const messages: any[] = []

  // Convert system prompt to system message
  if (body.system) {
    const systemText = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
        : ""
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  // Convert messages
  for (const msg of body.messages || []) {
    if (msg.role === "user" || msg.role === "assistant") {
      let content: any
      if (typeof msg.content === "string") {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        // Convert Anthropic content blocks to OpenAI format
        const parts: any[] = []
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text })
          } else if (block.type === "image") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${block.source?.media_type || "image/png"};base64,${block.source?.data}` }
            })
          } else if (block.type === "tool_use") {
            // Tool calls go separately in OpenAI format
            continue
          } else if (block.type === "tool_result") {
            // Will be handled as a separate tool message
            continue
          }
        }
        content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts
      }
      messages.push({ role: msg.role, content })
    }
  }

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream ?? false,
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
  }
}

/**
 * Convert OpenAI chat completions format to Anthropic messages format.
 */
export function openAIToAnthropic(body: any): any {
  const messages: any[] = []
  let system: string | undefined

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    } else if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream ?? false,
    ...(system ? { system } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
  }
}

/**
 * Forward a request to an OpenAI-compatible API.
 */
export async function forwardToOpenAI(
  connector: ConnectorConfig,
  body: any,
  inputFormat: "openai" | "anthropic"
): Promise<Response> {
  const url = `${connector.baseUrl!.replace(/\/+$/, "")}/v1/chat/completions`

  // Translate if input is Anthropic format
  const requestBody = inputFormat === "anthropic" ? anthropicToOpenAI(body) : body

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${connector.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300_000),
  })

  if (inputFormat === "anthropic" && !body.stream) {
    // Translate OpenAI response back to Anthropic format
    const data = await response.json() as any
    const anthropicResponse = openAIResponseToAnthropic(data)
    return new Response(JSON.stringify(anthropicResponse), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  // For OpenAI input or streaming, return the response as-is
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      ...(body.stream ? { "Cache-Control": "no-cache", "Connection": "keep-alive" } : {}),
    },
  })
}

/**
 * Forward a request to an Anthropic API.
 */
export async function forwardToAnthropic(
  connector: ConnectorConfig,
  body: any,
  inputFormat: "openai" | "anthropic"
): Promise<Response> {
  const url = `${connector.baseUrl!.replace(/\/+$/, "")}/v1/messages`

  // Translate if input is OpenAI format
  const requestBody = inputFormat === "openai" ? openAIToAnthropic(body) : body

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": connector.apiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300_000),
  })

  if (inputFormat === "openai" && !body.stream) {
    // Translate Anthropic response back to OpenAI format
    const data = await response.json() as any
    const openAIResponse = anthropicResponseToOpenAI(data)
    return new Response(JSON.stringify(openAIResponse), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  // For Anthropic input or streaming, return the response as-is
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      ...(body.stream ? { "Cache-Control": "no-cache", "Connection": "keep-alive" } : {}),
    },
  })
}

/**
 * Convert an OpenAI chat completion response to Anthropic format.
 */
function openAIResponseToAnthropic(data: any): any {
  const choice = data.choices?.[0]
  const content: any[] = []

  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: data.model,
    stop_reason: choice?.finish_reason === "stop" ? "end_turn" : choice?.finish_reason || "end_turn",
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  }
}

/**
 * Convert an Anthropic response to OpenAI chat completion format.
 */
function anthropicResponseToOpenAI(data: any): any {
  const text = data.content
    ?.filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("") || ""

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason || "stop",
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  }
}
