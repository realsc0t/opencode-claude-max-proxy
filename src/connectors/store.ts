/**
 * Connector store — persistence and CRUD for connector configurations.
 *
 * Stores connector configs in ~/.meridian/connectors.json.
 * API keys are stored in plaintext (same security model as settings.json).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { env } from "../env"
import type { ConnectorConfig, ConnectorType, ModelEntry } from "./types"
import { CLAUDE_SDK_MODELS } from "./types"

function defaultStorePath(): string {
  return resolve(homedir(), ".meridian", "connectors.json")
}

const filePath = env("CONNECTORS_FILE") ?? defaultStorePath()

let connectors: ConnectorConfig[] = []

// Load on import
try {
  if (existsSync(filePath)) {
    connectors = JSON.parse(readFileSync(filePath, "utf-8"))
  }
} catch {
  connectors = []
}

// Ensure Claude SDK connector always exists
function ensureClaudeSdk(): void {
  const existing = connectors.find(c => c.type === "claude-sdk")
  if (!existing) {
    connectors.unshift({
      id: "claude-sdk-default",
      type: "claude-sdk",
      name: "Claude Max (SDK)",
      enabled: true,
      models: [...CLAUDE_SDK_MODELS],
      maxConcurrent: 10,
      createdAt: Date.now(),
    })
    flush()
  }
}

function flush(): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(connectors, null, 2))
}

ensureClaudeSdk()

export function getAllConnectors(): ConnectorConfig[] {
  return connectors.map(c => ({
    ...c,
    // Mask API key in responses
    apiKey: c.apiKey ? `${c.apiKey.slice(0, 8)}...${c.apiKey.slice(-4)}` : undefined,
  }))
}

export function getConnector(id: string): ConnectorConfig | undefined {
  return connectors.find(c => c.id === id)
}

/** Get connector with FULL api key (internal use only) */
export function getConnectorInternal(id: string): ConnectorConfig | undefined {
  return connectors.find(c => c.id === id)
}

export function createConnector(
  type: ConnectorType,
  name: string,
  opts: { baseUrl?: string; apiKey?: string; maxConcurrent?: number }
): ConnectorConfig {
  if (type === "claude-sdk") {
    throw new Error("Only one Claude SDK connector is allowed")
  }

  const connector: ConnectorConfig = {
    id: randomUUID().slice(0, 8),
    type,
    name,
    enabled: true,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    models: [],
    maxConcurrent: opts.maxConcurrent ?? 5,
    createdAt: Date.now(),
  }

  connectors.push(connector)
  flush()
  return connector
}

export function updateConnector(
  id: string,
  updates: Partial<Pick<ConnectorConfig, "name" | "enabled" | "baseUrl" | "apiKey" | "maxConcurrent">>
): ConnectorConfig | undefined {
  const connector = connectors.find(c => c.id === id)
  if (!connector) return undefined

  if (updates.name != null) connector.name = updates.name
  if (updates.enabled != null) connector.enabled = updates.enabled
  if (updates.baseUrl != null) connector.baseUrl = updates.baseUrl
  if (updates.apiKey != null) connector.apiKey = updates.apiKey
  if (updates.maxConcurrent != null) {
    connector.maxConcurrent = Math.max(1, Math.min(100, Math.floor(updates.maxConcurrent)))
  }

  flush()
  return connector
}

export function deleteConnector(id: string): boolean {
  const connector = connectors.find(c => c.id === id)
  if (!connector) return false
  if (connector.type === "claude-sdk") {
    throw new Error("Cannot delete the Claude SDK connector")
  }
  connectors = connectors.filter(c => c.id !== id)
  flush()
  return true
}

export function updateConnectorModels(id: string, models: ModelEntry[]): ConnectorConfig | undefined {
  const connector = connectors.find(c => c.id === id)
  if (!connector) return undefined
  connector.models = models
  connector.modelsLastFetched = Date.now()
  flush()
  return connector
}

export function toggleModel(connectorId: string, modelId: string, enabled: boolean): boolean {
  const connector = connectors.find(c => c.id === connectorId)
  if (!connector) return false
  const model = connector.models.find(m => m.id === modelId)
  if (!model) return false
  model.enabled = enabled
  flush()
  return true
}

/**
 * Get all enabled models across all enabled connectors.
 * Returns a flat list with connector info attached.
 */
export function getAllEnabledModels(): Array<ModelEntry & { connectorId: string; connectorType: ConnectorType }> {
  const result: Array<ModelEntry & { connectorId: string; connectorType: ConnectorType }> = []
  for (const c of connectors) {
    if (!c.enabled) continue
    for (const m of c.models) {
      if (!m.enabled) continue
      result.push({ ...m, connectorId: c.id, connectorType: c.type })
    }
  }
  return result
}

/**
 * Find which connector handles a given model ID.
 * Returns the connector config or undefined if no match.
 */
export function findConnectorForModel(modelId: string): ConnectorConfig | undefined {
  for (const c of connectors) {
    if (!c.enabled) continue
    if (c.models.some(m => m.enabled && m.id === modelId)) return c
  }
  return undefined
}
