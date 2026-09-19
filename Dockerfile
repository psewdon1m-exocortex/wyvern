FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM dependencies AS verification
COPY src ./src
COPY bin ./bin
COPY tests ./tests
COPY scripts ./scripts
RUN npm run check

FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && addgroup -g 10001 wyvern && adduser -D -H -u 10001 -G wyvern -s /sbin/nologin wyvern \
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
