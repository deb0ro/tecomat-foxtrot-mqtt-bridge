const net = require('net');
const mqtt = require('mqtt');
const iconv = require('iconv-lite');

// Load configuration from environment variables
const config = {
    plc: {
        host: process.env.PLC_HOST,
        port: parseInt(process.env.PLC_PORT),
    },
    mqtt: {
        host: process.env.MQTT_HOST,
        port: parseInt(process.env.MQTT_PORT),
        username: process.env.MQTT_USER,
        password: process.env.MQTT_PASSWORD,
        baseTopic: process.env.MQTT_TOPIC,
    },
    variables: JSON.parse(process.env.VARIABLES || '[]').map(variable => ({
        name: variable.name,
        type: variable.type,
        unitOfMeasurement: variable.unitOfMeasurement,
        calculateEnergy: variable.calculateEnergy || false,
    })),
    interval: (parseInt(process.env.REFRESH_INTERVAL) || 5) * 1000, // Convert to milliseconds with fallback
};

class PlcMqttBridge {
    constructor() {
        this.plcConnected = false;
        this.mqttConnected = false;
        this.lastPlcRequestTimes = {};
        this.plcRequestInterval = config.interval;
        this.lastValues = {};
        this.lastUpdateTime = {};
        this.energyValues = {};
        this.setupMqtt();
        this.setupPlc();
        
        // Add periodic connection status logging
        setInterval(() => {
            console.log(`Connection Status - PLC: ${this.plcConnected}, MQTT: ${this.mqttConnected}`);
        }, 50000);
    }

    setupMqtt() {
        console.log('Setting up MQTT connection...');
        const mqttUrl = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;
        
        this.mqttClient = mqtt.connect(mqttUrl, {
            username: config.mqtt.username,
            password: config.mqtt.password,
            keepalive: 60,
            reconnectPeriod: 5000,
            connectTimeout: 30000,
        });

        this.mqttClient.on('connect', () => {
            console.log('Connected to MQTT broker');
            this.mqttConnected = true;
            this.sendMqttDiscoveryMessages();
            this.setupMqttSubscriptions();
        });

        this.mqttClient.on('error', (error) => {
            console.error('MQTT Error:', error);
            this.mqttConnected = false;
        });

        this.mqttClient.on('close', () => {
            console.log('MQTT connection closed');
            this.mqttConnected = false;
        });

        this.mqttClient.on('offline', () => {
            console.log('MQTT client is offline');
            this.mqttConnected = false;
        });
    }

    setupMqttSubscriptions() {
        config.variables.forEach(variable => {
            const commandTopic = `${config.mqtt.baseTopic}/${variable.name}/set`;
            this.mqttClient.subscribe(commandTopic, (err) => {
                if (err) {
                    console.error(`Error subscribing to ${commandTopic}:`, err);
                } else {
                    console.log(`Subscribed to ${commandTopic}`);
                }
            });
        });
    }

    sendMqttDiscoveryMessages() {
        config.variables.forEach(variable => {
            // Power sensor (kW)
            const powerDiscoveryTopic = `homeassistant/sensor/${variable.name.replace(/\./g, '_')}/config`;
            const powerStateTopic = `${config.mqtt.baseTopic}/${variable.name}/state`;
            
            const powerDiscoveryMessage = {
                name: `${variable.name}`,
                state_topic: powerStateTopic,
                unit_of_measurement: variable.unitOfMeasurement,
                device_class: "power",
                state_class: "measurement",
                unique_id: `plc_${variable.name.replace(/\./g, '_')}_power`,
                device: {
                    identifiers: ['plc_foxtrot_bridge'],
                    name: 'PLC Foxtrot Bridge',
                    manufacturer: 'Custom Integration'
                }
            };

            // Publish power sensor discovery
            this.mqttClient.publish(
                powerDiscoveryTopic, 
                JSON.stringify(powerDiscoveryMessage), 
                { retain: true, qos: 1 },
            );

            // If calculateEnergy is true, create energy sensor
            if (variable.calculateEnergy) {
                const energyDiscoveryTopic = `homeassistant/sensor/${variable.name.replace(/\./g, '_')}_energy/config`;
                const energyStateTopic = `${config.mqtt.baseTopic}/${variable.name}/energy/state`;
                
                const energyDiscoveryMessage = {
                    name: `${variable.name} Energy`,
                    state_topic: energyStateTopic,
                    unit_of_measurement: "kWh",
                    device_class: "energy",
                    state_class: "total_increasing",
                    unique_id: `plc_${variable.name.replace(/\./g, '_')}_energy`,
                    device: {
                        identifiers: ['plc_foxtrot_bridge'],
                        name: 'PLC Foxtrot Bridge',
                        manufacturer: 'Custom Integration'
                    }
                };

                // Publish energy sensor discovery
                this.mqttClient.publish(
                    energyDiscoveryTopic, 
                    JSON.stringify(energyDiscoveryMessage), 
                    { retain: true, qos: 1 },
                );
            }
        });
    }

    publishToMqtt(variable, value) {
        if (!this.mqttConnected) {
            console.log('MQTT not connected, unable to publish:', variable, value);
            return;
        }

        const now = Date.now();
        const powerValue = Number.parseFloat(value);
        
        // Publish power value (kW)
        const powerTopic = `${config.mqtt.baseTopic}/${variable}/state`;
        const roundedPowerValue = powerValue.toFixed(3);
        
        this.mqttClient.publish(
            powerTopic, 
            roundedPowerValue.toString(), 
            { retain: true, qos: 1 },
        );

        // Check if this variable should calculate energy
        const configVar = config.variables.find(v => v.name === variable);
        if (configVar?.calculateEnergy) {
            // Calculate and publish energy value (kWh)
            if (this.lastUpdateTime[variable] && this.lastValues[variable] !== undefined) {
                const timeDiff = (now - this.lastUpdateTime[variable]) / 1000 / 3600; // Convert to hours
                const avgPower = (powerValue + this.lastValues[variable]) / 2; // Average power over the interval
                const energyIncrement = avgPower * timeDiff; // kWh for this interval
                
                this.energyValues[variable] = (this.energyValues[variable] || 0) + energyIncrement;
                
                const energyTopic = `${config.mqtt.baseTopic}/${variable}/energy/state`;
                const roundedEnergyValue = this.energyValues[variable].toFixed(3);
                
                this.mqttClient.publish(
                    energyTopic,
                    roundedEnergyValue.toString(),
                    { retain: true, qos: 1 },
                );
            }

            // Store current values for next calculation
            this.lastValues[variable] = powerValue;
            this.lastUpdateTime[variable] = now;
        }
    }

    setupPlc() {
        console.log('Setting up PLC connection...');
        this.connectPlc();

        // Reconnection logic
        setInterval(() => {
            if (!this.plcConnected) {
                console.log('Attempting to reconnect to PLC...');
                this.connectPlc();
            }
        }, 5000);

        // Periodic PLC variable monitoring
        setInterval(() => {
            if (this.plcConnected) {
                this.requestPlcUpdates();
            }
        }, this.plcRequestInterval);
    }

    connectPlc() {
        this.plcConnection = new net.Socket();

        this.plcConnection.on('connect', () => {
            console.log('Connected to PLC');
            this.plcConnected = true;
            this.lastPlcRequestTimes = {};
        });

        this.plcConnection.on('data', (data) => {
            try {
                const responses = iconv.decode(data, 'win1250').split('\r\n');
                responses.forEach(response => {
                    if (response.trim()) this.handlePlcResponse(response);
                });
            } catch (error) {
                console.error('Error processing PLC data:', error);
            }
        });

        this.plcConnection.on('close', () => {
            console.log('PLC connection closed');
            this.plcConnected = false;
        });

        this.plcConnection.on('error', (error) => {
            console.error('PLC Error:', error);
            this.plcConnected = false;
        });

        try {
            this.plcConnection.connect(config.plc.port, config.plc.host);
        } catch (error) {
            console.error('Error connecting to PLC:', error);
        }
    }

    requestPlcUpdates() {
        const now = Date.now();
        
        config.variables.forEach(variable => {
            const lastRequest = this.lastPlcRequestTimes[variable.name] || 0;
            const timeSinceLastRequest = now - lastRequest;
            
            if (timeSinceLastRequest >= this.plcRequestInterval) {
                this.sendPlcCommand(`GET:${variable.name}`);
                this.lastPlcRequestTimes[variable.name] = now;
            }
        });
    }

    sendPlcCommand(command) {
        if (!this.plcConnected) {
            console.log('PLC not connected, cannot send command:', command);
            return;
        }

        try {
            this.plcConnection.write(command + '\r\n');
        } catch (error) {
            console.error('Error sending PLC command:', error);
            this.plcConnected = false;
        }
    }

    handlePlcResponse(response) {
        
        const [method, params] = response.split(':');
        if (!params) {
            console.log('Invalid PLC response format:', response);
            return;
        }

        switch (method) {
            case 'GET':
            case 'DIFF':
                try {
                    const [variable, value] = params.split(',');
                    if (!variable || value === undefined) {
                        console.log('Invalid variable/value format:', params);
                        return;
                    }

                    const configVar = config.variables.find(v => v.name === variable);
                    if (configVar) {
                        this.publishToMqtt(configVar.name, value);
                    } else {
                        console.log(`Unmatched variable: ${variable}`);
                    }
                } catch (error) {
                    console.error('Error handling PLC response:', error);
                }
                break;
            case 'ERROR':
                console.error('PLC Error:', params);
                break;
            case 'WARNING':
                console.warn('PLC Warning:', params);
                break;
            default:
                console.log('Unhandled PLC response:', response);
                break;
        }
    }
}

// Start the bridge
console.log('Starting PLC-MQTT Bridge...');
const bridge = new PlcMqttBridge();