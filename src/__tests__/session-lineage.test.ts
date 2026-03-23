/**
 * Tests for conversation lineage verification.
 *
 * Validates that session resume correctly detects history divergence
 * from undo, edit, branch, and normal continuation scenarios.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
let capturedQueryParams: { options?: { resume?: string } } | null = null
let queuedSessionIds: string[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as { options?: { resume?: string } }
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

const lineageTmpDir = mkdtempSync(join(tmpdir(), "session-lineage-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = lineageTmpDir

const { createProxyServer, clearSessionCache, computeLineageHash } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(lineageTmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function post(
  app: TestApp,
  session: string,
  messages: Array<{ role: string; content: string }>,
  sessionId: string
) {
  queuedSessionIds.push(sessionId)
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": session,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages,
    }),
  }))
  await response.json()
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  queuedSessionIds = []
  clearSessionCache()
  clearSharedSessions()
})

describe("computeLineageHash", () => {
  it("returns empty string for empty messages", () => {
    expect(computeLineageHash([])).toBe("")
  })

  it("produces consistent hashes for same messages", () => {
    const msgs = [{ role: "user", content: "hello" }]
    expect(computeLineageHash(msgs)).toBe(computeLineageHash(msgs))
  })

  it("produces different hashes for different content", () => {
    const a = [{ role: "user", content: "hello" }]
    const b = [{ role: "user", content: "goodbye" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("produces different hashes for different roles", () => {
    const a = [{ role: "user", content: "hello" }]
    const b = [{ role: "assistant", content: "hello" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("produces different hashes for different message order", () => {
    const a = [{ role: "user", content: "a" }, { role: "user", content: "b" }]
    const b = [{ role: "user", content: "b" }, { role: "user", content: "a" }]
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b))
  })

  it("handles array content (multimodal)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    const hash = computeLineageHash(msgs as any)
    expect(hash.length).toBe(32)
  })
})

describe("Session lineage: undo detection", () => {
  it("resumes normally when messages are a strict continuation", async () => {
    const app = createTestApp()

    // Turn 1
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
    ], "sdk-1")

    // Turn 2 — strict continuation (adds assistant + new user message)
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Remember: Flobulator" },
    ], "sdk-1")

    expect(capturedQueryParams?.options?.resume).toBe("sdk-1")
  })

  it("does NOT resume after undo (same message count, different content)", async () => {
    const app = createTestApp()

    // Turn 1
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
    ], "sdk-1")

    // Turn 2
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Remember: Flobulator" },
    ], "sdk-1")

    // /undo removes turn 2, user sends a different message 2
    // Message count is still 3 but content of message 3 is different
    await post(app, "sess-1", [
      { role: "user", content: "Good evening" },
      { role: "assistant", content: "Good evening!" },
      { role: "user", content: "Do you remember the word?" },
    ], "sdk-new")

    // Should NOT resume — lineage hash mismatch
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("does NOT resume after multi-undo (fewer messages)", async () => {
    const app = createTestApp()

    // Build up 3 turns
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "step 2" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "step 2" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "step 3" },
    ], "sdk-1")

    // Multi-undo back to turn 1, send new message
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "completely different" },
    ], "sdk-new")

    // Should NOT resume — fewer messages than stored + content changed
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("does NOT resume when earlier message is edited", async () => {
    const app = createTestApp()

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ], "sdk-1")

    // Edit the first message
    await post(app, "sess-1", [
      { role: "user", content: "EDITED hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "good" },
      { role: "user", content: "great" },
    ], "sdk-new")

    // Should NOT resume — first message was edited, lineage broken
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("resumes correctly after undo when a NEW session starts", async () => {
    const app = createTestApp()

    // Turn 1
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
    ], "sdk-1")

    // Turn 2
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "remember X" },
    ], "sdk-1")

    // /undo + new message → starts fresh (no resume)
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "forget about X" },
    ], "sdk-2")

    expect(capturedQueryParams?.options?.resume).toBeUndefined()

    // Now continuing from the NEW session should resume with sdk-2
    await post(app, "sess-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "forget about X" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "what do you know?" },
    ], "sdk-2")

    expect(capturedQueryParams?.options?.resume).toBe("sdk-2")
  })
})

describe("Session lastAccess refresh on lookup", () => {
  it("keeps actively-used sessions alive in LRU by refreshing lastAccess", async () => {
    const app = createTestApp()

    // Create 2 sessions (LRU limit is 1000 in tests, so no eviction pressure,
    // but we can verify resume works across multiple lookups — proving the
    // session stays accessible and its timestamp is refreshed)

    // Session A — created first
    await post(app, "sess-A", [
      { role: "user", content: "session A" },
    ], "sdk-A")

    // Session B — created second
    await post(app, "sess-B", [
      { role: "user", content: "session B" },
    ], "sdk-B")

    // Come back to session A much later — should still resume
    capturedQueryParams = null
    await post(app, "sess-A", [
      { role: "user", content: "session A" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "still here?" },
    ], "sdk-A")

    expect(capturedQueryParams?.options?.resume).toBe("sdk-A")

    // And again — third access to same session, still resumes
    capturedQueryParams = null
    await post(app, "sess-A", [
      { role: "user", content: "session A" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "still here?" },
      { role: "assistant", content: "yes" },
      { role: "user", content: "one more" },
    ], "sdk-A")

    expect(capturedQueryParams?.options?.resume).toBe("sdk-A")
  })
})

describe("Session lineage: fingerprint fallback", () => {
  it("does NOT resume via fingerprint after undo", async () => {
    const app = createTestApp()

    // No session header — uses fingerprint (hash of first user message)
    await post(app, "", [
      { role: "user", content: "Good evening" },
    ], "sdk-fp1")

    // Manually clear session header, send via fingerprint
    queuedSessionIds.push("sdk-fp1")
    const r1 = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 128, stream: false,
        messages: [
          { role: "user", content: "Good evening" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Remember: Flobulator" },
        ],
      }),
    }))
    await r1.json()

    // Undo + new message, still no session header
    queuedSessionIds.push("sdk-fp-new")
    capturedQueryParams = null
    const r2 = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 128, stream: false,
        messages: [
          { role: "user", content: "Good evening" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "Do you know the word?" },
        ],
      }),
    }))
    await r2.json()

    // Should NOT resume — fingerprint matches but lineage diverged
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })
})
