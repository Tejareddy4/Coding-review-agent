# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Production stage ----
FROM node:20-alpine AS production
RUN addgroup -g 1001 -S nodeapp && adduser -S nodeapp -u 1001
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY scripts ./scripts
RUN chown -R nodeapp:nodeapp /app
USER nodeapp
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1
CMD ["node", "src/index.js"]
