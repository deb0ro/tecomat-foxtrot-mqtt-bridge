// Integration test: fake PLCComS + in-process MQTT broker + real bridge process
const net = require('net');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const iconv = require('iconv-lite');
const aedes = require('aedes')();

const plcVars = {
    '__PLC_RUN': '1',
    'TEPLOTY.VENKU': '2.103242',
    'USERDATA.TUV_TC.T_KOMFORT': '53.000000',
    'USERDATA.TUV_TC.ZAP': '1',
    'USERDATA.ZONY.ZONY[1].FC_DOVOLENA': '0',
    'AC_EON.L123_KW': '2.000000',
};
const plcLog = [];
const sockets = new Set();
let silent = false;

const findKey = name => Object.keys(plcVars).find(k => k.toUpperCase() === name.toUpperCase());

const plc = net.createServer(sock => {
    sockets.add(sock);
    sock.subscribed = new Set();
    let buf = '';
    let chain = Promise.resolve();
    const send = b => chain = chain.then(() => new Promise(r => sock.write(b, () => setTimeout(r, 10))));
    sock.pushDiff = (name) => { if (sock.subscribed.has(name)) send(iconv.encode(`DIFF:${name},${plcVars[name]}\n`, 'win1250')); };
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.on('data', d => {
        if (silent) return;
        buf += iconv.decode(d, 'win1250');
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        const out = [];
        for (const l of lines) {
            plcLog.push(l);
            const cmd = l.slice(0, l.indexOf(':')), rest = l.slice(l.indexOf(':') + 1);
            if (cmd === 'GET') {
                const key = findKey(rest);
                out.push(key ? `GET:${key},${plcVars[key]}` : `ERROR:33 Unknown variable name in request: '${l}'`);
            } else if (cmd === 'EN') {
                const key = findKey(rest.split(' ')[0]);
                if (key) { sock.subscribed.add(key); out.push(`DIFF:${key},${plcVars[key]}`); }
            } else if (cmd === 'SET') {
                const i = rest.indexOf(','); const key = findKey(rest.slice(0, i));
                plcVars[key] = rest.slice(i + 1);
                if (sock.subscribed.has(key)) out.push(`DIFF:${key},${plcVars[key]}`);
            }
        }
        // Send everything in one chunk, split mid-line, to exercise line buffering
        const payload = iconv.encode(out.map(o => o + '\n').join(''), 'win1250');
        if (payload.length > 7) { send(payload.slice(0, 7)); send(payload.slice(7)); }
        else if (payload.length) send(payload);
    });
});

const changePlc = (name, value) => { plcVars[name] = value; sockets.forEach(s => s.pushDiff(name)); };

const broker = net.createServer(aedes.handle);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

plc.listen(15010, () => broker.listen(11883, async () => {
    const writeEnabled = process.argv[3] || 'true';
    const variables = [
        { name: 'TEPLOTY.VENKU', type: 'REAL', unitOfMeasurement: '°C' },
        { name: 'USERDATA.TUV_TC.T_KOMFORT', type: 'REAL', unitOfMeasurement: '°C', entity: 'number', min: 40, max: 60, step: 0.5 },
        { name: 'USERDATA.TUV_TC.ZAP', type: 'BOOL', entity: 'switch' },
        { name: 'USERDATA.ZONY.ZONY[1].FC_DOVOLENA', type: 'BOOL', entity: 'binary_sensor' },
        { name: 'AC_EON.L123_KW', type: 'REAL', unitOfMeasurement: 'kW', calculateEnergy: true },
    ];

    // Retained leftovers from a "previous run": a stale command and an energy total to restore
    const pre = mqtt.connect('mqtt://127.0.0.1:11883');
    await new Promise(r => pre.on('connect', r));
    await new Promise(r => pre.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '45', { retain: true, qos: 1 }, r));
    await new Promise(r => pre.publish('plc/foxtrot/AC_EON.L123_KW/energy/state', '100.000', { retain: true, qos: 1 }, r));
    pre.end();

    const bridge = spawn('node', [process.argv[2]], {
        env: { ...process.env, PLC_HOST: '127.0.0.1', PLC_PORT: '15010', MQTT_HOST: '127.0.0.1', MQTT_PORT: '11883',
            MQTT_USER: 'u', MQTT_PASSWORD: 'p', MQTT_TOPIC: 'plc/foxtrot', REFRESH_INTERVAL: '1', RESYNC_INTERVAL: '30',
            WRITE_ENABLED: writeEnabled, VARIABLES: JSON.stringify(variables) },
    });
    let bridgeOut = '';
    bridge.stdout.on('data', d => bridgeOut += d); bridge.stderr.on('data', d => bridgeOut += d);

    const msgs = {};
    const client = mqtt.connect('mqtt://127.0.0.1:11883');
    client.on('message', (t, p) => { msgs[t] = p.toString(); });
    client.subscribe('#');
    await wait(4500);

    const disc = t => msgs[t] ? JSON.parse(msgs[t]) : undefined;
    const setCount = () => plcLog.filter(l => l.startsWith('SET')).length;

    if (writeEnabled === 'false') {
        check('write disabled: number exposed as sensor', !!disc('homeassistant/sensor/USERDATA_TUV_TC_T_KOMFORT/config') && !msgs['homeassistant/number/USERDATA_TUV_TC_T_KOMFORT/config']);
        check('write disabled: switch exposed as binary_sensor', !!disc('homeassistant/binary_sensor/USERDATA_TUV_TC_ZAP/config'));
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '50');
        await wait(2000);
        check('write disabled: no SET sent', setCount() === 0, plcLog.filter(l => l.startsWith('SET')).join(';'));
    } else {
        // Availability
        check('bridge status online', msgs['plc/foxtrot/bridge/status'] === 'online');
        check('plc status online', msgs['plc/foxtrot/plc/status'] === 'online');
        const sensorDisc = disc('homeassistant/sensor/TEPLOTY_VENKU/config');
        check('discovery carries availability', sensorDisc?.availability?.length === 2 && sensorDisc.availability_mode === 'all', JSON.stringify(sensorDisc?.availability));

        // Push updates
        check('EN: sent for every variable', variables.every(v => plcLog.some(l => l.startsWith(`EN:${v.name}`))));
        check('REAL subscribed with delta', plcLog.includes('EN:TEPLOTY.VENKU 0.05'));
        check('retained command ignored on subscribe', !plcLog.includes('SET:USERDATA.TUV_TC.T_KOMFORT,45'));
        check('sensor unique_id unchanged', sensorDisc?.unique_id === 'plc_TEPLOTY_VENKU_sensor');
        check('sensor state 3 decimals', msgs['plc/foxtrot/TEPLOTY.VENKU/state'] === '2.103', msgs['plc/foxtrot/TEPLOTY.VENKU/state']);
        const getsBefore = plcLog.filter(l => l === 'GET:TEPLOTY.VENKU').length;
        changePlc('TEPLOTY.VENKU', '3.500000');
        await wait(300);
        check('DIFF push updates state', msgs['plc/foxtrot/TEPLOTY.VENKU/state'] === '3.500', msgs['plc/foxtrot/TEPLOTY.VENKU/state']);
        check('no per-variable polling between resyncs', plcLog.filter(l => l === 'GET:TEPLOTY.VENKU').length === getsBefore);
        check('heartbeat polls __PLC_RUN', plcLog.some(l => l === 'GET:__PLC_RUN'));

        // Discovery of writable entities
        const n = disc('homeassistant/number/USERDATA_TUV_TC_T_KOMFORT/config');
        check('number discovery', n?.command_topic === 'plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set' && n.min === 40 && n.max === 60 && n.step === 0.5);
        check('switch state ON', msgs['plc/foxtrot/USERDATA.TUV_TC.ZAP/state'] === 'ON');
        check('binary_sensor state OFF', msgs['plc/foxtrot/USERDATA.ZONY.ZONY[1].FC_DOVOLENA/state'] === 'OFF');

        // Debounced writes: only the last of rapid clicks reaches the PLC
        const before = setCount();
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '53.5');
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '54');
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '54.5');
        client.publish('plc/foxtrot/USERDATA.TUV_TC.ZAP/set', 'OFF');
        await wait(2200);
        const sets = plcLog.filter(l => l.startsWith('SET')).slice(before);
        check('debounce: one SET with last value', sets.filter(l => l.includes('T_KOMFORT')).join() === 'SET:USERDATA.TUV_TC.T_KOMFORT,54.5', sets.join(';'));
        check('number read back', msgs['plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/state'] === '54.5');
        check('switch SET 0 and read back OFF', sets.includes('SET:USERDATA.TUV_TC.ZAP,0') && msgs['plc/foxtrot/USERDATA.TUV_TC.ZAP/state'] === 'OFF');

        const before2 = setCount();
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', '99');
        client.publish('plc/foxtrot/USERDATA.TUV_TC.T_KOMFORT/set', 'abc');
        client.publish('plc/foxtrot/USERDATA.TUV_TC.ZAP/set', 'maybe');
        client.publish('plc/foxtrot/TEPLOTY.VENKU/set', '5');
        client.publish('plc/foxtrot/USERDATA.ZONY.ZONY[1].FC_DOVOLENA/set', 'ON');
        await wait(1500);
        check('invalid / read-only commands rejected', setCount() === before2, plcLog.filter(l => l.startsWith('SET')).slice(before2).join(';'));

        // Energy: restored from retained total, then integrated with the previous power (2 kW)
        const energy = Number.parseFloat(msgs['plc/foxtrot/AC_EON.L123_KW/energy/state']);
        check('energy restored from retained total', energy >= 100 && energy < 100.1, String(energy));
        changePlc('AC_EON.L123_KW', '4.000000');
        await wait(300);
        const energy2 = Number.parseFloat(msgs['plc/foxtrot/AC_EON.L123_KW/energy/state']);
        check('energy keeps increasing', energy2 > energy, `${energy} -> ${energy2}`);

        // Watchdog: a PLC that stops answering is detected and the connection is rebuilt
        const connectsBefore = (bridgeOut.match(/Connected to PLC/g) || []).length;
        silent = true;
        await wait(9500);
        check('silent PLC -> plc status offline', msgs['plc/foxtrot/plc/status'] === 'offline', msgs['plc/foxtrot/plc/status']);
        silent = false;
        await wait(6500);
        check('watchdog reconnects and status back online', msgs['plc/foxtrot/plc/status'] === 'online' && (bridgeOut.match(/Connected to PLC/g) || []).length > connectsBefore);

        // Last will: broker announces offline when the bridge dies
        bridge.kill('SIGKILL');
        await wait(1500);
        check('bridge last will -> offline', msgs['plc/foxtrot/bridge/status'] === 'offline', msgs['plc/foxtrot/bridge/status']);
    }

    bridge.kill(); client.end(true); plc.close(); broker.close(); aedes.close();
    sockets.forEach(s => s.destroy());
    if (results.includes(false)) { console.log('--- bridge output tail ---\n' + bridgeOut.split('\n').slice(-40).join('\n')); }
    console.log(results.includes(false) ? 'SOME TESTS FAILED' : 'ALL PASSED');
    process.exit(results.includes(false) ? 1 : 0);
}));
