const net = require('net');
const http = require('http');
const crypto = require('crypto');
const mqtt = require('mqtt');
const iconv = require('iconv-lite');

// Entity types that accept commands from Home Assistant
const WRITABLE_ENTITIES = ['switch', 'number'];
const SUPPORTED_ENTITIES = ['sensor', 'binary_sensor', ...WRITABLE_ENTITIES];
const INTEGER_TYPES = ['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'];
const UNSIGNED_TYPES = ['USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'];

const parseOptionalNumber = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

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
    writeEnabled: process.env.WRITE_ENABLED !== 'false',
    variables: JSON.parse(process.env.VARIABLES || '[]').map(variable => {
        let entity = (variable.entity || 'sensor').toLowerCase();
        if (!SUPPORTED_ENTITIES.includes(entity)) {
            console.warn(`Unsupported entity '${entity}' for ${variable.name}, falling back to sensor`);
            entity = 'sensor';
        }
        return {
            name: variable.name,
            type: (variable.type || 'REAL').toUpperCase(),
            entity,
            unitOfMeasurement: variable.unitOfMeasurement || '',
            calculateEnergy: variable.calculateEnergy || false,
            min: parseOptionalNumber(variable.min),
            max: parseOptionalNumber(variable.max),
            step: parseOptionalNumber(variable.step),
        };
    }),
    // Values that only exist on the PLC web pages (not in the PLCComS public file), read-only
    web: {
        port: parseInt(process.env.WEB_PORT) || 80,
        user: process.env.WEB_USER || '',
        password: process.env.WEB_PASSWORD || '',
    },
    webVariables: JSON.parse(process.env.WEB_VARIABLES || '[]').map(variable => ({
        name: variable.name,
        page: variable.page,
        input: variable.input,
        type: (variable.type || 'REAL').toUpperCase(),
        entity: (variable.entity || 'sensor').toLowerCase() === 'binary_sensor' ? 'binary_sensor' : 'sensor',
        unitOfMeasurement: variable.unitOfMeasurement || '',
        calculateEnergy: false,
    })),
    interval: (parseInt(process.env.REFRESH_INTERVAL) || 5) * 1000, // Convert to milliseconds with fallback
};

// Validate configuration
console.log('Configuration:', {
    ...config,
    mqtt: { ...config.mqtt, password: '****' }, // Hide password in logs
    web: { ...config.web, password: config.web.password ? '****' : '' }
});

const isWritable = (variable) => config.writeEnabled && WRITABLE_ENTITIES.includes(variable.entity);

// With writing disabled, writable entities are exposed as their read-only counterparts
const componentFor = (variable) => {
    if (isWritable(variable)) return variable.entity;
    if (variable.entity === 'switch') return 'binary_sensor';
    if (variable.entity === 'number') return 'sensor';
    return variable.entity;
};

class PlcMqttBridge {
    constructor() {
        this.plcConnected = false;
        this.mqttConnected = false;
        this.lastPlcRequestTimes = {};
        this.plcRequestInterval = config.interval;
        this.plcBuffer = '';
        this.lastValues = {};
        this.lastUpdateTime = {};
        this.energyValues = {};
        this.setupMqtt();
        this.setupPlc();

        // Add periodic connection status logging
        setInterval(() => {
            console.log(`Connection Status - PLC: ${this.plcConnected}, MQTT: ${this.mqttConnected}`);
        }, 30000);
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

        this.mqttClient.on('message', (topic, payload, packet) => {
            this.handleMqttCommand(topic, payload.toString(), packet);
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

    commandTopic(variable) {
        return `${config.mqtt.baseTopic}/${variable.name}/set`;
    }

    setupMqttSubscriptions() {
        if (!config.writeEnabled) {
            console.log('Writing to PLC is disabled (write_enabled: false), not subscribing to command topics');
            return;
        }

        config.variables.filter(isWritable).forEach(variable => {
            const commandTopic = this.commandTopic(variable);
            this.mqttClient.subscribe(commandTopic, (err) => {
                if (err) {
                    console.error(`Error subscribing to ${commandTopic}:`, err);
                } else {
                    console.log(`Subscribed to ${commandTopic}`);
                }
            });
        });
    }

    handleMqttCommand(topic, payload, packet) {
        // A retained command would be replayed on every reconnect and silently rewrite the PLC
        if (packet && packet.retain) {
            console.warn(`Ignoring retained command on ${topic}: ${payload}`);
            return;
        }

        const variable = config.variables.find(v => this.commandTopic(v) === topic);
        if (!variable || !isWritable(variable)) {
            console.warn(`Ignoring command for non-writable topic ${topic}`);
            return;
        }

        const plcValue = this.convertCommandValue(variable, payload.trim());
        if (plcValue === undefined) {
            console.error(`Rejected invalid value '${payload}' for ${variable.name} (type ${variable.type}, min ${variable.min}, max ${variable.max})`);
            return;
        }

        console.log(`Writing ${variable.name} = ${plcValue} (requested '${payload}')`);
        this.sendPlcCommand(`SET:${variable.name},${plcValue}`);

        // Read the value back so Home Assistant shows what the PLC really holds
        setTimeout(() => this.sendPlcCommand(`GET:${variable.name}`), 500);
    }

    convertCommandValue(variable, payload) {
        if (variable.type === 'BOOL') {
            const normalized = payload.toUpperCase();
            if (['ON', '1', 'TRUE'].includes(normalized)) return '1';
            if (['OFF', '0', 'FALSE'].includes(normalized)) return '0';
            return undefined;
        }

        let value = Number.parseFloat(payload);
        if (!Number.isFinite(value)) return undefined;
        if (variable.min !== undefined && value < variable.min) return undefined;
        if (variable.max !== undefined && value > variable.max) return undefined;

        if (INTEGER_TYPES.includes(variable.type)) {
            value = Math.round(value);
            if (UNSIGNED_TYPES.includes(variable.type) && value < 0) return undefined;
        }

        return value.toString();
    }

    deviceInfo() {
        return {
            identifiers: ['plc_foxtrot_bridge'],
            name: 'PLC Foxtrot Bridge',
            manufacturer: 'Custom Integration'
        };
    }

    publishDiscovery(topic, message, variableName, label) {
        this.mqttClient.publish(
            topic,
            message === null ? '' : JSON.stringify(message),
            { retain: true, qos: 1 },
            (err) => {
                if (err) {
                    console.error(`Error publishing ${label} discovery message for ${variableName}:`, err);
                } else {
                    console.log(`Successfully published ${label} discovery message for ${variableName}`);
                }
            }
        );
    }

    sendMqttDiscoveryMessages() {
        [...config.variables, ...config.webVariables].forEach(variable => {
            // Sanitize variable name for MQTT discovery topic
            const sanitizedName = variable.name
            .replace(/[^a-zA-Z0-9-_]/g, '_');  // For MQTT topic (strict)

            const component = componentFor(variable);
            const stateTopic = `${config.mqtt.baseTopic}/${variable.name}/state`;

            // Determine appropriate device class based on unit of measurement
            let deviceClass = null;

            switch(variable.unitOfMeasurement) {
                case 'kW':
                case 'W':
                case 'MW':
                case 'GW':
                    deviceClass = "power";
                    break;
                case '°C':
                case '℃':
                    deviceClass = "temperature";
                    break;
                case 'h':
                case 'min':
                case 's':
                    deviceClass = "duration";
                    break;
                case '%':
                    deviceClass = "humidity";
                    break;
                case 'V':
                    deviceClass = "voltage";
                    break;
                case 'A':
                    deviceClass = "current";
                    break;
                // Add more mappings as needed
            }

            const discoveryMessage = {
                name: `${variable.name}`,
                state_topic: stateTopic,
                unique_id: `plc_${sanitizedName}_${component}`,
                device: this.deviceInfo()
            };

            switch (component) {
                case 'sensor':
                    discoveryMessage.unit_of_measurement = variable.unitOfMeasurement;
                    if (deviceClass) {
                        discoveryMessage.device_class = deviceClass;
                    }
                    discoveryMessage.state_class = "measurement";
                    break;
                case 'binary_sensor':
                    discoveryMessage.payload_on = 'ON';
                    discoveryMessage.payload_off = 'OFF';
                    break;
                case 'switch':
                    discoveryMessage.command_topic = this.commandTopic(variable);
                    discoveryMessage.payload_on = 'ON';
                    discoveryMessage.payload_off = 'OFF';
                    break;
                case 'number':
                    discoveryMessage.command_topic = this.commandTopic(variable);
                    discoveryMessage.mode = 'box';
                    discoveryMessage.min = variable.min ?? -1000000;
                    discoveryMessage.max = variable.max ?? 1000000;
                    discoveryMessage.step = variable.step ?? (INTEGER_TYPES.includes(variable.type) ? 1 : 0.1);
                    if (variable.unitOfMeasurement) {
                        discoveryMessage.unit_of_measurement = variable.unitOfMeasurement;
                    }
                    if (deviceClass === 'temperature') {
                        discoveryMessage.device_class = deviceClass;
                    }
                    break;
            }

            this.publishDiscovery(`homeassistant/${component}/${sanitizedName}/config`, discoveryMessage, variable.name, component);

            // Drop discovery left over from a previous entity type of this variable (e.g. sensor -> number)
            SUPPORTED_ENTITIES
                .filter(other => other !== component)
                .forEach(other => this.publishDiscovery(`homeassistant/${other}/${sanitizedName}/config`, null, variable.name, `stale ${other}`));

            // If calculateEnergy is true, create energy sensor
            if (variable.calculateEnergy) {
                const energyDiscoveryTopic = `homeassistant/sensor/${sanitizedName}_energy/config`;
                const energyStateTopic = `${config.mqtt.baseTopic}/${variable.name}/energy/state`;

                const energyDiscoveryMessage = {
                    name: `${variable.name} Energy`,
                    state_topic: energyStateTopic,
                    unit_of_measurement: "kWh",
                    device_class: "energy",
                    state_class: "total_increasing",
                    unique_id: `plc_${sanitizedName}_energy`,
                    device: this.deviceInfo()
                };

                this.publishDiscovery(energyDiscoveryTopic, energyDiscoveryMessage, variable.name, 'energy');
            }
        });
    }

    formatStateValue(variable, value) {
        if (['binary_sensor', 'switch'].includes(componentFor(variable))) {
            return Number.parseFloat(value) ? 'ON' : 'OFF';
        }
        const numericValue = Number.parseFloat(value);
        if (!Number.isFinite(numericValue)) {
            return value.replace(/^"|"$/g, '');
        }
        if (componentFor(variable) === 'number') {
            return numericValue.toString();
        }
        return numericValue.toFixed(3);
    }

    publishToMqtt(variable, value) {
        if (!this.mqttConnected) {
            console.log('MQTT not connected, unable to publish:', variable.name, value);
            return;
        }

        const now = Date.now();
        const stateTopic = `${config.mqtt.baseTopic}/${variable.name}/state`;
        const stateValue = this.formatStateValue(variable, value);

        this.mqttClient.publish(
            stateTopic,
            stateValue,
            { retain: true, qos: 1 },
            (err) => {
                if (err) {
                    console.error(`Error publishing state to ${stateTopic}:`, err);
                } else {
                    console.log(`Successfully published state to ${stateTopic}: ${stateValue}`);
                }
            }
        );

        // Check if this variable should calculate energy
        if (variable.calculateEnergy) {
            const powerValue = Number.parseFloat(value);

            // Calculate and publish energy value (kWh)
            if (this.lastUpdateTime[variable.name] && this.lastValues[variable.name] !== undefined) {
                const timeDiff = (now - this.lastUpdateTime[variable.name]) / 1000 / 3600; // Convert to hours
                const avgPower = (powerValue + this.lastValues[variable.name]) / 2; // Average power over the interval
                const energyIncrement = avgPower * timeDiff; // kWh for this interval

                this.energyValues[variable.name] = (this.energyValues[variable.name] || 0) + energyIncrement;

                const energyTopic = `${config.mqtt.baseTopic}/${variable.name}/energy/state`;
                const roundedEnergyValue = this.energyValues[variable.name].toFixed(3);

                this.mqttClient.publish(
                    energyTopic,
                    roundedEnergyValue.toString(),
                    { retain: true, qos: 1 },
                    (err) => {
                        if (err) {
                            console.error(`Error publishing energy to ${energyTopic}:`, err);
                        } else {
                            console.log(`Successfully published energy to ${energyTopic}: ${roundedEnergyValue}`);
                        }
                    }
                );
            }

            // Store current values for next calculation
            this.lastValues[variable.name] = powerValue;
            this.lastUpdateTime[variable.name] = now;
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

        if (config.webVariables.length) {
            this.webCookie = null;
            this.webPolling = false;
            this.pollWebPages();
            setInterval(() => this.pollWebPages(), this.plcRequestInterval);
        }
    }

    webRequest(method, path, body) {
        return new Promise((resolve, reject) => {
            const headers = {};
            if (this.webCookie) headers.Cookie = `SoftPLC=${this.webCookie}`;
            if (body !== undefined) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                headers['Content-Length'] = Buffer.byteLength(body);
            }
            const req = http.request({ host: config.plc.host, port: config.web.port, method, path, headers, timeout: 5000 }, (res) => {
                const cookie = (res.headers['set-cookie'] || []).map(c => /SoftPLC=([^;]+)/.exec(c)).find(Boolean);
                if (cookie) this.webCookie = cookie[1];
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body: iconv.decode(Buffer.concat(chunks), 'win1250') }));
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            if (body !== undefined) req.write(body);
            req.end();
        });
    }

    async webLogin() {
        // The login page hands out the session cookie; the password is sent as sha1(cookie + password)
        this.webCookie = null;
        await this.webRequest('GET', '/SYSWWW/LOGIN.XML');
        if (!this.webCookie) throw new Error('PLC web did not set a session cookie');
        const pass = crypto.createHash('sha1').update(this.webCookie + config.web.password).digest('hex');
        const res = await this.webRequest('POST', '/SYSWWW/LOGIN.XML',
            `USER=${encodeURIComponent(config.web.user)}&PASS=${pass}`);
        if (res.status !== 302 || /LOGIN/i.test(res.location)) {
            throw new Error(`PLC web login failed (HTTP ${res.status} ${res.location})`);
        }
        console.log('Logged in to PLC web interface');
    }

    async fetchWebPage(page) {
        let res = await this.webRequest('GET', `/${page}`);
        if (res.status === 302 || /<LOGIN>/.test(res.body)) {
            await this.webLogin();
            res = await this.webRequest('GET', `/${page}`);
        }
        if (res.status !== 200) throw new Error(`PLC web page ${page} returned HTTP ${res.status}`);
        return res.body;
    }

    async pollWebPages() {
        if (this.webPolling) return;
        this.webPolling = true;
        try {
            const pages = [...new Set(config.webVariables.map(v => v.page))];
            for (const page of pages) {
                try {
                    const body = await this.fetchWebPage(page);
                    config.webVariables.filter(v => v.page === page).forEach(variable => {
                        // Inputs are named <hash>_<TYPE>_<format>; the same hash may repeat with another format
                        const match = new RegExp(`<INPUT NAME="${variable.input}_[^"]*" VALUE="([^"]*)"`).exec(body);
                        if (match) {
                            this.publishToMqtt(variable, match[1]);
                        } else {
                            console.warn(`Web input ${variable.input} not found on ${page}`);
                        }
                    });
                } catch (error) {
                    console.error(`Error reading PLC web page ${page}:`, error.message);
                    this.webCookie = null;
                }
            }
        } finally {
            this.webPolling = false;
        }
    }

    connectPlc() {
        // Drop the previous socket so reconnects do not pile up open connections on the PLC
        if (this.plcConnection) {
            this.plcConnection.removeAllListeners();
            this.plcConnection.destroy();
        }
        this.plcConnection = new net.Socket();
        this.plcBuffer = '';

        this.plcConnection.on('connect', () => {
            console.log('Connected to PLC');
            this.plcConnected = true;
            this.lastPlcRequestTimes = {};
        });

        this.plcConnection.on('data', (data) => {
            try {
                // TCP may split or merge lines, keep the incomplete tail for the next chunk
                this.plcBuffer += iconv.decode(data, 'win1250');
                const lines = this.plcBuffer.split(/\r?\n/);
                this.plcBuffer = lines.pop();
                lines.forEach(response => {
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
        console.log('Checking for PLC updates...');

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
            this.plcConnection.write(iconv.encode(command + '\r\n', 'win1250'));
        } catch (error) {
            console.error('Error sending PLC command:', error);
            this.plcConnected = false;
        }
    }

    handlePlcResponse(response) {
        console.log('Raw PLC response:', response);

        // Values may contain ':' or ',' (strings, TIME), so split only on the first separator
        const methodEnd = response.indexOf(':');
        if (methodEnd < 0) {
            console.log('Invalid PLC response format:', response);
            return;
        }
        const method = response.slice(0, methodEnd);
        const params = response.slice(methodEnd + 1);

        switch (method) {
            case 'GET':
            case 'DIFF':
                try {
                    const valueStart = params.indexOf(',');
                    if (valueStart < 0) {
                        console.log('Invalid variable/value format:', params);
                        return;
                    }
                    const variableName = params.slice(0, valueStart);
                    const value = params.slice(valueStart + 1);

                    // PLCComS names are case-insensitive
                    const configVar = config.variables.find(v => v.name.toUpperCase() === variableName.toUpperCase());
                    if (configVar) {
                        console.log(`Processing PLC value for ${variableName}: ${value}`);
                        this.publishToMqtt(configVar, value);
                    } else {
                        console.log(`Unmatched variable: ${variableName}`);
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
