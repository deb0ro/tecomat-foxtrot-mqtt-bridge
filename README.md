# Tecomat Foxtrot Bridge for Home Assistant

[![License][license-shield]](LICENSE)
[![GitHub Activity][commits-shield]][commits]

A Home Assistant add-on that connects a Tecomat Foxtrot PLC to Home Assistant over MQTT.

## Features

- 🔄 Live values via the PLCComS server built into the PLC (`EN:` subscriptions, changes pushed as `DIFF`)
- ✍️ Writing setpoints and flags back to the PLC (`switch` / `number` entities, validated and debounced)
- 🌐 Read-only values that only exist on the PLC web pages (`web_variables`)
- 🏠 MQTT discovery with availability: entities go unavailable when the bridge, the PLC or its web server is down
- ⚡ Energy sensors for the Energy dashboard, from a real meter or integrated from power (persisted across restarts)
- 🩺 Watchdog that reconnects half-open PLC connections

## Installation

1. Add this repository to the Home Assistant app store:
   ```
   https://github.com/deb0ro/tecomat-foxtrot-mqtt-bridge
   ```
2. Install **Tecomat Foxtrot Bridge**
3. Configure it (see [CONFIGURATION.md](documentation/CONFIGURATION.md)) and start it

The PLC must have PLCComS enabled (TCP port 5010 by default) and its variables exported to a public file in Mosaic.

## How It Works

1. **PLC connection**: the bridge connects to PLCComS, subscribes every configured variable with `EN:` and receives
   changes as `DIFF` messages. All variables are re-read every `resync_interval`; `__PLC_RUN` is polled as heartbeat.
2. **MQTT**: values are published to `<mqtt_topic>/<variable>/state`, commands are received on
   `<mqtt_topic>/<variable>/set`, and `<mqtt_topic>/{bridge,plc,web}/status` report availability.
3. **Home Assistant**: entities are created by MQTT discovery under the device *PLC Foxtrot Bridge*.

## Development

```bash
cd foxtrot_bridge
npm ci
npm test
```

The test suite runs the bridge against a fake PLCComS server and an in-process MQTT broker.
Releases are deployed by bumping `version` in `foxtrot_bridge/config.yaml`, pushing to `main` and updating the app in Home Assistant.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with Tecomat. Use at your own risk.

[license-shield]: https://img.shields.io/github/license/deb0ro/tecomat-foxtrot-mqtt-bridge.svg
[commits-shield]: https://img.shields.io/github/commit-activity/y/deb0ro/tecomat-foxtrot-mqtt-bridge.svg
[commits]: https://github.com/deb0ro/tecomat-foxtrot-mqtt-bridge/commits/main
