# Linux image for the e2e scripts (see run.sh): Node of the e2e machine, pnpm, the libraries
# Electron needs, Xvfb, the docker client (docker exec into the test containers) and the
# MySQL / MariaDB command-line tools that Copy Database, export and import run.
FROM docker:29-cli AS docker-cli
FROM mysql:8.4 AS mysql-client

FROM node:24.17.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth rsync socat util-linux ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libasound2 \
      libxss1 libxshmfence1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libsecret-1-0 \
      fonts-liberation fonts-dejavu-core \
      mariadb-client python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# MySQL's own client and dump, for the MySQL servers (src/main/tools/mysql.ts looks in /usr/local/mysql/bin)
COPY --from=mysql-client /usr/bin/mysql /usr/bin/mysqldump /usr/local/mysql/bin/

RUN npm install -g pnpm@10.32.1

ENV electron_config_cache=/cache/electron \
    npm_config_store_dir=/cache/pnpm-store
