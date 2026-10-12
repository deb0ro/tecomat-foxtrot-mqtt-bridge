ARG BUILD_ARCH=aarch64
# Newer Supervisor no longer passes BUILD_FROM; pin the official base image so builds are reproducible
ARG BUILD_FROM=ghcr.io/home-assistant/${BUILD_ARCH}-base:3.24
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY plc-mqtt-bridge.js ./

CMD ["node", "/app/plc-mqtt-bridge.js"]
