ARG BUILD_ARCH=aarch64
# Newer Supervisor no longer passes BUILD_FROM, fall back to the official base image
ARG BUILD_FROM=ghcr.io/home-assistant/${BUILD_ARCH}-base:latest
FROM $BUILD_FROM

# Install required packages
RUN apk add --no-cache \
    nodejs \
    npm \
    bash \
    jq

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json . 
COPY run.sh . 
COPY plc-mqtt-bridge.js . 

# Install dependencies
RUN npm install

# Make run script executable
RUN chmod +x /app/run.sh

# Command to run the add-on
CMD ["/app/run.sh"]
