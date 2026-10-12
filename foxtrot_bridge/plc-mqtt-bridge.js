const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const mqtt = require('mqtt');
const iconv = require('iconv-lite');

// Supervisor writes the add-on options here; OPTIONS_PATH lets tests point elsewhere
const OPTIONS_PATH = process.env.OPTIONS_PATH || '/data/options.json';
const options = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));

const LOG_LEVELS = { error: 0, warning: 1, info: 2, debug: 3 };
const logLevel = LOG_LEVELS[options.log_level] ?? LOG_LEVELS.info;
const log = {
    error: (...args) => logLevel >= LOG_LEVELS.error && console.error('[ERROR]', ...args),
    warn: (...args) => logLevel >= LOG_LEVELS.warning && console.warn('[WARN]', ...args),
    info: (...args) => logLevel >= LOG_LEVELS.info && console.log('[INFO]', ...args),
    debug: (...args) => logLevel >= LOG_LEVELS.debug && console.log('[DEBUG]', ...args),
};

// Entity types that accept commands from Home Assistant
const WRITABLE_ENTITIES = ['switch', 'number'];
const SUPPORTED_ENTITIES = ['sensor', 'binary_sensor', ...WRITABLE_ENTITIES];
const INTEGER_TYPES = ['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'];
const UNSIGNED_TYPES = ['USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'];
const FLOAT_TYPES = ['REAL', 'LREAL'];

// PLCComS heartbeat variable, always present in the public file
const HEARTBEAT_VARIABLE = '__PLC_RUN';
const PLC_RESTART_DELAY_MS = 2000;
const WRITE_DEBOUNCE_MS = 1000;
const ENERGY_RESTORE_MS = 3000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseOptionalNumber = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

// One device discovery topic carries every entity, so removed variables can be cleaned up
const DEVICE_ID = 'plc_foxtrot_bridge';
const DEVICE_TOPIC = `homeassistant/device/${DEVICE_ID}/config`;
const DISCOVERY_SCAN_MS = 2000;
const DISCOVERY_STEP_MS = 1000;
const PACKAGE = require('./package.json');

// Options shared by PLCComS and web variables
const commonVariableOptions = (variable) => ({
    name: variable.name,
    friendlyName: variable.friendlyName,
    icon: variable.icon,
    type: (variable.type || 'REAL').toUpperCase(),
    unitOfMeasurement: variable.unitOfMeasurement || '',
    deviceClass: variable.deviceClass,
    stateClass: variable.stateClass,
});

// Text-like PLC types have no numeric state, so they must not get a state_class
const isTextType = (type) => type.startsWith('STRING') || ['TIME', 'DATE', 'TOD', 'DT', 'DATE_AND_TIME', 'TIME_OF_DAY'].includes(type);

const config = {
    plc: {
        host: options.plc_host,
        port: options.plc_port,
    },
    mqtt: {
        host: options.mqtt_host,
        port: options.mqtt_port,
        username: options.mqtt_user,
        password: options.mqtt_password,
        baseTopic: options.mqtt_topic,
    },
    writeEnabled: options.write_enabled !== false,
    variables: (options.variables || []).map(variable => {
        let entity = (variable.entity || 'sensor').toLowerCase();
        if (!SUPPORTED_ENTITIES.includes(entity)) {
            log.warn(`Unsupported entity '${entity}' for ${variable.name}, falling back to sensor`);
            entity = 'sensor';
        }
        const type = (variable.type || 'REAL').toUpperCase();
        return {
            ...commonVariableOptions(variable),
            source: 'plc',
            entity,
            calculateEnergy: variable.calculateEnergy || false,
            min: parseOptionalNumber(variable.min),
            max: parseOptionalNumber(variable.max),
            step: parseOptionalNumber(variable.step),
            // Smallest change PLCComS reports as DIFF; noisy analog values would otherwise flood MQTT
            delta: parseOptionalNumber(variable.delta) ?? (FLOAT_TYPES.includes(type) ? 0.05 : 0),
        };
    }),
    // Values that only exist on the PLC web pages (not in the PLCComS public file), read-only
    web: {
        port: options.web_port || 80,
        user: options.web_user || '',
        password: options.web_password || '',
    },
    webVariables: (options.web_variables || []).map(variable => ({
        ...commonVariableOptions(variable),
        source: 'web',
        page: variable.page,
        input: variable.input,
        entity: (variable.entity || 'sensor').toLowerCase() === 'binary_sensor' ? 'binary_sensor' : 'sensor',
        calculateEnergy: false,
    })),
    interval: (parseInt(options.refresh_interval) || 5) * 1000, // Convert to milliseconds with fallback
    // Full re-read of all PLCComS variables; changes in between arrive as DIFF pushes
    resyncInterval: Math.max(parseInt(options.resync_interval) || 60, 10) * 1000,
};

if (!config.plc.host || !config.plc.port || !config.mqtt.host || !config.mqtt.port) {
    log.error('Missing plc_host, plc_port, mqtt_host or mqtt_port in', OPTIONS_PATH);
    process.exit(1);
}

const sanitizeName = (name) => name.replace(/[^a-zA-Z0-9-_]/g, '_');

// Names that differ only in punctuation (A.B vs A_B) would share discovery topics and unique ids
{
    const seen = new Map();
    for (const variable of [...config.variables, ...config.webVariables]) {
        const key = sanitizeName(variable.name);
        if (seen.has(key)) {
            log.error(`Variables '${seen.get(key)}' and '${variable.name}' map to the same entity id '${key}'; rename one of them`);
            process.exit(1);
        }
        seen.set(key, variable.name);
    }
}

log.info('Configuration:', {
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

const statusTopic = (part) => `${config.mqtt.baseTopic}/${part}/status`;
const energyTopic = (variable) => `${config.mqtt.baseTopic}/${variable.name}/energy/state`;

class PlcMqttBridge {
    constructor() {
        this.plcConnected = false;
        this.mqttConnected = false;
        this.plcBuffer = '';
        this.lastPlcResponse = 0;
        this.sourceStatus = { plc: null, web: null };
        this.pendingWrites = {};
        this.lastValues = {};
        this.lastUpdateTime = {};
        this.energyValues = {};
        this.energyRestored = false;
        this.setupMqtt();
        this.setupPlc();

        // Add periodic connection status logging
        setInterval(() => {
            log.debug(`Connection Status - PLC: ${this.plcConnected}, MQTT: ${this.mqttConnected}`);
        }, 30000);
    }

    setupMqtt() {
        log.info('Setting up MQTT connection...');
        const mqttUrl = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

        this.mqttClient = mqtt.connect(mqttUrl, {
            username: config.mqtt.username,
            password: config.mqtt.password,
            keepalive: 60,
            reconnectPeriod: 5000,
            connectTimeout: 30000,
            // Broker marks every entity unavailable when the bridge dies without saying goodbye
            will: { topic: statusTopic('bridge'), payload: 'offline', retain: true, qos: 1 },
        });

        this.mqttClient.on('connect', () => {
            log.info('Connected to MQTT broker');
            this.mqttConnected = true;
            this.mqttClient.publish(statusTopic('bridge'), 'online', { retain: true, qos: 1 });
            this.publishSourceStatus('plc', this.plcConnected && this.plcRunning !== false, true);
            // Web status is only known after the first poll; publishing it earlier would flash offline
            if (config.webVariables.length && this.sourceStatus.web !== null) {
                this.publishSourceStatus('web', this.sourceStatus.web, true);
            }
            this.restoreEnergyCounters();
            this.announceDevice(!this.discoveryDone).catch(error => log.error('MQTT discovery failed:', error));
            this.setupMqttSubscriptions();
        });

        this.mqttClient.on('message', (topic, payload, packet) => {
            if (this.retainedScan && topic.startsWith('homeassistant/')) {
                this.retainedScan[topic] = payload.toString();
                return;
            }
            if (topic.endsWith('/energy/state')) {
                this.handleEnergyRestore(topic, payload.toString());
                return;
            }
            this.handleMqttCommand(topic, payload.toString(), packet);
        });

        this.mqttClient.on('error', (error) => {
            log.error('MQTT Error:', error);
            this.mqttConnected = false;
        });

        this.mqttClient.on('close', () => {
            log.info('MQTT connection closed');
            this.mqttConnected = false;
        });

        this.mqttClient.on('offline', () => {
            log.info('MQTT client is offline');
            this.mqttConnected = false;
        });
    }

    publishSourceStatus(source, online, force = false) {
        if (!force && this.sourceStatus[source] === online) return;
        this.sourceStatus[source] = online;
        if (this.mqttConnected) {
            this.mqttClient.publish(statusTopic(source), online ? 'online' : 'offline', { retain: true, qos: 1 });
        }
    }

    restoreEnergyCounters() {
        // Energy totals live only in memory, so pick them up from the retained state of the last run
        if (this.energyRestored) return;
        const topics = config.variables.filter(v => v.calculateEnergy).map(energyTopic);
        if (!topics.length) {
            this.energyRestored = true;
            return;
        }
        this.restoredEnergy = {};
        this.mqttClient.subscribe(topics);
        setTimeout(() => {
            this.mqttClient.unsubscribe(topics);
            config.variables.filter(v => v.calculateEnergy).forEach(variable => {
                this.energyValues[variable.name] = (this.restoredEnergy[variable.name] || 0) + (this.energyValues[variable.name] || 0);
            });
            this.energyRestored = true;
            log.info('Energy counters restored:', this.restoredEnergy);
        }, ENERGY_RESTORE_MS);
    }

    handleEnergyRestore(topic, payload) {
        if (this.energyRestored) return;
        const variable = config.variables.find(v => v.calculateEnergy && energyTopic(v) === topic);
        const value = Number.parseFloat(payload);
        if (variable && Number.isFinite(value)) {
            this.restoredEnergy[variable.name] = value;
        }
    }

    commandTopic(variable) {
        return `${config.mqtt.baseTopic}/${variable.name}/set`;
    }

    setupMqttSubscriptions() {
        if (!config.writeEnabled) {
            log.info('Writing to PLC is disabled (write_enabled: false), not subscribing to command topics');
            return;
        }

        config.variables.filter(isWritable).forEach(variable => {
            const commandTopic = this.commandTopic(variable);
            this.mqttClient.subscribe(commandTopic, (err) => {
                if (err) {
                    log.error(`Error subscribing to ${commandTopic}:`, err);
                } else {
                    log.debug(`Subscribed to ${commandTopic}`);
                }
            });
        });
    }

    handleMqttCommand(topic, payload, packet) {
        // A retained command would be replayed on every reconnect and silently rewrite the PLC
        if (packet && packet.retain) {
            log.warn(`Ignoring retained command on ${topic}: ${payload}`);
            return;
        }

        const variable = config.variables.find(v => this.commandTopic(v) === topic);
        if (!variable || !isWritable(variable)) {
            log.warn(`Ignoring command for non-writable topic ${topic}`);
            return;
        }

        const plcValue = this.convertCommandValue(variable, payload.trim());
        if (plcValue === undefined) {
            log.error(`Rejected invalid value '${payload}' for ${variable.name} (type ${variable.type}, min ${variable.min}, max ${variable.max})`);
            return;
        }

        // Rapid +/- clicks would each hit retentive PLC memory; only the last value within the window is written
        clearTimeout(this.pendingWrites[variable.name]);
        this.pendingWrites[variable.name] = setTimeout(() => {
            delete this.pendingWrites[variable.name];
            log.info(`Writing ${variable.name} = ${plcValue} (requested '${payload}')`);
            this.sendPlcCommand(`SET:${variable.name},${plcValue}`);

            // Read the value back so Home Assistant shows what the PLC really holds
            setTimeout(() => this.sendPlcCommand(`GET:${variable.name}`), 500);
        }, WRITE_DEBOUNCE_MS);
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
        const device = {
            identifiers: [DEVICE_ID],
            name: 'PLC Foxtrot Bridge',
            manufacturer: 'Teco a.s.',
            model: this.plcInfo?.model || 'Tecomat Foxtrot',
            configuration_url: `http://${config.plc.host}/`,
        };
        if (this.plcInfo?.firmware) {
            device.sw_version = this.plcInfo.firmware;
        }
        return device;
    }

    availability(variable) {
        return {
            availability: [{ topic: statusTopic('bridge') }, { topic: statusTopic(variable.source) }],
            availability_mode: 'all',
        };
    }

    defaultDeviceClass(unit) {
        switch (unit) {
            case 'kW':
            case 'W':
            case 'MW':
            case 'GW':
                return 'power';
            case 'kWh':
            case 'Wh':
                return 'energy';
            case '°C':
            case '℃':
                return 'temperature';
            case 'h':
            case 'min':
            case 's':
                return 'duration';
            case 'V':
                return 'voltage';
            case 'A':
                return 'current';
            // '%' is deliberately unmapped: valve positions and duty cycles are not humidity
            default:
                return null;
        }
    }

    // Discovery config of every entity, keyed by unique_id (used as the component id)
    componentConfigs() {
        const components = {};
        [...config.variables, ...config.webVariables].forEach(variable => {
            const sanitizedName = sanitizeName(variable.name);
            const component = componentFor(variable);
            const deviceClass = variable.deviceClass || this.defaultDeviceClass(variable.unitOfMeasurement);
            const uniqueId = `plc_${sanitizedName}_${component}`;

            const entity = {
                p: component,
                unique_id: uniqueId,
                name: variable.friendlyName || variable.name,
                state_topic: `${config.mqtt.baseTopic}/${variable.name}/state`,
                ...this.availability(variable),
            };
            if (variable.icon) {
                entity.icon = variable.icon;
            }

            switch (component) {
                case 'sensor':
                    if (variable.unitOfMeasurement) {
                        entity.unit_of_measurement = variable.unitOfMeasurement;
                    }
                    if (deviceClass) {
                        entity.device_class = deviceClass;
                    }
                    if (variable.stateClass) {
                        entity.state_class = variable.stateClass;
                    } else if (!isTextType(variable.type)) {
                        entity.state_class = deviceClass === 'energy' ? 'total_increasing' : 'measurement';
                    }
                    break;
                case 'binary_sensor':
                    entity.payload_on = 'ON';
                    entity.payload_off = 'OFF';
                    if (variable.deviceClass) {
                        entity.device_class = variable.deviceClass;
                    }
                    break;
                case 'switch':
                    entity.command_topic = this.commandTopic(variable);
                    entity.payload_on = 'ON';
                    entity.payload_off = 'OFF';
                    break;
                case 'number':
                    entity.command_topic = this.commandTopic(variable);
                    entity.mode = 'box';
                    entity.min = variable.min ?? -1000000;
                    entity.max = variable.max ?? 1000000;
                    entity.step = variable.step ?? (INTEGER_TYPES.includes(variable.type) ? 1 : 0.1);
                    if (variable.unitOfMeasurement) {
                        entity.unit_of_measurement = variable.unitOfMeasurement;
                    }
                    if (deviceClass === 'temperature') {
                        entity.device_class = deviceClass;
                    }
                    break;
            }
            components[uniqueId] = entity;

            // If calculateEnergy is true, create energy sensor
            if (variable.calculateEnergy) {
                const energyId = `plc_${sanitizedName}_energy`;
                components[energyId] = {
                    p: 'sensor',
                    unique_id: energyId,
                    name: `${variable.friendlyName || variable.name} Energy`,
                    state_topic: energyTopic(variable),
                    unit_of_measurement: 'kWh',
                    device_class: 'energy',
                    state_class: 'total_increasing',
                    ...this.availability(variable),
                };
            }
        });
        return components;
    }

    publishRetained(topic, payload) {
        return new Promise((resolve, reject) => {
            this.mqttClient.publish(topic, payload, { retain: true, qos: 1 }, (err) => err ? reject(err) : resolve());
        });
    }

    publishDevicePayload(components) {
        return this.publishRetained(DEVICE_TOPIC, JSON.stringify({
            device: this.deviceInfo(),
            origin: { name: 'tecomat-foxtrot-mqtt-bridge', sw: PACKAGE.version, url: 'https://github.com/deb0ro/tecomat-foxtrot-mqtt-bridge' },
            qos: 1,
            components,
        }));
    }

    // Retained messages arrive right after subscribing; collect them for a short while
    async collectRetained(topics) {
        this.retainedScan = {};
        await new Promise(resolve => this.mqttClient.subscribe(topics, resolve));
        await sleep(DISCOVERY_SCAN_MS);
        await new Promise(resolve => this.mqttClient.unsubscribe(topics, resolve));
        const collected = this.retainedScan;
        this.retainedScan = null;
        return collected;
    }

    async announceDevice(firstRun) {
        const components = this.componentConfigs();
        if (!firstRun) {
            await this.publishDevicePayload(components);
            return;
        }

        const retained = await this.collectRetained(['homeassistant/+/+/config', DEVICE_TOPIC]);
        const parse = (payload) => {
            try { return JSON.parse(payload); } catch { return null; }
        };

        // Single-component topics of this bridge's own entities move into the device topic.
        // Topics with other unique ids (e.g. a hand-made climate on the same device) are left alone.
        const legacyTopics = Object.entries(retained)
            .filter(([topic, payload]) => topic !== DEVICE_TOPIC && payload && components[parse(payload)?.unique_id])
            .map(([topic]) => topic);
        for (const topic of legacyTopics) {
            await this.publishRetained(topic, JSON.stringify({ migrate_discovery: true }));
        }
        if (legacyTopics.length) {
            log.info(`Migrating ${legacyTopics.length} single-entity discovery topics to ${DEVICE_TOPIC}`);
            await sleep(DISCOVERY_STEP_MS);
        }

        // Entities announced last time but no longer configured are removed in two steps (platform only, then omitted)
        const previous = parse(retained[DEVICE_TOPIC])?.components || parse(retained[DEVICE_TOPIC])?.cmps || {};
        const removed = Object.entries(previous).filter(([id, entity]) => !components[id] && (entity.p || entity.platform));
        if (removed.length) {
            log.info('Removing entities no longer configured:', removed.map(([id]) => id).join(', '));
            await this.publishDevicePayload({ ...components, ...Object.fromEntries(removed.map(([id, entity]) => [id, { p: entity.p || entity.platform }])) });
            await sleep(DISCOVERY_STEP_MS);
        }

        await this.publishDevicePayload(components);
        log.info(`Published discovery for ${Object.keys(components).length} entities`);

        if (legacyTopics.length) {
            await sleep(DISCOVERY_STEP_MS);
            for (const topic of legacyTopics) {
                await this.publishRetained(topic, '');
            }
        }
        this.discoveryDone = true;
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
        const now = Date.now();

        // Integrate before the MQTT check so an outage does not lose energy
        if (variable.calculateEnergy) {
            this.integrateEnergy(variable, Number.parseFloat(value), now);
        }

        if (!this.mqttConnected) {
            log.debug('MQTT not connected, unable to publish:', variable.name, value);
            return;
        }

        const stateTopic = `${config.mqtt.baseTopic}/${variable.name}/state`;
        const stateValue = this.formatStateValue(variable, value);

        this.mqttClient.publish(
            stateTopic,
            stateValue,
            { retain: true, qos: 1 },
            (err) => {
                if (err) {
                    log.error(`Error publishing state to ${stateTopic}:`, err);
                } else {
                    log.debug(`Successfully published state to ${stateTopic}: ${stateValue}`);
                }
            }
        );

        if (variable.calculateEnergy && this.energyRestored) {
            const roundedEnergyValue = this.energyValues[variable.name].toFixed(3);
            this.mqttClient.publish(energyTopic(variable), roundedEnergyValue, { retain: true, qos: 1 });
        }
    }

    integrateEnergy(variable, powerValue, now) {
        if (!Number.isFinite(powerValue)) return;
        const lastTime = this.lastUpdateTime[variable.name];
        const lastPower = this.lastValues[variable.name];

        // Values arrive on change (DIFF), so the previous power held until now; skip gaps after an outage
        if (lastTime !== undefined && lastPower !== undefined && this.plcConnected) {
            const hours = (now - lastTime) / 1000 / 3600;
            if (hours > 0 && hours <= (config.resyncInterval * 3) / 1000 / 3600) {
                this.energyValues[variable.name] = (this.energyValues[variable.name] || 0) + Math.max(lastPower, 0) * hours;
            }
        }

        this.lastValues[variable.name] = powerValue;
        this.lastUpdateTime[variable.name] = now;
    }

    setupPlc() {
        log.info('Setting up PLC connection...');
        this.connectPlc();

        // Reconnection logic
        setInterval(() => {
            if (!this.plcConnected) {
                log.info('Attempting to reconnect to PLC...');
                this.connectPlc();
            }
        }, 5000);

        // Heartbeat and watchdog: a half-open TCP connection never reports an error by itself
        setInterval(() => {
            if (!this.plcConnected) return;
            const silentFor = Date.now() - this.lastPlcResponse;
            if (silentFor > this.plcRequestTimeout()) {
                log.error(`PLC did not answer for ${Math.round(silentFor / 1000)} s, reconnecting`);
                this.plcConnection.destroy();
                this.markPlcDisconnected();
                return;
            }
            this.sendPlcCommand(`GET:${HEARTBEAT_VARIABLE}`);
        }, config.interval);

        // Periodic full re-read in case a DIFF was missed
        setInterval(() => {
            if (this.plcConnected) {
                this.requestPlcUpdates();
            }
        }, config.resyncInterval);

        if (config.webVariables.length) {
            this.webCookie = null;
            this.webPolling = false;
            this.pollWebPages();
            setInterval(() => this.pollWebPages(), config.interval);
        }
    }

    plcRequestTimeout() {
        return config.interval * 3 + 5000;
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
        log.info('Logged in to PLC web interface');
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
        let allOk = true;
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
                            log.warn(`Web input ${variable.input} not found on ${page}`);
                        }
                    });
                } catch (error) {
                    log.error(`Error reading PLC web page ${page}:`, error.message);
                    this.webCookie = null;
                    allOk = false;
                }
            }
        } finally {
            this.webPolling = false;
            this.publishSourceStatus('web', allOk);
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
        this.plcConnection.setTimeout(10000);

        this.plcConnection.on('connect', () => {
            log.info('Connected to PLC');
            this.plcConnection.setTimeout(0);
            this.plcConnection.setKeepAlive(true, 10000);
            this.plcConnected = true;
            this.plcRunning = null;
            this.lastPlcResponse = Date.now();
            // 'online' is published once the first __PLC_RUN answer confirms the program runs
            this.sendPlcCommand('GETINFO:version_plc');
            this.sendPlcCommand(`GET:${HEARTBEAT_VARIABLE}`);
            this.enablePushUpdates();
            this.requestPlcUpdates();
        });

        this.plcConnection.on('timeout', () => {
            log.error('PLC connection attempt timed out');
            this.plcConnection.destroy();
            this.markPlcDisconnected();
        });

        this.plcConnection.on('data', (data) => {
            this.lastPlcResponse = Date.now();
            try {
                // TCP may split or merge lines, keep the incomplete tail for the next chunk
                this.plcBuffer += iconv.decode(data, 'win1250');
                const lines = this.plcBuffer.split(/\r?\n/);
                this.plcBuffer = lines.pop();
                lines.forEach(response => {
                    if (response.trim()) this.handlePlcResponse(response);
                });
            } catch (error) {
                log.error('Error processing PLC data:', error);
            }
        });

        this.plcConnection.on('close', () => {
            log.info('PLC connection closed');
            this.markPlcDisconnected();
        });

        this.plcConnection.on('error', (error) => {
            log.error('PLC Error:', error);
            this.markPlcDisconnected();
        });

        try {
            this.plcConnection.connect(config.plc.port, config.plc.host);
        } catch (error) {
            log.error('Error connecting to PLC:', error);
        }
    }

    markPlcDisconnected() {
        this.plcConnected = false;
        this.publishSourceStatus('plc', false);
    }

    // __PLC_RUN is 0 while the program is stopped (e.g. during a download from Mosaic); the TCP session may survive it
    handlePlcRun(value) {
        const running = Number.parseInt(value) === 1;
        const previous = this.plcRunning;
        this.plcRunning = running;
        if (previous === running) return;

        if (!running) {
            log.warn('PLC program is stopped (__PLC_RUN = 0), marking PLC entities unavailable');
            this.publishSourceStatus('plc', false);
            return;
        }
        if (previous === false) {
            // A new program may come with a new public file, so subscriptions and values are rebuilt from scratch
            log.info(`PLC program started again (__PLC_RUN 0 -> 1), resubscribing in ${PLC_RESTART_DELAY_MS / 1000} s`);
            clearTimeout(this.plcRestartTimer);
            this.plcRestartTimer = setTimeout(() => {
                if (!this.plcConnected || !this.plcRunning) return;
                this.enablePushUpdates();
                this.requestPlcUpdates();
                this.publishSourceStatus('plc', true);
            }, PLC_RESTART_DELAY_MS);
            return;
        }
        this.publishSourceStatus('plc', true);
    }

    enablePushUpdates() {
        // PLCComS keeps EN: per client session, so it has to be repeated after every reconnect
        config.variables.forEach(variable => {
            this.sendPlcCommand(variable.delta ? `EN:${variable.name} ${variable.delta}` : `EN:${variable.name}`);
        });
    }

    requestPlcUpdates() {
        config.variables.forEach(variable => this.sendPlcCommand(`GET:${variable.name}`));
    }

    sendPlcCommand(command) {
        if (!this.plcConnected) {
            log.debug('PLC not connected, cannot send command:', command);
            return;
        }

        try {
            this.plcConnection.write(iconv.encode(command + '\r\n', 'win1250'));
        } catch (error) {
            log.error('Error sending PLC command:', error);
            this.markPlcDisconnected();
        }
    }

    // GETINFO:VERSION_PLC,CP2975I s B 2.7 2.3.062 -> model CP2975I, firmware 2.7 (2.3.062)
    handlePlcInfo(params) {
        const match = /^VERSION_PLC,(\S+)\s+(.*)$/i.exec(params.trim());
        if (!match) return;
        const versions = match[2].trim().split(/\s+/).filter(part => /^\d+(\.\d+)+$/.test(part));
        const info = { model: match[1], firmware: versions.length > 1 ? `${versions[0]} (${versions.slice(1).join(' ')})` : (versions[0] || match[2].trim()) };
        if (this.plcInfo?.model === info.model && this.plcInfo?.firmware === info.firmware) return;
        this.plcInfo = info;
        log.info(`PLC ${info.model}, firmware ${info.firmware}`);
        if (this.mqttConnected && this.discoveryDone) {
            this.publishDevicePayload(this.componentConfigs()).catch(error => log.error('MQTT discovery failed:', error));
        }
    }

    handlePlcResponse(response) {
        // Values may contain ':' or ',' (strings, TIME), so split only on the first separator
        const methodEnd = response.indexOf(':');
        if (methodEnd < 0) {
            log.info('Invalid PLC response format:', response);
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
                        log.debug('Invalid variable/value format:', params);
                        return;
                    }
                    const variableName = params.slice(0, valueStart);
                    const value = params.slice(valueStart + 1);
                    if (variableName.toUpperCase() === HEARTBEAT_VARIABLE) {
                        this.handlePlcRun(value);
                        return;
                    }

                    // PLCComS names are case-insensitive
                    const configVar = config.variables.find(v => v.name.toUpperCase() === variableName.toUpperCase());
                    if (configVar) {
                        this.publishToMqtt(configVar, value);
                    } else {
                        log.debug(`Unmatched variable: ${variableName}`);
                    }
                } catch (error) {
                    log.error('Error handling PLC response:', error);
                }
                break;
            case 'EN':
                // Acknowledgement of a push subscription
                break;
            case 'GETINFO':
                this.handlePlcInfo(params);
                break;
            case 'ERROR':
                log.error('PLC Error:', params);
                break;
            case 'WARNING':
                log.warn('PLC Warning:', params);
                break;
            default:
                log.debug('Unhandled PLC response:', response);
                break;
        }
    }
}

// Start the bridge
log.info('Starting PLC-MQTT Bridge...');
const bridge = new PlcMqttBridge();

// A clean stop does not trigger the MQTT last will, so announce offline explicitly
const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down`);
    const exit = () => process.exit(0);
    setTimeout(exit, 2000);
    if (!bridge.mqttConnected) return exit();
    bridge.mqttClient.publish(statusTopic('bridge'), 'offline', { retain: true, qos: 1 }, () => bridge.mqttClient.end(false, exit));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
