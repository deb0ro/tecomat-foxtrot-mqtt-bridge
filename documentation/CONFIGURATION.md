# Configuration

## Required Configuration

| Option | Type | Description |
|--------|------|-------------|
| `plc_host` | string | IP address or hostname of your Tecomat Foxtrot PLC |
| `plc_port` | number | TCP port number for PLC communication (default: 5010) |
| `mqtt_host` | string | MQTT broker hostname (use "core-mosquitto" for Home Assistant's built-in broker) |
| `mqtt_port` | number | MQTT broker port (default: 1883) |
| `mqtt_user` | string | MQTT username |
| `mqtt_password` | string | MQTT password |
| `mqtt_topic` | string | Base MQTT topic for all messages (default: "plc/foxtrot") |
| `refresh_interval` | number | How often to read values from PLC (in seconds) |
| `variables` | list | List of PLC variables to monitor (see Variables Configuration) |

## Variables Configuration

Each variable in the `variables` list requires:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Variable name exactly as defined in PLC |
| `type` | string | Yes | Data type (e.g., "REAL", "INT", etc.) |
| `unitOfMeasurement` | string | Yes | Unit of measurement (e.g., "kW", "°C") |
| `calculateEnergy` | boolean | No | Enable energy calculation for power measurements |

## Full Configuration Example

```yaml
plc_host: "IPADDRESS"
plc_port: 5010
mqtt_host: "core-mosquitto"
mqtt_port: 1883
mqtt_user: "MQTTUSER"
mqtt_password: "MQTTPWD"
mqtt_topic: "plc/foxtrot"
refresh_interval: 10
variables:
  # Power measurements with energy calculation
  - name: "AC_EON.L123_KW"
    type: "REAL"
    unitOfMeasurement: "kW"
    calculateEnergy: true
  
  - name: "AC_FVE.L123_KW"
    type: "REAL"
    unitOfMeasurement: "kW"
    calculateEnergy: true
  
  # Temperature sensor without energy calculation
  - name: "ROOM_TEMP"
    type: "REAL"
    unitOfMeasurement: "°C"
  
  # Digital input
  - name: "DIGITAL_INPUT"
    type: "BOOL"
    unitOfMeasurement: ""
```

## Network Configuration

- Ensure your PLC is accessible from Home Assistant
- Default port 5010 must be open on your PLC
- MQTT broker must be accessible (built-in broker recommended)

## Security Considerations

- Use strong passwords for MQTT authentication
- Consider using MQTT over TLS if accessing from outside your network
- Keep your PLC firmware up to date
- Restrict PLC access to trusted network segments

## Troubleshooting

1. **No MQTT Messages**:
   - Check MQTT credentials
   - Verify MQTT broker is running
   - Check MQTT port accessibility

2. **No PLC Data**:
   - Verify PLC IP address and port
   - Check network connectivity
   - Verify variable names match exactly

3. **Energy Values Not Appearing**:
   - Confirm `calculateEnergy` is set to true
   - Check unit of measurement is "kW"
   - Verify power values are being received

## Support

For issues and feature requests, please use the GitHub issue tracker.