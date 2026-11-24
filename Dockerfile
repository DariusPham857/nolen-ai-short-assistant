FROM node:22.23.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY clients/package.json clients/package.json
COPY servers/package.json servers/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
ENV NODE_ENV=production
ENV WEB_HOST=0.0.0.0
CMD ["pnpm", "--filter", "@nolen/web", "start"]
