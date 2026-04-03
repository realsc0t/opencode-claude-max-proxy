/**
 * Runtime proxy settings — persisted to disk, modifiable via admin API.
 */

import { env } from "../env"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"

export interface ProxySettings {
  maxConcurrent: number
  passthrough: boolean
  /** Global token limit per 6-hour window (from Claude Max subscription) */
  globalLimit6h: number
  /** Global token limit per weekly window (from Claude Max subscription) */
  globalLimitWeekly: number
  /** Idle timeout in minutes — abort SDK subprocess if no events for this long (0 = disabled) */
  idleTimeoutMinutes: number
  /** Override sonnet model variant: "sonnet" (200k) or "sonnet[1m]" (1M context). Empty = auto-detect from subscription. */
  sonnetModel: string
  /** Track file changes in responses (write/edit operations) */
  trackFileChanges: boolean
  /** Enable debug logging */
  debug: boolean
}

const DEFAULTS: ProxySettings = {
  maxConcurrent: parseInt(env("MAX_CONCURRENT") || "10", 10),
  passthrough: env("PASSTHROUGH") === "1",
  globalLimit6h: 0,
  globalLimitWeekly: 0,
  idleTimeoutMinutes: 10,
  sonnetModel: env("SONNET_MODEL") || "",
  trackFileChanges: env("NO_FILE_CHANGES") !== "1",
  debug: env("DEBUG") === "1",
}

function defaultSettingsPath(): string {
  return resolve(homedir(), ".meridian", "settings.json")
}

let settings: ProxySettings = { ...DEFAULTS }
const filePath = env("SETTINGS_FILE") ?? defaultSettingsPath()

// Load on import
try {
  if (existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, "utf-8"))
    settings = { ...DEFAULTS, ...data }
  }
} catch {
  // Start with defaults
}

function flush(): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(settings, null, 2))
}

export function getProxySettings(): ProxySettings {
  return { ...settings }
}

export function updateProxySettings(updates: Partial<ProxySettings>): ProxySettings {
  if (updates.maxConcurrent != null) {
    const val = Math.max(1, Math.min(100, Math.floor(updates.maxConcurrent)))
    settings.maxConcurrent = val
  }
  if (updates.passthrough != null) {
    settings.passthrough = Boolean(updates.passthrough)
  }
  if (updates.globalLimit6h != null) {
    settings.globalLimit6h = Math.max(0, Math.floor(updates.globalLimit6h))
  }
  if (updates.globalLimitWeekly != null) {
    settings.globalLimitWeekly = Math.max(0, Math.floor(updates.globalLimitWeekly))
  }
  if (updates.idleTimeoutMinutes != null) {
    settings.idleTimeoutMinutes = Math.max(0, Math.min(60, Math.floor(updates.idleTimeoutMinutes)))
  }
  if (updates.sonnetModel != null) {
    const allowed = ["", "sonnet", "sonnet[1m]"]
    settings.sonnetModel = allowed.includes(updates.sonnetModel) ? updates.sonnetModel : ""
  }
  if (updates.trackFileChanges != null) {
    settings.trackFileChanges = Boolean(updates.trackFileChanges)
  }
  if (updates.debug != null) {
    settings.debug = Boolean(updates.debug)
  }
  flush()
  return { ...settings }
}
