/**
 * Tests for fingerprint-based session resume with system context.
 *
 * Validates that:
 * 1. Fingerprint resume works when systemContext matches (store and lookup agree)
 * 2. Different systemContext produces different fingerprints (cross-project isolation)
 * 3. Fingerprint resume works end-to-end through the proxy (streaming + non-streaming)
 *
 * These tests prevent regressions like #94 where storeSession and lookupSession
 * computed fingerprints with different inputs, breaking resume entirely.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
let capturedQueryParams: { prompt?: any; options?: { resume?: string } } | null = null
let queuedSessionIds: string[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as any
    const sessionId = queuedSessionIds.shift() || "sdk-session-default"
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

mock.module("../mcpTools", () => ({
  opencodeMcpServer: { type: "sdk", name: "opencode", instance: {} },
}))

const fpTmpDir = mkdtempSync(join(tmpdir(), "session-fp-context-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = fpTmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(fpTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

/** Send a request WITHOUT a session header (fingerprint fallback path) */
async function postNoSession(
  app: TestApp,
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
  system?: string,
  stream = false
) {
  queuedSessionIds.push(sessionId)
  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream,
    messages,
  }
  if (system) body.system = system

  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))

  if (stream) {
    // Consume the stream fully
    const reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    }
  } else {
    await response.json()
  }
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  queuedSessionIds = []
  clearSessionCache()
  clearSharedSessions()
})

describe("Fingerprint resume with system context", () => {
  it("resumes via fingerprint when system context matches (non-stream)", async () => {
    const app = createTestApp()
    const system = "You are a helpful assistant. Project: /home/user/my-project"

    // Turn 1 — no session header, fingerprint created with systemContext
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-1", system)

    // Turn 2 — same first message + same system → fingerprint matches → should resume
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ], "sdk-1", system)

    expect(capturedQueryParams?.options?.resume).toBe("sdk-1")
  })

  it("resumes via fingerprint when system context matches (stream)", async () => {
    const app = createTestApp()
    const system = "You are a coding assistant."

    // Turn 1 — streaming, no session header
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-stream-1", system, true)

    // Turn 2 — same system context → should resume
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "what can you do?" },
    ], "sdk-stream-1", system, true)

    expect(capturedQueryParams?.options?.resume).toBe("sdk-stream-1")
  })

  it("does NOT resume when system context differs (cross-project isolation)", async () => {
    const app = createTestApp()

    // Project A
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-project-a", "Project: /home/user/project-a")

    // Project B — same first message but different system context
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "list files" },
    ], "sdk-project-b", "Project: /home/user/project-b")

    // Should NOT resume project A's session
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("does NOT resume when system context is added where there was none", async () => {
    const app = createTestApp()

    // First request with no system context
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-no-system")

    // Second request adds system context — fingerprint should differ
    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "help me" },
    ], "sdk-with-system", "You are a helpful assistant.")

    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("resumes correctly without system context (backward compat)", async () => {
    const app = createTestApp()

    // No system context at all — old behavior should still work
    await postNoSession(app, [
      { role: "user", content: "hello" },
    ], "sdk-no-ctx")

    capturedQueryParams = null
    await postNoSession(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ], "sdk-no-ctx")

    expect(capturedQueryParams?.options?.resume).toBe("sdk-no-ctx")
  })
})
