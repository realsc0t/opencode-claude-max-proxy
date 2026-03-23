import type { Server } from "node:http"

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  idleTimeoutSeconds: number
  silent: boolean
}

export interface ProxyInstance {
  /** The underlying http.Server */
  server: Server
  /** The resolved proxy configuration */
  config: ProxyConfig
  /** Gracefully shut down the proxy server and clean up resources */
  close(): Promise<void>
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  idleTimeoutSeconds: 120,
  silent: false,
}
