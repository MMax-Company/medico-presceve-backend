FROM node:22-alpine AS base

# Install pnpm globally
RUN npm install -g pnpm

# --- Backend Build Stage ---
FROM base AS backend-builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build # If there's a build step for the backend

# --- Dashboard Build Stage ---
FROM base AS dashboard-builder
WORKDIR /app/dashboard-medico
COPY dashboard-medico/package.json dashboard-medico/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY dashboard-medico/ .
RUN pnpm build

# --- Final Production Stage ---
FROM base
WORKDIR /app

# Copy backend dependencies and built files
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/package.json ./
COPY --from=backend-builder /app/server.js ./
COPY --from=backend-builder /app/db.js ./
COPY --from=backend-builder /app/memed.js ./
COPY --from=backend-builder /app/data ./data
COPY --from=backend-builder /app/scripts ./scripts
COPY --from=backend-builder /app/.npmrc ./

# Copy dashboard built files
COPY --from=dashboard-builder /app/dashboard-medico/dist ./dashboard-medico/dist
COPY --from=dashboard-builder /app/dashboard-medico/server ./dashboard-medico/server
COPY --from=dashboard-builder /app/dashboard-medico/shared ./dashboard-medico/shared
COPY --from=dashboard-builder /app/dashboard-medico/drizzle ./dashboard-medico/drizzle

# Create data directory for local recipes
RUN mkdir -p data

# Expose the port that Railway uses (default 3002 or the injected one)
EXPOSE 3002

CMD ["node", "server.js"]
