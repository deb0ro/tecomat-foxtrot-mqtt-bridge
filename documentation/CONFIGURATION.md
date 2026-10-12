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
| `refresh_interval` | number | Heartbeat to the PLC and web page polling interval (seconds). The PLC is considered offline after 3 missed heartbeats |
| `resync_interval` | number | Optional, default 60. Full re-read of all variables (seconds); changes in between arrive immediately as PLCComS `DIFF` pushes |
| `log_level` | string | Optional, default `info`. One of `error`, `warning`, `info`, `debug`; per-message logs (every published value) only appear at `debug` |
| `write_enabled` | boolean | Optional, default `true`. Master switch for writing to the PLC. When `false`, `switch`/`number` variables are exposed read-only and no command topics are subscribed |
| `variables` | list | List of PLC variables to monitor (see Variables Configuration) |

## Variables Configuration

Each variable in the `variables` list requires:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Variable name exactly as defined in PLC |
| `type` | string | Yes | Data type (e.g., "REAL", "INT", etc.) |
| `unitOfMeasurement` | string | No | Unit of measurement (e.g., "kW", "°C") |
| `calculateEnergy` | boolean | No | Enable energy calculation for power measurements |
| `entity` | string | No | Home Assistant entity type: `sensor` (default), `binary_sensor`, `switch` or `number`. Only `switch` and `number` can write to the PLC |
| `min` / `max` | number | No | Allowed range for `number`. Commands outside the range are rejected and never reach the PLC |
| `step` | number | No | Step for `number` (default 0.1, or 1 for integer types) |
| `delta` | number | No | Smallest change pushed by PLCComS (default 0.05 for REAL/LREAL, 0 otherwise) |
| `deviceClass` / `stateClass` | string | No | Override the Home Assistant device class / state class. Default device class follows the unit (kW→power, kWh→energy, °C→temperature, h→duration, V, A); `%` has none. Text types (STRING, TIME, …) get no state class |
| `friendlyName` | string | No | Entity name shown in Home Assistant (default: the PLC variable name) |
| `icon` | string | No | Entity icon, e.g. `mdi:valve` |

## Thermostats (`climates`)

A thermostat (`climate` entity) is composed of variables that are already configured:

| Option | Required | Description |
|--------|----------|-------------|
| `id` | Yes | Lowercase id (`a-z`, `0-9`, `_`); the entity's unique id is `plc_<id>_climate` |
| `name` | Yes | Entity name |
| `current_temperature` | Yes | Variable (PLCComS or web) with the room temperature |
| `target_temperature` | Yes | PLCComS variable with `entity: number`; writes go through it (range check, debounce) |
| `heating_when_positive` | No | Variable that is above zero while heating runs (e.g. heating-curve correction); the bridge publishes `heating`/`idle` |
| `min` / `max` / `step` | No | Default to the target variable's range |
| `icon` | No | Entity icon |

```yaml
climates:
  - id: zona1_prizemi
    name: "Přízemí"
    current_temperature: TEPLOTY.Z1_PROSTOR
    target_temperature: USERDATA.ZONY.ZONY[1].POZ_DEN
    heating_when_positive: WEB.ZONA1.KOREKCE_EQT
```

The only mode is `heat`. A thermostat that was published by hand under the same unique id is taken over on start.

## Home Assistant discovery

All entities are announced in one retained MQTT device discovery message, `homeassistant/device/plc_foxtrot_bridge/config`
(Home Assistant 2024.11+). The device shows the PLC model and firmware read via `GETINFO` and links to the PLC web UI.

- Removing a variable from the configuration removes its entity on the next start.
- Versions before 1.7.0 used one topic per entity. On the first start, the bridge migrates its own topics
  (`migrate_discovery`) so entity ids, names and history are kept, then clears them. Other entities on the same
  device that the bridge did not create (e.g. a hand-made climate) are left untouched.

## Availability

The bridge publishes `<mqtt_topic>/bridge/status` (with an MQTT last will), `<mqtt_topic>/plc/status` and
`<mqtt_topic>/web/status` (`online`/`offline`).
The PLC counts as offline also while its program is stopped (`__PLC_RUN = 0`, e.g. during a download from Mosaic);
when it starts again, the bridge waits 2 s and re-subscribes and re-reads all variables, since a new program may come
with a new public file. Every entity is unavailable in Home Assistant when the bridge
or its data source is down, instead of showing the last retained value.

## Energy

`calculateEnergy` integrates power over time (the previous value is held until the next change). The total is
restored from the retained MQTT state on start, so restarts do not reset it. Prefer a real meter when the PLC
has one, e.g. via `web_variables` with `deviceClass: energy` and `stateClass: total_increasing`.

## Writing to the PLC

Variables with `entity: switch` or `entity: number` get a command topic `<mqtt_topic>/<variable_name>/set`.
The bridge validates the value (BOOL accepts `ON`/`OFF`/`1`/`0`, numbers are checked against `min`/`max`
and rounded for integer types), waits 1 s so that only the last of rapid changes is written, sends `SET:<variable_name>,<value>` to PLCComS and reads the value back
with `GET:` so Home Assistant shows what the PLC really holds.

Retained messages on command topics are ignored, so a stale command is never replayed after a reconnect.

Only make writable what the PLC program expects to be changed from outside (setpoints, mode flags).
PLCComS itself has no authentication, so keep the PLC on a trusted network segment.

Changing a variable from `sensor` to `number` (or `binary_sensor` to `switch`) creates a new entity in
Home Assistant; the old one is removed from MQTT discovery automatically.

## Values from the PLC web pages

Some values (e.g. the room correction of the heating curve) are only shown on the PLC web pages and are not part of
the PLCComS public file. `web_variables` reads them read-only from the PLC web server (`plc_host`, `web_port`).

| Option | Type | Description |
|--------|------|-------------|
| `web_port` | number | PLC web server port (default 80) |
| `web_user` / `web_password` | string | Web login, empty by default |
| `web_variables[].name` | string | Name used for MQTT topics and the entity |
| `web_variables[].page` | string | Page XML, e.g. `MUZONA1.XML` |
| `web_variables[].input` | string | Input hash from the page source, e.g. `__T17573290` (the `_TYPE_format` suffix is ignored) |
| `web_variables[].type` | string | `REAL`, `BOOL`, ... |
| `web_variables[].entity` | string | `sensor` (default), `binary_sensor`, or writable `switch` / `number` |
| `web_variables[].min` / `max` / `step` | number | Range for a writable `number` |
| `web_variables[].friendlyName` / `icon` / `deviceClass` / `stateClass` | string | Same as for `variables` |

Find the hash by opening the page in a browser and viewing its source (`view-source:http://<plc>/MUZONA1.XML`).
Writable web variables (`switch`, `number`) are written exactly like a click in the PLC web UI: a form POST to the
same page with `encodeURIComponent("<input name with type suffix>=<value>")`, e.g. `__T39B76846_BOOL_i%3D1`. The page
is read back after 1 s. Use this only for buttons the web UI offers; the PLC program reacts as if the button was pressed.

The bridge logs in the same way as the browser (`PASS = sha1(SoftPLC cookie + password)`) and re-logs on session expiry.

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
log_level: info
write_enabled: true
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
    entity: "binary_sensor"

  # Writable setpoint
  - name: "USERDATA.TUV_TC.T_KOMFORT"
    type: "REAL"
    unitOfMeasurement: "°C"
    entity: "number"
    min: 40
    max: 60
    step: 0.5

  # Writable on/off flag
  - name: "USERDATA.TUV_TC.ZAP"
    type: "BOOL"
    entity: "switch"
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

## Notes

- Variable names must stay unique after replacing non-alphanumeric characters with `_` (`A.B` and `A_B` collide); the bridge refuses to start otherwise.
- Supported architectures: `aarch64`, `amd64`.

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