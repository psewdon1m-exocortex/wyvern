FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM dependencies AS verification
COPY src ./src
COPY bin ./bin
COPY tests ./tests
COPY scripts ./scripts
RUN npm run check

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
RUN groupadd --gid 10001 wyvern && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin wyvern \
    && install -d -o 10001 -g 10001 -m 0750 /run/wyvern /run/wyvern-admin \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/wyvern
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY bin ./bin
USER 10001:10001
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node --input-type=module -e "import {localRequest} from '/app/src/local-client.js'; const s=await localRequest('/run/wyvern/client.sock','GET','/health/live'); if(!s.alive)process.exit(1)"
ENTRYPOINT ["node", "/app/bin/wyvern.js"]
CMD ["serve"]
