/* Run with: node --test diagnostics/test-startup-diagnostics.cjs */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const esbuild = require('esbuild');

const sourcePath = path.resolve(__dirname, '../app/diagnostics/main.ts');
let bundledModule;

function readLogs(directory) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(readLogs(file));
        else if (entry.name.endsWith('.jsonl')) result.push(fs.readFileSync(file, 'utf8'));
    }
    return result.join('\n');
}

// A fresh VM gives each test its own process handlers and Electron singleton.
// Files use a real temporary directory; only intentional failures are mocked.
function fixture(t, options = {}) {
    bundledModule ||= esbuild.buildSync({
        entryPoints: [ sourcePath ], bundle: true, platform: 'node', format: 'cjs',
        write: false, external: [ 'electron' ], logLevel: 'silent'
    }).outputFiles[0].text;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-diagnostics-test-'));
    const openFiles = new Set();
    t.after(() => {
        for (const descriptor of openFiles) fs.closeSync(descriptor);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const timers = [];
    const calls = { paths: [], switches: [], crashes: [], stderr: [], stderrAttempts: 0, asyncStderr: 0 };
    const processMock = Object.assign(new EventEmitter(), {
        env: { ...options.env }, pid: process.pid, ppid: process.ppid,
        platform: process.platform, arch: process.arch, versions: process.versions,
        version: process.version, execPath: process.execPath, argv: [ '/test/video-konferans', '--no-sandbox' ],
        getuid: () => process.getuid?.(), cwd: () => root, uptime: () => 1,
        hrtime: options.failInitialization ? { bigint() { throw new Error('Initialization failed'); } } : process.hrtime,
        memoryUsage: process.memoryUsage,
        stderr: { write: value => { calls.asyncStderr++; calls.stderr.push(String(value)); } },
        kill: (pid, signal) => {
            assert.equal(signal, 0, 'diagnostics must not send process signals');
            if (pid === process.pid || options.livePids?.includes(pid)) return true;
            throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        }
    });
    const paths = {
        userData: path.join(root, 'profile'), logs: path.join(root, 'logs'),
        crashDumps: path.join(root, 'original-crashes'), temp: path.join(root, 'temp'),
        home: path.join(root, 'home'), exe: '/test/video-konferans'
    };
    fs.mkdirSync(paths.temp);
    const app = Object.assign(new EventEmitter(), {
        name: 'Video Konferans', isPackaged: true, isReady: () => false,
        getName: () => 'Video Konferans', getVersion: () => '0.0.8',
        getPath: name => paths[name],
        setPath: (name, value) => { calls.paths.push([ name, value ]); paths[name] = value; },
        commandLine: {
            hasSwitch: name => name === 'no-sandbox',
            getSwitchValue: name => name === 'disable-features' ? 'ExistingFeature' : '',
            appendSwitch: (...args) => calls.switches.push(args),
            removeSwitch: (...args) => calls.switches.push(args)
        },
        getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
        getGPUInfo: async () => ({ devices: [ { vendorId: 32902, deviceId: 1234 } ] }),
        getAppMetrics: () => [ { pid: process.pid, type: 'Browser' } ]
    });
    const electron = {
        app,
        crashReporter: { addExtraParameter() {}, start: value => {
            calls.crashes.push(value);
            if (options.crashReporterFails) throw new Error('Crashpad unavailable');
        } },
        screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ scaleFactor: 1 }) }
    };
    let failWrites = false;
    const fsMock = new Proxy(fs, { get(target, name) {
        const value = target[name];
        if (typeof value !== 'function') return value;
        return (...args) => {
            if (name === 'writeSync' && args[0] === 2) {
                calls.stderrAttempts++;
                if (options.closedStderr) throw Object.assign(new Error('Broken pipe'), { code: 'EPIPE' });
                calls.stderr.push(String(args[1]));
                return Buffer.byteLength(String(args[1]));
            }
            if ((name === 'writeSync' || name === 'closeSync') && typeof args[0] === 'number') {
                assert.ok(openFiles.has(args[0]), 'fixture must never write to or close an inherited descriptor');
            }
            const writing = /^(appendFile|writeFile|write|mkdir|open|rename|unlink|rm)/.test(String(name));
            const denied = options.denyProfile && typeof args[0] === 'string'
                && args[0].startsWith(paths.userData);
            if (writing && (failWrites || denied || options.denyAllWrites)) {
                throw Object.assign(new Error('Read-only test filesystem'), { code: 'EROFS' });
            }
            const result = value.apply(target, args);
            if (name === 'openSync') openFiles.add(result);
            if (name === 'closeSync') openFiles.delete(args[0]);
            return result;
        };
    } });
    options.seed?.({ root, paths, process: processMock });
    const module = { exports: {} };
    vm.runInNewContext(bundledModule, {
        module, exports: module.exports, process: processMock, Buffer, URL, Error,
        __dirname: path.dirname(sourcePath), __filename: sourcePath,
        console: { warn: value => calls.stderr.push(String(value)), error: value => calls.stderr.push(String(value)), log() {} },
        require: name => name === 'electron' ? electron
            : name === 'fs' || name === 'node:fs' ? fsMock
                : name === 'os' || name === 'node:os' ? { ...os, tmpdir: () => paths.temp, homedir: () => paths.home }
                    : name === 'path' || name === 'node:path' ? { ...path, join: (...parts) =>
                        parts[0] === '/tmp' && String(parts[1]).startsWith('video-konferans-diagnostics-')
                            ? path.join(paths.temp, ...parts.slice(1)) : path.join(...parts) }
                        : require(name),
        setTimeout: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }
    }, { filename: sourcePath });
    return {
        root, paths, calls, app, process: processMock, diagnostics: module.exports.diagnostics,
        logs: () => readLogs(root), failWrites: () => { failWrites = true; },
        async ready() { app.emit('ready'); await Promise.resolve(); },
        async flushTimers() {
            for (const timer of timers.splice(0)) timer.callback();
            await Promise.resolve();
        }
    };
}

test('enabled diagnostics creates private logs and local-only crash capture without changing launch flags', t => {
    const f = fixture(t);
    f.diagnostics.stage('test-startup');
    assert.match(f.logs(), /test-startup/);
    assert.equal(f.calls.crashes.length, 1);
    assert.equal(f.calls.crashes[0].uploadToServer, false);
    assert.ok(!f.calls.crashes[0].submitURL);
    assert.deepEqual(f.calls.switches, []);
    assert.ok(f.calls.paths.every(([ name ]) => name === 'crashDumps'));
    const run = fs.readdirSync(path.join(f.paths.userData, 'diagnostics')).find(name => name.startsWith('run-'));
    const directory = path.join(f.paths.userData, 'diagnostics', run);
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(directory, 'events.jsonl')).mode & 0o077, 0);
});

test('read-only profile falls back to writable temporary diagnostics', t => {
    const f = fixture(t, { denyProfile: true });
    f.diagnostics.record('fallback-proof');
    assert.match(f.logs(), /fallback-proof/);
    assert.ok(f.paths.crashDumps.startsWith(f.paths.temp));
});

test('explicit diagnostics directory is honored without moving the application profile', t => {
    const f = fixture(t, { seed({ root, process: mockedProcess }) {
        mockedProcess.env.VIDEO_KONFERANS_DIAGNOSTICS_DIR = path.join(root, 'configured-diagnostics');
    } });
    assert.ok(f.paths.crashDumps.startsWith(path.join(f.root, 'configured-diagnostics')));
    assert.ok(f.calls.paths.every(([ name ]) => name === 'crashDumps'));
    assert.match(f.logs(), /diagnostics-started/);
});

test('disabled diagnostics has no logging, crash reporter, or exception side effects', t => {
    const f = fixture(t, { env: { VIDEO_KONFERANS_DIAGNOSTICS: 'false' } });
    f.diagnostics.stage('disabled-proof');
    assert.equal(f.logs(), '');
    assert.equal(f.calls.crashes.length, 0);
    assert.deepEqual(f.process.eventNames(), []);
    assert.deepEqual(f.calls.paths, []);
});

test('unavailable storage and later disk failures do not throw into application code', t => {
    const unavailable = fixture(t, { denyAllWrites: true });
    assert.doesNotThrow(() => unavailable.diagnostics.stage('no-storage'));
    const f = fixture(t, { crashReporterFails: true });
    f.failWrites();
    assert.doesNotThrow(() => f.diagnostics.record('disk-full', { error: new Error('failure') }));
    assert.doesNotThrow(() => f.process.emit('exit', 11));
});

test('closed launcher stderr cannot turn announcements or initialization failures into a fatal error', t => {
    for (const options of [ {}, { denyAllWrites: true }, { failInitialization: true } ]) {
        const f = fixture(t, { ...options, closedStderr: true });
        assert.equal(f.calls.stderrAttempts, 1, 'announcement must use the synchronous stderr path');
        assert.equal(f.calls.asyncStderr, 0, 'asynchronous stderr writes can emit unhandled EPIPE errors');
        assert.doesNotThrow(() => f.diagnostics.stage('after-closed-stderr'));
        if (!options.denyAllWrites && !options.failInitialization) {
            assert.match(f.logs(), /after-closed-stderr/);
            assert.equal(f.calls.crashes.length, 1);
        }
    }
});

test('room URLs, query credentials, JWTs and error messages do not leak into JSON logs', t => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJzZW50aW5lbCJ9.superSecretSignature';
    const url = `https://user:secret-password@private.example/private-room?jwt=${jwt}&password=secret-query#token=secret-fragment`;
    const f = fixture(t, { env: { ROOM_URL: url, TITLE: 'sensitive-title' } });
    f.diagnostics.record('sensitive-data', { url, jwt, password: 'secret-field', error: new Error(`Loading ${url} failed`) });
    f.process.emit('uncaughtExceptionMonitor', new Error(`Loading ${url} failed; token=standalone-secret`), 'uncaughtException');
    const output = f.logs();
    for (const secret of [ jwt, 'secret-password', 'secret-query', 'secret-fragment', 'secret-field', 'sensitive-title', 'standalone-secret' ]) {
        assert.ok(!output.includes(secret), `log exposed ${secret}`);
    }
    assert.match(output, /sensitive-data/);
});

test('exception monitoring does not install handlers that change process failure semantics', t => {
    const f = fixture(t);
    assert.equal(f.process.listenerCount('uncaughtException'), 0);
    assert.equal(f.process.listenerCount('unhandledRejection'), 0);
    assert.equal(f.process.listenerCount('SIGSEGV'), 0);
    assert.equal(f.process.listenerCount('uncaughtExceptionMonitor'), 1);
    f.process.emit('uncaughtExceptionMonitor', new Error('test failure'), 'uncaughtException');
    f.process.emit('exit', 11);
    assert.match(f.logs(), /uncaughtException|uncaught-exception/);
    assert.match(f.logs(), /11/);
});

test('renderer and GPU crashes retain process category, reason and exit code', t => {
    const f = fixture(t);
    const contents = Object.assign(new EventEmitter(), {
        id: 5, getOSProcessId: () => 51515, isDestroyed: () => false,
        getURL: () => 'tubitak://video-konferans/meeting.html', getType: () => 'window'
    });
    const window = Object.assign(new EventEmitter(), {
        id: 2, webContents: contents, isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 })
    });
    f.app.emit('browser-window-created', {}, window);
    f.diagnostics.observeWindow(window, 'meeting');
    window.emit('show');
    f.app.emit('render-process-gone', {}, contents, { reason: 'crashed', exitCode: 11 });
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    f.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139, pid: 61616 });
    assert.match(f.logs(), /render-process-gone/);
    assert.match(f.logs(), /GPU/);
    assert.match(f.logs(), /crashed/);
    assert.match(f.logs(), /139/);
    assert.equal(window.listenerCount('show'), 1, 'observing the main window again must not duplicate listeners');
    const shown = f.logs().split('\n').filter(Boolean).map(JSON.parse).find(entry => entry.event === 'window-show');
    assert.equal(shown.data.role, 'meeting', 'an explicit role must update automatic window observation');
});

test('retention preserves live runs, recent runs and unrelated files while pruning old inactive runs', async t => {
    const livePid = 52525;
    const protectedRuns = [];
    const f = fixture(t, { livePids: [ livePid ], seed({ root, paths }) {
        const base = path.join(paths.userData, 'diagnostics');
        fs.mkdirSync(base, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(base, 'keep-user-file.txt'), 'not owned by diagnostics');
        const victim = path.join(root, 'external-directory');
        fs.mkdirSync(victim);
        fs.writeFileSync(path.join(victim, 'keep.txt'), 'not a diagnostic file');
        for (let i = 0; i < 30; i++) {
            const startedAt = Date.now() - (48 + i) * 3600000;
            const pid = i === 29 ? livePid : 60000 + i;
            const directory = path.join(base, `run-${startedAt}-${pid}-deadbeef`);
            fs.mkdirSync(directory, { mode: 0o700 });
            fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
                format: 'video-konferans-diagnostics', version: 1, pid, startedAt
            }), { mode: 0o600 });
            fs.writeFileSync(path.join(directory, 'events.jsonl'), '', { mode: 0o600 });
            if (i === 28) {
                fs.symlinkSync(victim, path.join(directory, 'crashes'), 'dir');
                protectedRuns.push(path.basename(directory));
            }
            if (i === 27) {
                fs.writeFileSync(path.join(directory, 'user-file.txt'), 'keep');
                protectedRuns.push(path.basename(directory));
            }
        }
        // Put some recent runs beyond the newest-20 cutoff to exercise the grace period.
        for (let i = 0; i < 22; i++) {
            const startedAt = Date.now() - 10000 - i;
            const pid = 61000 + i;
            const name = `run-${startedAt}-${pid}-deadbeef`;
            const directory = path.join(base, name);
            fs.mkdirSync(directory, { mode: 0o700 });
            fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
                format: 'video-konferans-diagnostics', version: 1, pid, startedAt
            }), { mode: 0o600 });
            protectedRuns.push(name);
        }
    } });
    await f.ready();
    await f.flushTimers();
    const names = fs.readdirSync(path.join(f.paths.userData, 'diagnostics'));
    assert.ok(names.includes('keep-user-file.txt'));
    assert.ok(names.some(name => name.includes(`-${livePid}-`)));
    assert.ok(names.some(name => name.includes(`-${process.pid}-`)));
    assert.ok(protectedRuns.every(name => names.includes(name)), 'recent runs, symlinks and unfamiliar content must survive');
    assert.equal(fs.readFileSync(path.join(f.root, 'external-directory', 'keep.txt'), 'utf8'), 'not a diagnostic file');
    assert.ok(names.filter(name => name.startsWith('run-')).length < 53, 'inactive old runs were not pruned');
});

test('repeated events stop at the log limit and keep every written line valid JSON', t => {
    const f = fixture(t);
    for (let i = 0; i < 700; i++) {
        f.diagnostics.record('repeated-event', { text: 'x'.repeat(2048), i });
    }
    const output = f.logs();
    const entries = output.split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(Buffer.byteLength(output) <= 1024 * 1024);
    assert.equal(entries.filter(entry => entry.event === 'diagnostic-log-limit').length, 1);
    f.diagnostics.record('after-limit');
    assert.equal(f.logs(), output);
});
