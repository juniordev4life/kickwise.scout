FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
USER node
# Use ENTRYPOINT so that args passed via `gcloud run jobs execute --args=...`
# are appended to "node src/index.js" instead of replacing the CMD entirely.
ENTRYPOINT ["node", "src/index.js"]
CMD ["--mode=current-season"]
