# Railway container for iTrack.
# The app targets Cloudflare Workers; this image runs the production build
# under wrangler's local workerd runtime behind a Basic Auth identity proxy
# (deploy/railway/serve.mjs). Mount a volume at /data for durable D1/R2 state.

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PERSIST_DIR=/data/wrangler-state

EXPOSE 8080

CMD ["node", "--experimental-sqlite", "deploy/railway/serve.mjs"]
