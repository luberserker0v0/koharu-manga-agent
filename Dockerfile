FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    MANGA_TRANSLATION_CONFIG_PATH=/app/docker/koharu.json \
    MANGA_TRANSLATION_DATA_ROOT=/data

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends zip unzip \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node backend ./backend
COPY --chown=node:node docker ./docker

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
