/**
 * Admin API routes for connector management.
 */

import { Hono } from "hono"
import {
  getAllConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  updateConnectorModels,
  toggleModel,
  getAllEnabledModels,
} from "./store"
import { fetchModelsForConnector } from "./fetcher"
import type { ConnectorType } from "./types"

export function createConnectorRoutes(): Hono {
  const app = new Hono()

  // List all connectors
  app.get("/", (c) => {
    return c.json(getAllConnectors())
  })

  // List all enabled models across connectors
  app.get("/models", (c) => {
    return c.json(getAllEnabledModels())
  })

  // Create a new connector
  app.post("/", async (c) => {
    try {
      const body = await c.req.json()
      const { type, name, baseUrl, apiKey, maxConcurrent } = body
      if (!type || !name) {
        return c.json({ error: "type and name are required" }, 400)
      }
      const validTypes: ConnectorType[] = ["openai", "anthropic"]
      if (!validTypes.includes(type)) {
        return c.json({ error: `type must be one of: ${validTypes.join(", ")}` }, 400)
      }
      const connector = createConnector(type, name, { baseUrl, apiKey, maxConcurrent })
      return c.json(connector, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Update a connector
  app.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json()
      const updated = updateConnector(id, body)
      if (!updated) return c.json({ error: "Connector not found" }, 404)
      return c.json(updated)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Delete a connector
  app.delete("/:id", (c) => {
    try {
      const id = c.req.param("id")
      const deleted = deleteConnector(id)
      if (!deleted) return c.json({ error: "Connector not found" }, 404)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Fetch models from the connector's API
  app.post("/:id/fetch-models", async (c) => {
    try {
      const id = c.req.param("id")
      const connector = getConnector(id)
      if (!connector) return c.json({ error: "Connector not found" }, 404)

      const models = await fetchModelsForConnector(connector)
      const updated = updateConnectorModels(id, models)
      return c.json({ models: updated?.models || [], fetchedAt: Date.now() })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Toggle a model on/off
  app.patch("/:id/models/:modelId", async (c) => {
    try {
      const connectorId = c.req.param("id")
      const modelId = c.req.param("modelId")
      const body = await c.req.json()
      const success = toggleModel(connectorId, modelId, Boolean(body.enabled))
      if (!success) return c.json({ error: "Connector or model not found" }, 404)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  return app
}
