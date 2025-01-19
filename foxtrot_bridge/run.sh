#!/usr/bin/env bash

# Path to the options.json file
CONFIG_PATH=/data/options.json

# Check if the configuration file exists
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Error: Configuration file not found at $CONFIG_PATH"
    ls -la /data  # List files in the /data directory for debugging
    exit 1
else
    echo "Configuration file found."
fi

# Extract configuration values
echo "Extracting configuration values..."
PLC_HOST=$(jq -r '.plc_host' "$CONFIG_PATH")
PLC_PORT=$(jq -r '.plc_port' "$CONFIG_PATH")
MQTT_HOST=$(jq -r '.mqtt_host' "$CONFIG_PATH")
MQTT_PORT=$(jq -r '.mqtt_port' "$CONFIG_PATH")
MQTT_USER=$(jq -r '.mqtt_user' "$CONFIG_PATH")
MQTT_PASSWORD=$(jq -r '.mqtt_password' "$CONFIG_PATH")
MQTT_TOPIC=$(jq -r '.mqtt_topic' "$CONFIG_PATH")
REFRESH_INTERVAL=$(jq -r '.refresh_interval // 5' "$CONFIG_PATH")  # Default to 5 if not set
VARIABLES=$(jq -r '.variables' "$CONFIG_PATH")

# Validate essential configuration
if [ -z "$PLC_HOST" ] || [ -z "$PLC_PORT" ] || [ -z "$MQTT_HOST" ] || [ -z "$MQTT_PORT" ]; then
    echo "Error: Missing required configuration values in $CONFIG_PATH"
    exit 1
fi

# Validate refresh interval
if ! [[ "$REFRESH_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "Warning: Invalid refresh interval. Setting to default value of 5 seconds."
    REFRESH_INTERVAL=5
fi

echo "Using refresh interval: ${REFRESH_INTERVAL} seconds"

# Export the configuration values for the Node.js script
export PLC_HOST PLC_PORT MQTT_HOST MQTT_PORT MQTT_USER MQTT_PASSWORD MQTT_TOPIC REFRESH_INTERVAL VARIABLES

# Start the Node.js application with debug logging
exec node /app/plc-mqtt-bridge.js