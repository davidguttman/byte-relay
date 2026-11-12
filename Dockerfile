# Same checksum-pinned upstream Node release as nixpacks.toml.
# This deployment path intentionally targets Linux amd64.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(dpkg --print-architecture)" = amd64 \
    && curl -fsSL --retry 3 https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && echo '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  /tmp/node.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.xz \
    && test "$(node --version)" = v24.22.1 \
    && useradd --system --uid 10001 --create-home relay
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app.js config.js events.js index.js ssestream.js ./
ENV NODE_ENV=production
USER relay
EXPOSE 3000
CMD ["node", "index.js"]
