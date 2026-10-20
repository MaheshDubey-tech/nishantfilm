FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server.js ./
COPY migrations ./migrations
COPY index.html manus-routes.json nishant-portrait.webp ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
