import * as crypto from 'crypto';
import { app, crashReporter } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BYTES = 1024 * 1024;
const KEEP_RUNS = 20;
const RETENTION_GRACE_MS = 60 * 1000;
const RUN_NAME = /^run-(\d{13})-(\d+)-[a-f0-9]{8}$/;
const FORMAT = 'video-konferans-diagnostics';
const SECRET_KEY = /password|passwd|token|jwt|secret|authorization|room.?url|client.?pass/i;

interface IDiagnostics {
    observeWindow: (win: Electron.BrowserWindow, role?: string) => void;
    record: (event: string, data?: Record<string, unknown>) => void;
    stage: (name: string) => void;
}

/** Passive main-process evidence; every operation is best-effort. */
function createDiagnostics(): IDiagnostics {
    const disabled: IDiagnostics = {
        observeWindow: () => undefined,
        record: () => undefined,
        stage: () => undefined
    };

    if (process.env.VIDEO_KONFERANS_DIAGNOSTICS === 'false') {
        return disabled;
    }

    const uid = process.getuid?.();
    const startedAt = Date.now();
    const monotonicStart = process.hrtime.bigint();
    const secretValues = Object.entries(process.env)
        .filter(([ key, value ]) => Boolean(value) && SECRET_KEY.test(key))
        .map(([ , value ]) => value as string)
        .sort((a, b) => b.length - a.length);
    let fd: number | undefined;
    let bytes = 0;
    let sequence = 0;
    let currentStage = 'diagnostics-initializing';
    let crashReporterStarted = false;
    let announced = false;
    const observed = new WeakSet<Electron.BrowserWindow>();
    const roles = new WeakMap<Electron.BrowserWindow, string>();

    const sanitizeText = (input: string): string => {
        if (input.length > 8192) {
            return '[oversized text omitted]';
        }
        let result = input;

        for (const value of secretValues) {
            result = result.split(value).join('[redacted]');
        }

        return result
            .replace(/\b(?:https?|wss?|tubitak):\/\/[^\s<>"']+/gi, '[redacted-url]')
            .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
            .replace(/((?:password|passwd|token|jwt|secret|authorization|room.?url)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
            .slice(0, 2048);
    };
    const sanitize = (value: unknown, depth = 0, budget = { text: 8192, nodes: 128 }): unknown => {
        if (--budget.nodes < 0) {
            return '[entry limit]';
        }
        if (typeof value === 'string') {
            const result = sanitizeText(value);

            if (result.length > budget.text) {
                return '[text limit]';
            }
            budget.text -= result.length;

            return result;
        }
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : null;
        }
        if (value === null || typeof value === 'boolean') {
            return value;
        }
        if (depth >= 3 || typeof value !== 'object') {
            return undefined;
        }
        if (Array.isArray(value)) {
            return value.slice(0, 24).map(item => sanitize(item, depth + 1, budget));
        }

        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .slice(0, 32)
            .map(([ key, item ]) => [
                sanitizeText(key).slice(0, 64),
                SECRET_KEY.test(key) || /^(?:argv|env|url|content)$/i.test(key)
                    ? '[redacted]' : sanitize(item, depth + 1, budget)
            ]));
    };
    const announce = (message: string) => {
        if (!announced) {
            announced = true;
            try {
                fs.writeSync(2, `[startup-diagnostics] ${sanitizeText(message)}\n`);
            } catch {
                // A closed stderr pipe must not affect startup.
            }
        }
    };
    const record = (event: string, data?: Record<string, unknown>): void => {
        try {
            if (fd === undefined || bytes >= MAX_BYTES) {
                return;
            }

            const entry = {
                time: new Date().toISOString(),
                elapsedMs: Number((process.hrtime.bigint() - monotonicStart) / 1000000n),
                seq: ++sequence,
                pid: process.pid,
                stage: sanitizeText(currentStage),
                event: sanitizeText(event),
                data: sanitize(data)
            };
            let line = `${JSON.stringify(entry)}\n`;

            if (bytes + Buffer.byteLength(line) > MAX_BYTES - 512) {
                line = `${JSON.stringify({ time: entry.time, elapsedMs: entry.elapsedMs,
                    seq: entry.seq, pid: process.pid, event: 'diagnostic-log-limit' })}\n`;
                fs.writeSync(fd, line);
                bytes = MAX_BYTES;

                return;
            }
            bytes += fs.writeSync(fd, line);
        } catch {
            // Logging must never turn an otherwise healthy startup into a crash.
        }
    };
    const errorData = (error: unknown): Record<string, unknown> => {
        try {
            return error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : { type: typeof error };
        } catch {
            return { type: 'unreadable-error' };
        }
    };
    const ownedDirectory = (directory: string, privateMode = false): boolean => {
        const stat = fs.lstatSync(directory);

        return stat.isDirectory() && !stat.isSymbolicLink()
            && (uid === undefined || stat.uid === uid)
            && (!privateMode || process.platform === 'win32' || (stat.mode & 0o077) === 0);
    };
    const prepareBase = (directory: string): void => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!ownedDirectory(directory, true)) {
            throw new Error('Unsafe diagnostics directory');
        }
    };
    const isLive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);

            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    };
    // Reject symlinks and unfamiliar trees before removing old owned runs.
    const safeTree = (directory: string, budget: { remaining: number; }): boolean => {
        for (const name of fs.readdirSync(directory)) {
            if (--budget.remaining < 0) {
                return false;
            }
            const child = path.join(directory, name);
            const stat = fs.lstatSync(child);

            if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
                return false;
            }
            if (stat.isDirectory()) {
                if (!safeTree(child, budget)) {
                    return false;
                }
            } else if (!stat.isFile()) {
                return false;
            }
        }

        return true;
    };
    const prune = (base: string) => {
        try {
            if (!ownedDirectory(base, true)) {
                return;
            }
            const names = fs.readdirSync(base).filter(name => RUN_NAME.test(name))
                .sort().reverse();

            for (const name of names.slice(KEEP_RUNS, KEEP_RUNS + 50)) {
                try {
                    const match = RUN_NAME.exec(name)!;
                    const timestamp = Number(match[1]);
                    const pid = Number(match[2]);
                    const directory = path.join(base, name);

                    if (Date.now() - timestamp < RETENTION_GRACE_MS || isLive(pid)
                            || !ownedDirectory(directory, true)) {
                        continue;
                    }
                    const entries = fs.readdirSync(directory);

                    if (entries.some(entry => ![ 'manifest.json', 'events.jsonl', 'crashes' ].includes(entry))) {
                        continue;
                    }
                    const markerPath = path.join(directory, 'manifest.json');
                    const stat = fs.lstatSync(markerPath);

                    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
                        continue;
                    }
                    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

                    if (marker.format !== FORMAT || marker.version !== 1 || marker.pid !== pid
                            || marker.startedAt !== timestamp || !safeTree(directory, { remaining: 256 })) {
                        continue;
                    }
                    fs.rmSync(directory, { recursive: true });
                } catch {
                    // A live writer or an unfamiliar entry is always left alone.
                }
            }
        } catch {
            // Retention failure cannot block the application.
        }
    };

    let base: string;
    let runDirectory: string;
    let runId: string;

    try {
        runId = `run-${startedAt}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const createRun = (directory: string): string => {
            prepareBase(directory);
            const run = path.join(directory, runId);

            fs.mkdirSync(run, { mode: 0o700 });
            fs.mkdirSync(path.join(run, 'crashes'), { mode: 0o700 });
            fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ format: FORMAT,
                version: 1, pid: process.pid, startedAt }), { flag: 'wx', mode: 0o600 });
            fd = fs.openSync(path.join(run, 'events.jsonl'), 'ax', 0o600);

            return run;
        };

        try {
            base = process.env.VIDEO_KONFERANS_DIAGNOSTICS_DIR
                || path.join(process.env.JITSI_MEET_USER_DATA || app.getPath('userData'), 'diagnostics');
            runDirectory = createRun(base);
        } catch {
            base = path.join(process.platform === 'linux' ? '/tmp' : os.tmpdir(),
                `video-konferans-diagnostics-${uid ?? 'unknown'}`);
            runDirectory = createRun(base);
        }
        announce(runDirectory);
        record('diagnostics-started', { runId });
        // Also bound crash-loop storage when startup never reaches app.ready.
        // Keep the newest 20 plus live processes and the last minute, while
        // examining at most 50 older candidates per launch for Crashpad flushes.
        prune(base);
    } catch (error) {
        announce(`unavailable (${(error as NodeJS.ErrnoException).code || 'initialization-error'})`);

        return disabled;
    }

    const stage = (name: string): void => {
        try {
            currentStage = sanitizeText(name).slice(0, 128);
            record('stage', { name: currentStage });
            if (crashReporterStarted) {
                crashReporter.addExtraParameter('stage', currentStage);
            }
        } catch {
            // Crash annotations are optional evidence, never a startup dependency.
        }
    };
    const observeWindow = (win: Electron.BrowserWindow, role?: string): void => {
        try {
            if (role) {
                roles.set(win, sanitizeText(role).slice(0, 64));
            }
            if (observed.has(win)) {
                return;
            }
            observed.add(win);
            const windowId = win.id;
            const wc = win.webContents;
            const webContentsId = wc.id;
            const windowRecord = (event: string, data?: Record<string, unknown>) => record(event,
                { windowId, webContentsId, role: roles.get(win) || 'window', ...data });

            windowRecord('window-created');
            win.on('ready-to-show', () => windowRecord('window-ready-to-show'));
            win.on('show', () => windowRecord('window-show'));
            win.on('closed', () => windowRecord('window-closed'));
            win.on('unresponsive', () => windowRecord('window-unresponsive'));
            wc.on('dom-ready', () => windowRecord('renderer-dom-ready'));
            wc.on('did-finish-load', () => windowRecord('renderer-did-finish-load'));
            wc.on('did-fail-load', (_, errorCode, errorDescription, _url, isMainFrame) => {
                windowRecord('renderer-did-fail-load', { errorCode, errorDescription, isMainFrame });
            });
            wc.on('preload-error', (_, _preloadPath, error) => {
                windowRecord('renderer-preload-error', errorData(error));
            });
        } catch {
            // Windows may already be destroyed when another handler reports them.
        }
    };

    try {
        process.on('uncaughtExceptionMonitor', (error, origin) => {
            record('uncaught-exception', { origin, ...errorData(error) });
        });
        process.on('warning', warning => record('process-warning', errorData(warning)));
        process.on('exit', exitCode => record('process-exit', { exitCode }));
        app.on('before-quit', () => record('app-before-quit'));
        app.on('will-quit', () => record('app-will-quit'));
        app.on('quit', (_, exitCode) => record('app-quit', { exitCode }));
        app.on('child-process-gone', (_, details) => {
            record('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
        });
        app.on('render-process-gone', (_, wc, details) => {
            record('render-process-gone', { webContentsId: wc.id, type: 'renderer',
                reason: details.reason, exitCode: details.exitCode });
        });
        app.on('browser-window-created', (_, win) => observeWindow(win));
        const ready = () => {
            record('app-ready');
            setTimeout(() => {
                try {
                    record('gpu-feature-status', { features: app.getGPUFeatureStatus() });
                } catch {
                    // Some environments cannot provide GPU status.
                }
            }, 3000).unref();
        };

        if (app.isReady()) {
            ready();
        } else {
            app.once('ready', ready);
        }
        const rawZoom = process.env.ZOOM_LEVEL;
        const parsedZoom = rawZoom ? Number(rawZoom) : 1;

        record('startup-environment', {
            ppid: process.ppid, appVersion: app.getVersion(),
            platform: process.platform, arch: process.arch, kernel: os.release(),
            versions: { electron: process.versions.electron, chrome: process.versions.chrome,
                node: process.versions.node, v8: process.versions.v8 },
            displayPresent: Boolean(process.env.DISPLAY), waylandDisplayPresent: Boolean(process.env.WAYLAND_DISPLAY),
            runtimeDirectoryPresent: Boolean(process.env.XDG_RUNTIME_DIR),
            roomConfigured: Boolean(process.env.ROOM_URL)
                || process.argv.some(argument => /^(?:--room-url=|https?:\/\/|jitsi-meet:\/\/)/.test(argument)),
            titleConfigured: Boolean(process.env.TITLE),
            sessionType: [ 'wayland', 'x11', 'tty' ].includes(process.env.XDG_SESSION_TYPE || '')
                ? process.env.XDG_SESSION_TYPE : 'unknown',
            noSandbox: app.commandLine.hasSwitch('no-sandbox'),
            ignoreCertificateErrors: process.env.IGNORE_CERTIFICATE_ERRORS === 'true'
                || app.commandLine.hasSwitch('ignore-certificate-errors'),
            zoom: Number.isFinite(parsedZoom) && parsedZoom > 0 && parsedZoom <= 1000 ? parsedZoom : 'invalid'
        });
    } catch (error) {
        record('diagnostics-observer-error', errorData(error));
    }
    try {
        app.setPath('crashDumps', path.join(runDirectory, 'crashes'));
        crashReporter.start({ productName: 'Video Konferans', uploadToServer: false,
            ignoreSystemCrashHandler: false, globalExtra: { diagnosticRunId: runId },
            extra: { stage: currentStage } });
        crashReporterStarted = true;
        record('crash-reporter-started', { uploadToServer: false });
    } catch (error) {
        record('crash-reporter-error', errorData(error));
    }
    stage('diagnostics-ready');

    return { record, stage, observeWindow };
}

/** Imported before native SDK dependencies so their last startup stage survives. */
export const diagnostics = (() => {
    try {
        return createDiagnostics();
    } catch {
        try {
            fs.writeSync(2, '[startup-diagnostics] unavailable (initialization-error)\n');
        } catch {
            // Even the fallback must remain non-fatal.
        }

        return { record: () => undefined, stage: () => undefined, observeWindow: () => undefined } as IDiagnostics;
    }
})();
