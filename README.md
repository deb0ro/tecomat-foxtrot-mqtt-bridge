# Tecomat Foxtrot Bridge for Home Assistant

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)

![Project Maintenance][maintenance-shield]
[![GitHub Activity][commits-shield]][commits]

A Home Assistant addon that creates a bridge between Tecomat Foxtrot PLC and Home Assistant using MQTT.

## About

This addon enables real-time monitoring of Tecomat Foxtrot PLC variables in Home Assistant. It connects to your PLC via TCP/IP, reads specified variables at regular intervals, and publishes their values to MQTT topics. The addon supports automatic MQTT discovery in Home Assistant and can be integrated with the Energy Dashboard for power/energy monitoring.

## Features

- 🔄 Real-time PLC variable monitoring
- 🏠 Automatic MQTT device discovery in Home Assistant
- ⚡ Energy monitoring support for power measurements
- 🔌 Easy integration with Home Assistant's Energy Dashboard
- 🛠️ Configurable refresh intervals
- 📊 Support for multiple PLC variables
- 🔐 Secure MQTT authentication

## Installation

1. Add this repository to your Home Assistant instance:
   ```
   https://github.com/yourusername/ha-foxtrot-bridge
   ```

2. Search for "Tecomat Foxtrot Bridge" in the Add-on Store
3. Install the add-on
4. Configure the add-on (see configuration below)
5. Start the add-on

## Configuration

Here's a basic configuration example:

Configure the addon using options in the addon.

For detailed configuration options, see [CONFIGURATION.md](documentation/CONFIGURATION.md)

## How It Works

1. **PLC Connection**: The addon establishes a TCP connection to your Tecomat Foxtrot PLC using the configured host and port.

2. **Variable Monitoring**: For each configured variable:
   - The addon sends a `GET` command to the PLC at the specified refresh interval
   - The PLC responds with the current value
   - The value is processed and formatted according to the variable type

3. **MQTT Publishing**: 
   - Values are published to MQTT topics in the format: `plc/foxtrot/<variable_name>/state`
   - For energy-enabled variables, additional energy calculations are performed and published to: `plc/foxtrot/<variable_name>/energy/state`

4. **Home Assistant Integration**:
   - The addon uses MQTT discovery to automatically create sensors in Home Assistant
   - Power sensors (kW) are created with appropriate device classes and units
   - Energy sensors (kWh) are created for variables with `calculateEnergy: true`

## Energy Dashboard Integration

For variables configured with `calculateEnergy: true`, the addon will:
1. Create a power sensor (kW) showing instantaneous power
2. Create an energy sensor (kWh) calculating total consumption
3. Configure the energy sensor for direct use in Home Assistant's Energy Dashboard

To add energy monitoring:
1. Configure your power variables with `calculateEnergy: true`
2. Go to Home Assistant's Energy Dashboard
3. Add the energy sensors (they'll have "_energy" suffix)

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](documentation/CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with Tecomat. Use at your own risk.

[releases-shield]: https://img.shields.io/github/release/yourusername/ha-foxtrot-bridge.svg
[releases]: https://github.com/yourusername/ha-foxtrot-bridge/releases
[license-shield]: https://img.shields.io/github/license/yourusername/ha-foxtrot-bridge.svg
[maintenance-shield]: https://img.shields.io/maintenance/yes/2025.svg
[commits-shield]: https://img.shields.io/github/commit-activity/y/yourusername/ha-foxtrot-bridge.svg
[commits]: https://github.com/yourusername/ha-foxtrot-bridge/commits/main