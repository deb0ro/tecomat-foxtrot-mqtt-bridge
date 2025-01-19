ARG BUILD_FROM
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
