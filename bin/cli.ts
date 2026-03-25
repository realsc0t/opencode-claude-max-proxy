#!/usr/bin/env node

import { createRequire } from "module"
import { startProxyServer } from "../src/proxy/server"
import { env } from "../src/env"
import { exec as execCallback } from "child_process"
import { promisify } from "util"

const require = createRequire(import.meta.url)
const { version } = require("../package.json")

const args = process.argv.slice(2)

if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`meridian v${version}

Local Anthropic API powered by your Claude Max subscription.

Usage: meridian [command] [options]

Commands:
  (default)        Start the proxy server
  refresh-token    Refresh the Claude Code OAuth token

Options:
  -v, --version   Show version
  -h, --help      Show this help

Environment variables:
  MERIDIAN_PORT                     Port to listen on (default: 3456)
  MERIDIAN_HOST                     Host to bind to (default: 127.0.0.1)
  MERIDIAN_PASSTHROUGH              Enable passthrough mode (tools forwarded to client)
  MERIDIAN_IDLE_TIMEOUT_SECONDS     Idle timeout in seconds (default: 120)

See https://github.com/rynfar/meridian for full documentation.`)
  process.exit(0)
}

if (args[0] === "refresh-token") {
  const { refreshOAuthToken } = await import("../src/proxy/tokenRefresh")
  const success = await refreshOAuthToken()
  if (success) {
    console.log("Token refreshed successfully")
    process.exit(0)
  } else {
    console.error("Token refresh failed. If the problem persists, run: claude login")
    process.exit(1)
  }
}

const exec = promisify(execCallback)

// Prevent SDK subprocess crashes from killing the proxy
process.on("uncaughtException", (err) => {
  console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
})
process.on("unhandledRejection", (reason) => {
  console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
})

// Port/host resolution priority:
// 1. MERIDIAN_PORT / MERIDIAN_HOST (explicit, highest priority)
// 2. ANTHROPIC_BASE_URL (parsed from URL — useful when set globally)
// 3. Defaults (127.0.0.1:3456)
let host = "127.0.0.1"
let port = 3456
const baseUrl = process.env.ANTHROPIC_BASE_URL
if (baseUrl) {
  try {
    const url = new URL(baseUrl)
    host = url.hostname
    if (url.port) port = parseInt(url.port, 10)
  } catch {
    console.error(`\x1b[33m\u26a0 Invalid ANTHROPIC_BASE_URL: ${baseUrl}, using defaults\x1b[0m`)
  }
}
// Explicit env vars override ANTHROPIC_BASE_URL
const envPort = env("PORT")
const envHost = env("HOST")
if (envPort) port = parseInt(envPort, 10)
if (envHost) host = envHost
const idleTimeoutSeconds = parseInt(env("IDLE_TIMEOUT_SECONDS") || "120", 10)

export async function runCli(
  start = startProxyServer,
  runExec: typeof exec = exec
) {
  // Pre-flight auth check
  try {
    const { stdout } = await runExec("claude auth status", { timeout: 5000 })
    const auth = JSON.parse(stdout)
    if (!auth.loggedIn) {
      console.error("\x1b[31m✗ Not logged in to Claude.\x1b[0m Run: claude login")
      process.exit(1)
    }
    if (auth.subscriptionType !== "max") {
      console.error(`\x1b[33m⚠ Claude subscription: ${auth.subscriptionType || "unknown"} (Max recommended)\x1b[0m`)
    }
  } catch {
    console.error("\x1b[33m⚠ Could not verify Claude auth status. If requests fail, run: claude login\x1b[0m")
  }

  const proxy = await start({ port, host, idleTimeoutSeconds })

  // Handle EADDRINUSE — preserve CLI behavior of exiting on port conflict
  proxy.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(1)
    }
  })
}

if (import.meta.main) {
  await runCli()
}
