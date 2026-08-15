FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY src ./src

RUN mkdir -p /data/images && chown -R node:node /app /data/images
USER node

EXPOSE 3200
CMD ["node", "src/server.js"]
