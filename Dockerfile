FROM ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system deps + Node.js
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    git \
    ca-certificates \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (SDK refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude
USER claude

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/claude/.bun/bin:$PATH"

# Install Claude CLI via Bun (npm global doesn't work for non-root)
RUN bun install -g @anthropic-ai/claude-code

# Set up working directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY --chown=claude:claude package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY --chown=claude:claude . .

# Expose proxy port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://127.0.0.1:3456/health || exit 1

# Default: passthrough mode with supervisor
ENV CLAUDE_PROXY_PASSTHROUGH=1
ENV CLAUDE_PROXY_HOST=0.0.0.0
CMD ["./bin/claude-proxy-supervisor.sh"]
