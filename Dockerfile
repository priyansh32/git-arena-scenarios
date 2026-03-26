FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /app
ENTRYPOINT ["sh", "-c", "\
  git clone --depth 1 https://github.com/priyansh32/git-arena-scenarios.git . && \
  npm ci && \
  npx tsx scripts/seed-scenarios.ts \
"]
