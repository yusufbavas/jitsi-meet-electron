import {
    getPopupTarget,
    initPopupsConfigurationMain,
    setupPictureInPictureMain,
    setupPowerMonitorMain,
    setupRemoteControlMain,
    setupScreenSharingMain
} from '@jitsi/electron-sdk/main';
import {
    BrowserWindow,
    Menu,
    app,
    dialog,
    ipcMain,
    protocol
} from 'electron';
import contextMenu from 'electron-context-menu';
import debug from 'electron-debug';
import isDev from 'electron-is-dev';
import log from 'electron-log';
import electronReload from 'electron-reload';
import { autoUpdater } from 'electron-updater';
import windowStateKeeper from 'electron-window-state';
import * as path from 'path';
import * as URL from 'url';
import * as fs from 'fs';
import * as crypto from 'crypto';

import config from './app/features/config';
import { openExternalLink } from './app/features/utils/openExternalLink';
import { t } from './app/i18n/main';
import pkgJson from './package.json';

// This file is bundled to ./build/main.js, so under esbuild __dirname is the
// build/ directory and its parent is the application root holding build/ and
// resources/ (in both development and the packaged app). Do not use __dirname
// directly for app paths: the previous webpack build neutralised __dirname via
// `node: { __dirname: true }`, so this indirection replaces that behaviour.
const rootDir = path.resolve(__dirname, '..');

if (process.env.JITSI_MEET_USER_DATA) {
    app.setPath('userData', process.env.JITSI_MEET_USER_DATA);
}

/**
 * Whether the inspector may be opened at all. Without DEV=true in the
 * environment there is no way in: the right click menu keeps its "inspect
 * element" entry to itself, the Ctrl+Shift+I / F12 shortcuts are never
 * registered, and `devTools: false` on each window turns the inspector off in
 * Chromium itself, so nothing inside the page can open one either.
 */
const devToolsEnabled = process.env.DEV === 'true';

/**
 * The scheme and host the meeting window is served from, which together make up
 * the origin Chromium names in the bar above a picture-in-picture window. Loaded
 * from file:// it called the meeting "File on your device"; this gives it a name
 * of its own instead. Hosts carry no spaces and no capitals, so what shows up is
 * {@code tubitak://video-konferans}.
 *
 * The launcher window is left on file://, as nothing of it is ever named on
 * screen.
 */
const MEETING_SCHEME = 'tubitak';
const MEETING_HOST = 'video-konferans';

/**
 * Content types for what the meeting window loads over that scheme. Anything
 * outside this list is served without one and left for Chromium to sniff.
 */
const MEETING_CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

// Has to run before the app is ready, and marks the scheme as a normal secure
// origin so that the window keeps the storage, workers and media permissions it
// had on file://.
protocol.registerSchemesAsPrivileged([ {
    scheme: MEETING_SCHEME,
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
    }
} ]);

/**
 * Serves the built meeting window over {@code MEETING_SCHEME}.
 *
 * @param {string} basePath - The directory the application was loaded from.
 * @returns {void}
 */
function registerMeetingProtocol(basePath: string): void {
    if (protocol.isProtocolHandled(MEETING_SCHEME)) {
        return;
    }

    const buildPath = path.resolve(basePath, './build');

    protocol.handle(MEETING_SCHEME, async request => {
        const { pathname } = new URL.URL(request.url);
        const requested = path.resolve(buildPath, `.${decodeURIComponent(pathname)}`);

        // Belt and braces. A standard scheme has its '..' segments resolved away
        // against the host before the request ever arrives, so a path cannot walk
        // out of the build directory on its own; this still catches what that
        // leaves through, such as an encoded backslash on Windows.
        if (requested !== buildPath && !requested.startsWith(buildPath + path.sep)) {
            console.warn(`Rejected ${MEETING_SCHEME} request outside the build directory: ${request.url}`);

            return new Response(null, { status: 403 });
        }

        try {
            const body = await fs.promises.readFile(requested);
            const contentType = MEETING_CONTENT_TYPES[path.extname(requested).toLowerCase()];

            return new Response(body, contentType ? { headers: { 'content-type': contentType } } : undefined);
        } catch (error) {
            console.warn(`Could not serve ${request.url}`, error);

            return new Response(null, { status: 404 });
        }
    });
}

const showDevTools = devToolsEnabled
    && (Boolean(process.env.SHOW_DEV_TOOLS) || (process.argv.indexOf('--show-dev-tools') > -1));

/**
 * Resolves the zoom factor from process.env.ZOOM_LEVEL.
 * Supports decimal factors (e.g. 1.25, 1.5) or percentages (e.g. 125, 150).
 * Defaults to 1.0.
 */
function getZoomFactor(): number {
    const raw = process.env.ZOOM_LEVEL;

    if (!raw) {
        return 1.0;
    }

    let parsed = parseFloat(raw);

    if (isNaN(parsed) || parsed <= 0) {
        return 1.0;
    }

    if (parsed > 10) {
        parsed = parsed / 100;
    }

    return parsed;
}

// Fix screen-sharing thumbnails being missing sometimes.
// https://github.com/electron/electron/issues/44504
const disabledFeatures = [
    'ThumbnailCapturerMac:capture_mode/sc_screenshot_manager',
    'ScreenCaptureKitPickerScreen',
    'ScreenCaptureKitStreamPickerSonoma'
];

app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));

// Enable Opus RED field trial.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Red-For-Opus/Enabled/');

/**
 * The language the application runs in, which is Turkish whatever the machine it
 * is installed on reports. It settles app.getLocale() for the native dialogs,
 * navigator.language for the app's own strings, and the language the meeting
 * opens in — Jitsi Meet reads the browser's language as its default.
 *
 * It stays a default: a language chosen in the meeting's settings is remembered
 * and takes precedence over this on the next launch. Nothing is forced onto the
 * meeting through lang or defaultLanguage, which would overrule that choice; see
 * the conference component.
 */
app.commandLine.appendSwitch('lang', 'tr');

// Wayland: Enable optional PipeWire support.
if (!app.commandLine.hasSwitch('enable-features')) {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

if (process.env.IGNORE_CERTIFICATE_ERRORS === 'true' || process.argv.includes('--ignore-certificate-errors')) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
}

autoUpdater.logger = log;
log.transports.file.level = 'info';

// Enable context menu so things like copy and paste work in input fields.
contextMenu({
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    showCopyImage: false,
    showCopyImageAddress: false,
    showSaveImage: false,
    showSaveImageAs: false,
    showInspectElement: devToolsEnabled,
    showServices: false
});

// The shortcuts this registers (Ctrl+Shift+I, F12, Ctrl+Shift+C, and the
// Ctrl+R / F5 reloads it comes with) exist only for development builds.
debug({
    isEnabled: devToolsEnabled,
    showDevTools
});

/**
 * When in development mode:
 * - Enable automatic reloads
 */
if (isDev) {
    electronReload(path.join(rootDir, 'build'));
}

/**
 * The window object that will load the iframe with Jitsi Meet.
 * IMPORTANT: Must be defined as global in order to not be garbage collected
 * acidentally.
 */
let mainWindow: BrowserWindow | null = null;

/**
 * Window 2: Meeting window — created on demand, full size.
 * IMPORTANT: Must be defined as global to avoid garbage collection.
 */
let meetingWindow: BrowserWindow | null = null;


/**
 * Add protocol data
 */
const appProtocolSurplus = `${config.appProtocolPrefix}://`;
let rendererReady = false;
let protocolDataForFrontApp: string | null = null;


/**
 * Sets the application menu. It is hidden on all platforms except macOS because
 * otherwise copy and paste functionality is not available.
 */
function setApplicationMenu() {
    if (process.platform === 'darwin') {
        const template: Electron.MenuItemConstructorOptions[] = [ {
            label: app.name,
            submenu: [
                {
                    role: 'services',
                    submenu: []
                },
                { type: 'separator' },
                { role: 'hide' },
                // NOTE: kept as the original (lowercase) role string to preserve
                // behaviour; the typed role union only knows 'hideOthers'.
                { role: 'hideothers' } as unknown as Electron.MenuItemConstructorOptions,
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }, {
            label: 'Edit',
            submenu: [
                {
                    label: 'Undo',
                    accelerator: 'CmdOrCtrl+Z',
                    selector: 'undo:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Redo',
                    accelerator: 'Shift+CmdOrCtrl+Z',
                    selector: 'redo:'
                } as Electron.MenuItemConstructorOptions,
                {
                    type: 'separator'
                },
                {
                    label: 'Cut',
                    accelerator: 'CmdOrCtrl+X',
                    selector: 'cut:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Copy',
                    accelerator: 'CmdOrCtrl+C',
                    selector: 'copy:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Paste',
                    accelerator: 'CmdOrCtrl+V',
                    selector: 'paste:'
                } as Electron.MenuItemConstructorOptions,
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    selector: 'selectAll:'
                } as Electron.MenuItemConstructorOptions
            ]
        }, {
            label: '&Window',
            role: 'window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' }
            ]
        } ];

        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } else {
        Menu.setApplicationMenu(null);
    }
}

/**
 * Opens new window with index.html(Jitsi Meet is loaded in iframe there).
 */
function createJitsiMeetWindow() {
    // Application menu.
    setApplicationMenu();

    // Check for Updates.
    if (!process.mas) {
        autoUpdater.checkForUpdatesAndNotify();
    }

    // Load the previous window state with fallback to defaults.
    const windowState = windowStateKeeper({
        defaultHeight: 600,
        fullScreen: false
    });

    // Path to root directory.
    const basePath = isDev ? rootDir : app.getAppPath();

    // URL for index.html which will be our entry point.
    const indexURL = URL.format({
        pathname: path.resolve(basePath, './build/index.html'),
        protocol: 'file:',
        slashes: true
    });

    const zoomFactor = getZoomFactor();
    const defaultWidth = Math.round(480 * zoomFactor);
    const defaultHeight = Math.round(600 * zoomFactor);

    // Options used when creating the main Jitsi Meet window.
    // Use a preload script in order to provide node specific functionality
    // to a isolated BrowserWindow in accordance with electron security
    // guideline.
    const options: Electron.BrowserWindowConstructorOptions = {
        x: windowState.x,
        y: windowState.y,
        width: defaultWidth,
        height: windowState.height ? Math.max(windowState.height, defaultHeight) : defaultHeight,
        icon: path.resolve(basePath, './resources/icon.png'),
        minWidth: defaultWidth,
        minHeight: defaultHeight,
        show: false,
        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: true,
            nodeIntegration: false,
            devTools: devToolsEnabled,
            preload: path.resolve(basePath, './build/preload.js'),
            sandbox: true,
            zoomFactor
        }
    };

    mainWindow = new BrowserWindow(options);
    windowState.manage(mainWindow);
    mainWindow.loadURL(indexURL);

    if (zoomFactor !== 1.0) {
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow?.webContents.setZoomFactor(zoomFactor);
        });
    }

    if (isDev) {
        mainWindow.webContents.session.clearCache();
    }

    // Block access to file:// URLs.
    const fileFilter = {
        urls: [ 'file://*' ]
    };

    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(fileFilter, (details, callback) => {
        const requestedPath = path.resolve(URL.fileURLToPath(details.url));
        const appBasePath = path.resolve(basePath);

        if (!requestedPath.startsWith(appBasePath)) {
            callback({ cancel: true });
            console.warn(`Rejected file URL: ${details.url}`);

            return;
        }

        callback({ cancel: false });
    });

    // Filter out x-frame-options and frame-ancestors CSP to allow loading jitsi via the iframe API
    // Resolves https://github.com/jitsi/jitsi-meet-electron/issues/285
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = details.responseHeaders ?? {};

        delete responseHeaders['x-frame-options'];

        if (responseHeaders['content-security-policy']) {
            const cspFiltered = responseHeaders['content-security-policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            responseHeaders['content-security-policy'] = [ cspFiltered ];
        }

        if (responseHeaders['Content-Security-Policy']) {
            const cspFiltered = responseHeaders['Content-Security-Policy'][0]
                .split(';')
                .filter(x => x.indexOf('frame-ancestors') === -1)
                .join(';');

            responseHeaders['Content-Security-Policy'] = [ cspFiltered ];
        }

        callback({
            responseHeaders
        });
    });

    // Block redirects.
    const allowedRedirects = [
        'http:',
        'https:',
        'ws:',
        'wss:'
    ];

    mainWindow.webContents.addListener('will-redirect', (ev, url) => {
        const requestedUrl = new URL.URL(url);

        if (!allowedRedirects.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // Block opening any external applications.
    mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback, details) => {
        if (permission === 'openExternal') {
            console.warn(`Disallowing opening ${(details as { externalURL?: string; }).externalURL}`);
            callback(false);

            return;
        }

        callback(true);
    });

    // NOTE: Popups configuration and SDK handlers are set up on the
    // meetingWindow (not the launcher) because the conference iframe
    // only exists there. See the 'open-meeting-window' handler below.

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.once('ready-to-show', () => {
        const initialUrl = getProtocolUrl(process.argv);

        if (!initialUrl) {
            mainWindow?.show();
        }
    });

    /**
     * When someone tries to enter something like jitsi-meet://test
     *  while app is closed
     * it will trigger this event below
     */
    handleProtocolCall(getProtocolUrl(process.argv));
}

function getProtocolUrl(argv: string[]): string | undefined {
    console.log('process.env.ROOM_URL', process.env.ROOM_URL);
    if (process.env.ROOM_URL) {
        return process.env.ROOM_URL;
    }

    console.log('argv', argv);
    const roomUrlArg = argv.find(arg => arg.startsWith('--room-url='));

    if (roomUrlArg) {
        return roomUrlArg.substring('--room-url='.length);
    }

    return [ ...argv ].reverse().find(arg =>
        arg.startsWith(appProtocolSurplus)
        || arg.startsWith('http://')
        || arg.startsWith('https://')
    );
}

/**
 * Handler for application protocol links to initiate a conference.
 *
 * @param {string} fullProtocolCall - The protocol call (e.g. jitsi-meet://test).
 * @returns {void}
 */
function handleProtocolCall(fullProtocolCall?: string) {
    // don't touch when something is bad
    if (
        !fullProtocolCall
        || fullProtocolCall.trim() === ''
    ) {
        return;
    }

    let inputURL = fullProtocolCall;

    if (fullProtocolCall.startsWith(appProtocolSurplus)) {
        inputURL = fullProtocolCall.replace(appProtocolSurplus, '');
    } else if (!fullProtocolCall.startsWith('http://') && !fullProtocolCall.startsWith('https://')) {
        return;
    }

    if (meetingWindow) {
        meetingWindow.webContents.send('protocol-data-msg', inputURL);

        return;
    }

    if (app.isReady() && mainWindow === null) {
        createJitsiMeetWindow();
    }

    protocolDataForFrontApp = inputURL;

    if (rendererReady && mainWindow) {
        mainWindow
            .webContents
            .send('protocol-data-msg', inputURL);
    }
}

/**
 * Electron can return no userData path when its default directory cannot be
 * created. ProcessSingleton then attempts to write SingletonLock in the current
 * directory. Select a writable profile before requesting that lock on Linux.
 *
 * @returns {void}
 */
function prepareSingleInstanceProfile(): void {
    if (process.platform !== 'linux') {
        return;
    }

    const checkWritable = (directory: string) => {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

        // SingletonLock is a symlink. Probe the same operation without touching
        // an existing lock or relying on mode bits on a read-only mount.
        const probe = path.join(directory, `.singleton-probe-${crypto.randomUUID()}`);

        fs.symlinkSync('probe', probe);
        fs.unlinkSync(probe);
    };

    try {
        checkWritable(app.getPath('userData'));

        return;
    } catch {
        // A missing default profile on a read-only filesystem also lands here.
    }

    const uid = process.getuid?.();
    const directory = path.join('/tmp', `jitsi-meet-electron-${uid}`);

    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    const stat = fs.lstatSync(directory);

    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        throw new Error(`Cannot use an unsafe temporary profile: ${directory}`);
    }

    checkWritable(directory);
    app.setPath('userData', directory);
    app.setPath('sessionData', directory);
    console.warn(`Using temporary profile ${directory}; its data lasts until /tmp is cleared.`);
}

/**
 * Force Single Instance Application.
 * Handle this on darwin via LSMultipleInstancesProhibited in Info.plist as below does not work on MAS
 */
prepareSingleInstanceProfile();

const gotInstanceLock = process.platform === 'darwin' ? true : app.requestSingleInstanceLock();

if (!gotInstanceLock) {
    app.quit();
    process.exit(0);
}

/**
 * Run the application.
 */

app.on('activate', () => {
    if (mainWindow === null) {
        createJitsiMeetWindow();
    }
});

app.on('certificate-error',
    // eslint-disable-next-line max-params
    (event, webContents, url, error, certificate, callback) => {
        if (isDev || process.env.IGNORE_CERTIFICATE_ERRORS === 'true' || process.argv.includes('--ignore-certificate-errors')) {
            event.preventDefault();
            callback(true);
            return;
        }

        if (process.env.MTLS_CA_CERT) {
            try {
                const caCert = new crypto.X509Certificate(fs.readFileSync(process.env.MTLS_CA_CERT));
                let serverCert;
                // 'certificate.data' might be a PEM string or a DER buffer depending on the Electron version
                if (typeof certificate.data === 'string' && !certificate.data.includes('-----BEGIN CERTIFICATE-----')) {
                    // Fallback if it's actually DER data as a string (legacy)
                    serverCert = new crypto.X509Certificate(Buffer.from(certificate.data, 'binary'));
                } else {
                    serverCert = new crypto.X509Certificate(certificate.data);
                }

                if (serverCert.verify(caCert.publicKey)) {
                    event.preventDefault();
                    callback(true);
                    return;
                }
            } catch (e) {
                console.error('Failed to verify custom CA:', e);
            }
        }

        callback(false);
    }
);

app.on('select-client-certificate', (event, webContents, url, list, callback) => {
    if (process.env.MTLS_CLIENT_CERT && list.length > 0) {
        event.preventDefault();
        callback(list[0]);
    }
});

/**
 * The page behind the small always-on-top window @jitsi/electron-sdk puts on
 * screen for as long as a screen share runs.
 */
const SCREEN_SHARE_TRACKER_PAGE = 'screenSharingTracker.html';

app.on('browser-window-created', (_, win) => {
    const zoomFactor = getZoomFactor();

    if (zoomFactor !== 1.0) {
        win.webContents.on('did-finish-load', () => {
            win.webContents.setZoomFactor(zoomFactor);
        });
    }

    // Closes the SDK's screen sharing tracker before it is ever seen. The SDK
    // offers no way to turn it off, so the window is caught as it starts loading
    // its page — it is built hidden and only shown once that page is ready, which
    // leaves room to close it first. Sharing is started and stopped from the
    // meeting toolbar, so nothing is lost with it gone, and the SDK needs no
    // further undoing: it drops its own reference on 'closed', and the branches
    // that would later close or minimize the tracker both check that reference.
    win.webContents.on('did-start-navigation', details => {
        if (details.url?.includes(SCREEN_SHARE_TRACKER_PAGE) && !win.isDestroyed()) {
            win.destroy();
        }
    });
});

app.on('ready', () => {
    if (process.env.MTLS_CLIENT_CERT) {
        app.importCertificate({
            certificate: process.env.MTLS_CLIENT_CERT,
            password: process.env.MTLS_CLIENT_PASS || ''
        }, (result) => {
            if (result === 0) {
                console.log('Successfully imported client certificate.');
            } else {
                console.error(`Failed to import client certificate, net::ERR code: ${result}`);
            }
        });
    }
    createJitsiMeetWindow();
});

app.on('second-instance', (event, commandLine) => {
    /**
     * If someone creates second instance of the application, set focus on
     * existing window.
     */
    const url = getProtocolUrl(commandLine);

    if (!url && mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
    }

    if (meetingWindow) {
        meetingWindow.isMinimized() && meetingWindow.restore();
        meetingWindow.focus();
    } else if (mainWindow) {
        mainWindow.isMinimized() && mainWindow.restore();
        mainWindow.focus();
    }

    /**
     * This is for windows [win32]
     * so when someone tries to enter something like jitsi-meet://test
     * while app is opened it will trigger protocol handler.
     */
    handleProtocolCall(url);
});

app.on('window-all-closed', () => {
    app.quit();
});

// remove so we can register each time as we run the app.
app.removeAsDefaultProtocolClient(config.appProtocolPrefix);

// If we are running a non-packaged version of the app && on windows
if (isDev && process.platform === 'win32') {
    // Set the path of electron.exe and your app.
    // These two additional parameters are only available on windows.
    app.setAsDefaultProtocolClient(
        config.appProtocolPrefix,
        process.execPath,
        [ path.resolve(process.argv[1]) ]
    );
} else {
    app.setAsDefaultProtocolClient(config.appProtocolPrefix);
}

/**
 * This is for mac [darwin]
 * so when someone tries to enter something like jitsi-meet://test
 * it will trigger this event below
 */
app.on('open-url', (event, data) => {
    event.preventDefault();
    handleProtocolCall(data);
});

/**
 * This is to notify main.js [this] that front app is ready to receive messages.
 * Called by BOTH the launcher and the meeting window on componentDidMount.
 */
ipcMain.on('renderer-ready', event => {
    // Launcher window — existing behaviour unchanged.
    if (mainWindow && event.sender.id === mainWindow.webContents.id) {
        rendererReady = true;
        if (protocolDataForFrontApp) {
            mainWindow
                .webContents
                .send('protocol-data-msg', protocolDataForFrontApp);
        }


    }

    // Meeting window is ready.
});

/**
 * Handle opening external links in the main process.
 */
ipcMain.on('jitsi-open-url', (event, someUrl) => {
    openExternalLink(someUrl);
});

/**
 * Restore the meeting window (e.g. from PiP).
 */
ipcMain.on('restore-meeting-window', () => {
    if (meetingWindow) {
        if (meetingWindow.isMinimized()) {
            meetingWindow.restore();
        }
        meetingWindow.focus();
    }
});

/**
 * Asks the user whether a remote control session may start.
 *
 * The request that gets here reaches the meeting window as a postMessage from
 * the conference iframe, so it carries no identity that can be trusted: any page
 * loaded in that iframe can send it, and Jitsi Meet's own in-page consent UI
 * runs inside exactly the frame an attacker controls. The prompt is therefore a
 * native, modal dialog owned by the main process — web content can neither
 * render, click nor dismiss it — and nothing is executed until the user allows
 * it here.
 *
 * @returns {Promise<boolean>} Whether the user allowed the session.
 */
async function requestRemoteControlConsent(): Promise<boolean> {
    if (!meetingWindow) {
        return false;
    }

    const { response } = await dialog.showMessageBox(meetingWindow, {
        type: 'warning',
        buttons: [ t('remoteControl.deny'), t('remoteControl.allow') ],
        defaultId: 0,
        cancelId: 0,
        message: t('remoteControl.message'),
        detail: t('remoteControl.detail')
    });

    return response === 1;
}

interface ITranslationRule {
    flags?: string;
    pattern: string;
    replace: string;
}

const translationRules: ITranslationRule[] = [
    // 1. Hardware / Voice specific phrases (evaluated before general words)
    { pattern: '^Same as system\\s*\\(Default\\)$', flags: 'i', replace: 'Sistemle aynı (Varsayılan)' },
    { pattern: '^Same as system$', flags: 'i', replace: 'Sistemle aynı' },
    { pattern: '^Sistemle aynı \\(Default\\)$', flags: 'i', replace: 'Sistemle aynı (Varsayılan)' },
    { pattern: '\\bBuilt-in Audio\\b', flags: 'gi', replace: 'Dahili Ses' },
    { pattern: '^Default(\\s*[-:]?\\s*)', flags: 'i', replace: 'Varsayılan$1' },
    { pattern: '\\(Default\\)', flags: 'gi', replace: '(Varsayılan)' },
    { pattern: '^\\s*Default\\s*$', flags: 'i', replace: 'Varsayılan' },
    { pattern: '\\bDefault\\b', flags: 'g', replace: 'Varsayılan' },
    { pattern: '^Acoustic echo cancellation$', flags: 'i', replace: 'Akustik yankı engelleme' },
    { pattern: '^Automatic gain control$', flags: 'i', replace: 'Otomatik kazanç kontrolü' },
    { pattern: '^Noise suppression$', flags: 'i', replace: 'Gürültü engelleme' },
    { pattern: '^Enable extra noise suppression$', flags: 'i', replace: 'Ek gürültü engellemeyi etkinleştir' },
    { pattern: '^Stereo$', flags: 'i', replace: 'Stereo' },
    { pattern: '^Enable audio translation$', flags: 'i', replace: 'Ses çevirisini etkinleştir' },
    { pattern: '^Translate audio$', flags: 'i', replace: 'Sesi çevir' },
    { pattern: '^Audio output$', flags: 'i', replace: 'Ses çıkışı' },
    { pattern: '^Pair device$', flags: 'i', replace: 'Cihazı eşleştir' },
    { pattern: '^Call control$', flags: 'i', replace: 'Çağrı kontrolü' },
    { pattern: '^Microphone$', flags: 'i', replace: 'Mikrofon' },
    { pattern: '^Audio$', flags: 'i', replace: 'Ses' },

    // 2. Chat Toolbar, Notifications & Toggle Buttons
    { pattern: '^\\s*Open\\s+chat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Sohbeti aç$1' },
    { pattern: '^\\s*Close\\s+chat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Sohbeti kapat$1' },
    { pattern: '^\\s*Open\\s*/\\s*Close\\s+chat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Sohbeti aç / kapat$1' },
    { pattern: '^\\s*Open\\s+or\\s+close\\s+(?:the\\s+)?chat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Sohbeti aç veya kapat$1' },
    { pattern: '^\\s*Mesajlaşmayı\\s+aç\\s*$', flags: 'i', replace: 'Sohbeti aç' },
    { pattern: '^\\s*Mesajlaşmayı\\s+kapat\\s*$', flags: 'i', replace: 'Sohbeti kapat' },
    { pattern: '^\\s*Mesajlaşma\\s+penceresini\\s+aç/kapat\\s*$', flags: 'i', replace: 'Sohbeti aç / kapat' },
    { pattern: '^\\s*Mesajlaşmayı\\s+aç/kapat\\s*$', flags: 'i', replace: 'Sohbeti aç / kapat' },
    { pattern: '^\\s*Mesajlaşmayı\\s+aç\\s+veya\\s+kapat\\s*$', flags: 'i', replace: 'Sohbeti aç veya kapat' },
    { pattern: '^\\s*Chat\\s+messages\\s*$', flags: 'i', replace: 'Sohbet mesajları' },
    { pattern: '^\\s*Incoming\\s+message\\s*$', flags: 'i', replace: 'Gelen mesaj' },
    { pattern: '^\\s*New\\s+messages\\s*$', flags: 'i', replace: 'Yeni mesajlar' },

    // 3. Chat Screen, Tabs & Input
    { pattern: '^\\s*Chat\\s*$', flags: 'i', replace: 'Sohbet' },
    { pattern: '^\\s*Chat\\s+and\\s*$', flags: 'i', replace: 'Sohbet ve' },
    { pattern: '^\\s*Send\\s*$', flags: 'i', replace: 'Gönder' },
    { pattern: '^\\s*Send\\s+a\\s+message\\s*$', flags: 'i', replace: 'Mesaj gönder' },
    { pattern: '^\\s*Send\\s+message\\s*$', flags: 'i', replace: 'Mesaj gönder' },
    { pattern: '^\\s*Type\\s+a\\s+message\\.{0,3}\\s*$', flags: 'i', replace: 'Bir mesaj yazın' },
    { pattern: '^Send to:\\s*Everyone$', flags: 'i', replace: 'Alıcı: Herkes' },
    { pattern: '^Send to:\\s*Herkes$', flags: 'i', replace: 'Alıcı: Herkes' },
    { pattern: '^To:\\s*Everyone$', flags: 'i', replace: 'Kime: Herkes' },
    { pattern: '^To:\\s*Herkes$', flags: 'i', replace: 'Kime: Herkes' },
    { pattern: '^\\s*Everyone\\s*$', flags: 'i', replace: 'Herkes' },
    { pattern: '\\bEveryone\\b', flags: 'g', replace: 'Herkes' },
    { pattern: '^Private message to\\s+(.+)$', flags: 'i', replace: '$1 adlı kişiye özel mesaj' },
    { pattern: '^Lobby chat message to\\s+(.+)$', flags: 'i', replace: '$1 adlı kişiye lobi mesajı' },
    { pattern: '^\\s*Private\\s+Message\\s*$', flags: 'i', replace: 'Özel mesaj' },
    { pattern: '^\\s*Send\\s+private\\s+message\\s*$', flags: 'i', replace: 'Özel mesaj gönder' },
    { pattern: '^\\s*Send\\s+privately\\??\\s*$', flags: 'i', replace: 'Özel olarak gönder' },
    { pattern: '^\\s*Send\\s+to\\s+the\\s+group\\s*$', flags: 'i', replace: 'Gruba gönder' },
    { pattern: '^You recently received a private message\\..*$', flags: 'i', replace: 'Kısa süre önce özel bir mesaj aldınız. Buna özel olarak cevap vermek ister misiniz yoksa mesajınızı gruba göndermek mi istiyorsunuz?' },
    { pattern: '^\\s*Sending\\s+chat\\s+messages\\s+is\\s+disabled\\.?\\s*$', flags: 'i', replace: 'Sohbet mesajı gönderme devre dışı bırakıldı.' },
    { pattern: '^\\s*Disable\\s+chat\\s+for\\s+non[- ]moderators\\s*$', flags: 'i', replace: 'Moderatör olmayanlar için sohbeti kapat' },
    { pattern: '^\\s*Search\\s+in\\s+chat\\s*$', flags: 'i', replace: 'Sohbette ara' },
    { pattern: '^\\s*Search\\s+messages\\s*$', flags: 'i', replace: 'Mesajları ara' },
    { pattern: '^\\s*Close\\s+search\\s*$', flags: 'i', replace: 'Aramayı kapat' },
    { pattern: '^\\s*No\\s+results\\s*$', flags: 'i', replace: 'Sonuç bulunamadı' },
    { pattern: '^\\s*Next\\s+match\\s*$', flags: 'i', replace: 'Sonraki eşleşme' },
    { pattern: '^\\s*Previous\\s+match\\s*$', flags: 'i', replace: 'Önceki eşleşme' },
    { pattern: '^\\s*Files\\s*$', flags: 'i', replace: 'Dosyalar' },
    { pattern: '^\\s*File\\s+sharing\\s*$', flags: 'i', replace: 'Dosya paylaşımı' },

    // 4. Message Context Menu, Actions & Badges
    { pattern: '^\\s*Edit\\s*$', flags: 'i', replace: 'Düzenle' },
    { pattern: '^\\s*Editing\\s*$', flags: 'i', replace: 'Düzenleniyor' },
    { pattern: '^\\s*\\(edited\\)\\s*$', flags: 'i', replace: '(düzenlendi)' },
    { pattern: '^\\s*Copy\\s*$', flags: 'i', replace: 'Kopyala' },
    { pattern: '^\\s*Message\\s+Copied\\s*$', flags: 'i', replace: 'Mesaj kopyalandı' },
    { pattern: '^\\s*Delete\\s+message\\s*$', flags: 'i', replace: 'Mesajı sil' },
    { pattern: '^\\s*Delete\\s*$', flags: 'i', replace: 'Sil' },
    { pattern: '^\\s*This\\s+message\\s+was\\s+deleted\\.?\\s*$', flags: 'i', replace: 'Bu mesaj silindi.' },
    { pattern: '^\\s*You\\s+deleted\\s+this\\s+message\\.?\\s*$', flags: 'i', replace: 'Bu mesajı sildiniz.' },
    { pattern: '^\\s*Deleted\\s+by\\s+a\\s+moderator\\.?\\s*$', flags: 'i', replace: 'Bir moderatör tarafından silindi.' },
    { pattern: '^\\s*Reason:\\s*(.+)$', flags: 'i', replace: 'Neden: $1' },
    { pattern: '^\\s*\\(guest\\)\\s*$', flags: 'i', replace: '(misafir)' },
    { pattern: '^\\s*\\(viewer\\)\\s*$', flags: 'i', replace: '(izleyici)' },
    { pattern: '^\\s*A\\s+file\\s+was\\s+deleted\\.?\\s*$', flags: 'i', replace: 'Bir dosya silindi.' },
    { pattern: '^\\s*me\\s+uploaded\\s+a\\s+file\\.?\\s*$', flags: 'i', replace: 'Bir dosya yükledim.' },
    { pattern: '^\\s*(.+?)\\s+uploaded\\s+a\\s+file\\.?\\s*$', flags: 'i', replace: '$1 bir dosya yükledi.' },
    { pattern: '^\\s*There\\s+are\\s+no\\s+messages\\s+in\\s+the\\s+meeting\\s+yet\\.?(\\s*Start\\s+a\\s+conversation\\s+here!?)?\\s*$', flags: 'i', replace: 'Toplantıda henüz mesaj yok. Burada bir konuşma başlatın!' },
    { pattern: '^\\s*There\\s+are\\s+no\\s+messages\\s+in\\s+the\\s+meeting\\s+yet\\.?\\s*$', flags: 'i', replace: 'Toplantıda henüz mesaj yok.' },
    { pattern: '^\\s*Start\\s+a\\s+conversation(\\s+here!?)?\\s*$', flags: 'i', replace: 'Bir konuşma başlatın' },
    { pattern: '^\\s*Choose\\s+a\\s+nickname\\s*$', flags: 'i', replace: 'Bir takma ad seçin' },
    { pattern: '^\\s*Enter\\s+room\\s*$', flags: 'i', replace: 'Odaya gir' },
    { pattern: '^\\s*Enter\\s+a\\s+nickname\\s+to\\s+use\\s+chat\\s*$', flags: 'i', replace: 'Sohbeti kullanmak için bir takma ad girin' },
    { pattern: '^\\s*Enter\\s+a\\s+nickname\\s+to\\s+use\\s+chat\\s+and\\s+closed\\s+captions\\s*$', flags: 'i', replace: 'Sohbet ve altyazıları kullanmak için bir takma ad girin' },
    { pattern: '^\\s*Enter\\s+a\\s+nickname\\s+to\\s+use\\s+chat,\\s*polls\\s+and\\s+closed\\s+captions\\s*$', flags: 'i', replace: 'Sohbet, anket ve altyazıları kullanmak için bir takma ad girin' },
    { pattern: '^\\s*Enter\\s+a\\s+nickname\\s+to\\s+use\\s+chat,\\s*polls,\\s*closed\\s+captions\\s+and\\s+files\\s*$', flags: 'i', replace: 'Sohbet, anket, altyazı ve dosyaları kullanmak için bir takma ad girin' },

    // 5. Polls, GIPHY & Reactions
    { pattern: '^\\s*Polls\\s*$', flags: 'i', replace: 'Anketler' },
    { pattern: '^\\s*Create\\s+a\\s+poll\\s*$', flags: 'i', replace: 'Anket oluştur' },
    { pattern: '^\\s*Poll\\s+Question\\s*$', flags: 'i', replace: 'Anket Sorusu' },
    { pattern: '^\\s*Ask\\s+a\\s+question\\s*$', flags: 'i', replace: 'Soru sor' },
    { pattern: '^\\s*Poll\\s+option\\s+(.+)$', flags: 'i', replace: 'Anket seçeneği $1' },
    { pattern: '^\\s*Option\\s+(.+)$', flags: 'i', replace: 'Seçenek $1' },
    { pattern: '^\\s*Add\\s+option\\s*$', flags: 'i', replace: 'Seçenek ekle' },
    { pattern: '^\\s*Remove\\s+option\\s*$', flags: 'i', replace: 'Seçeneği kaldır' },
    { pattern: '^\\s*Options\\s+must\\s+be\\s+unique\\s*$', flags: 'i', replace: 'Seçenekler benzersiz olmalıdır' },
    { pattern: '^\\s*Send\\s+poll\\s*$', flags: 'i', replace: 'Anketi gönder' },
    { pattern: '^\\s*Close\\s+poll\\s*$', flags: 'i', replace: 'Anketi kapat' },
    { pattern: '^\\s*Change\\s+vote\\s*$', flags: 'i', replace: 'Oyu değiştir' },
    { pattern: '^\\s*Show\\s+details\\s*$', flags: 'i', replace: 'Detayları göster' },
    { pattern: '^\\s*Hide\\s+details\\s*$', flags: 'i', replace: 'Detayları gizle' },
    { pattern: '^\\s*Open\\s+polls\\s+tab\\s+to\\s+vote\\s*$', flags: 'i', replace: 'Oy vermek için anketler sekmesini açın' },
    { pattern: '^\\s*A\\s+new\\s+poll\\s+was\\s+added\\s+to\\s+this\\s+meeting\\s*$', flags: 'i', replace: 'Toplantıya yeni bir anket eklendi' },
    { pattern: '^\\s*There\\s+are\\s+no\\s+polls\\s+in\\s+the\\s+meeting\\s+yet\\.?\\s*$', flags: 'i', replace: 'Bu toplantıda henüz bir anket oluşturulmadı.' },
    { pattern: '^\\s*Toggle\\s+GIPHY\\s+menu\\s*$', flags: 'i', replace: 'GIPHY menüsünü aç/kapat' },
    { pattern: '^\\s*Search\\s+GIPHY\\s*$', flags: 'i', replace: 'GIPHY ara' },
    { pattern: '^\\s*No\\s+results\\s+found\\s*:\\(\\s*$', flags: 'i', replace: 'Sonuç bulunamadı :(' },
    { pattern: '^\\s*Message\\s+reactions\\s*$', flags: 'i', replace: 'Mesaj tepkileri' },
    { pattern: '^\\s*Heart\\s*$', flags: 'i', replace: 'Kalp' },
    { pattern: '^\\s*Send\\s+heart\\s+reaction\\s*$', flags: 'i', replace: 'Kalp tepkisi gönder' },
    { pattern: '^\\s*Send\\s+love\\s+reaction\\s*$', flags: 'i', replace: 'Sevgi tepkisi gönder' },

    // 6. Screenshare & Desktop Moderation
    { pattern: '^\\s*Stop\\s+screen[- ]sharing\\s+for\\s+everyone\\s+else\\s*$', flags: 'i', replace: 'Diğer herkes için ekran paylaşımını durdur' },
    { pattern: '^\\s*Stop\\s+screen[- ]sharing\\s*$', flags: 'i', replace: 'Ekran paylaşımını durdur' },
    { pattern: '^\\s*Stop\\s+screen\\s+sharing\\s*$', flags: 'i', replace: 'Ekran paylaşımını durdur' },
    { pattern: '^\\s*Disable[- ]screen[- ]share\\s+of\\s+this\\s+participant\\s*\\??\\s*$', flags: 'i', replace: 'Bu katılımcı için ekran paylaşımını durdur?' },
    { pattern: '^\\s*Disable\\s+screen[- ]share\\s+of\\s+this\\s+participant\\s*\\??\\s*$', flags: 'i', replace: 'Bu katılımcı için ekran paylaşımını durdur?' },
    { pattern: '^\\s*Disable\\s+screen\\s+share\\s+of\\s+this\\s+participant\\s*\\??\\s*$', flags: 'i', replace: 'Bu katılımcı için ekran paylaşımını durdur?' },
    { pattern: '^\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+start\\s+their\\s+screen[- ]share,?\\s*but\\s+they\\s+can\\s+do\\s+so\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Ekran paylaşımını tekrar başlatamazsınız ancak istedikleri zaman kendileri başlatabilirler.' },
    { pattern: '^\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+start\\s+their\\s+screen[- ]share\\s+and\\s+neither\\s+will\\s+they\\.?\\s*$', flags: 'i', replace: 'Ekran paylaşımını ne siz başlatabilirsiniz ne de kendileri başlatabilir.' },
    { pattern: '^\\s*Are\\s+you\\s+sure\\s+you\\s+want\\s+to\\s+turn\\s+off\\s+this\\s+participant[\'’]s\\s+screen[- ]share\\??\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+restart\\s+it,?\\s*but\\s+they\\s+can\\s+do\\s+so\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Bu katılımcının ekran paylaşımını kapatmak istediğinize emin misiniz? Ekran paylaşımını tekrar başlatamazsınız ancak istedikleri zaman kendileri başlatabilirler.' },
    { pattern: '^\\s*Are\\s+you\\s+sure\\s+you\\s+want\\s+to\\s+turn\\s+off\\s+this\\s+participant[\'’]s\\s+screen[- ]share\\??\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+turn\\s+the\\s+screen\\s+back\\s+on\\s+and\\s+neither\\s+will\\s+they\\.?\\s*$', flags: 'i', replace: 'Bu katılımcının ekran paylaşımını kapatmak istediğinize emin misiniz? Ekran paylaşımını ne siz tekrar açabilirsiniz ne de kendileri açabilir.' },
    { pattern: '^\\s*Stop\\s+everyone[\'’]s\\s+screen[- ]share\\s+except\\s+(.+?)\\??\\s*$', flags: 'i', replace: '$1 dışındaki herkesin ekran paylaşımı durdurulsun mu?' },
    { pattern: '^\\s*Once\\s+the\\s+share\\s+is\\s+stopped,?\\s*you\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+restart\\s+it,?\\s*but\\s+they\\s+can\\s+do\\s+so\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Ekran paylaşımı durdurulduğunda tekrar başlatamazsınız ancak istedikleri zaman kendileri başlatabilirler.' },
    { pattern: '^\\s*Stop\\s+everyone[\'’]s\\s+screen[- ]share\\??\\s*$', flags: 'i', replace: 'Herkesin ekran paylaşımı durdurulsun mu?' },
    { pattern: '^\\s*Stop\\s+everyone[\'’]s\\s+screen\\s+share\\??\\s*$', flags: 'i', replace: 'Herkesin ekran paylaşımı durdurulsun mu?' },
    { pattern: '^\\s*Stop\\s+everyone[\'’]s\\s+screen[- ]share$', flags: 'i', replace: 'Herkesin ekran paylaşımını durdur' },
    { pattern: '^\\s*The\\s+participants\\s+can\\s+share\\s+their\\s+screen\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Katılımcılar istedikleri zaman ekranlarını paylaşabilirler.' },
    { pattern: '^\\s*The\\s+participants\\s+can\\s+send\\s+a\\s+request\\s+to\\s+share\\s+their\\s+screen\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Katılımcılar istedikleri zaman ekranlarını paylaşmak için istek gönderebilirler.' },
    { pattern: '^\\s*Allow\\s+non[- ]moderators\\s+to\\s+share\\s+their\\s+screen$', flags: 'i', replace: 'Moderatör olmayanların ekran paylaşmasına izin ver' },
    { pattern: '^\\s*Allow\\s+screen\\s+sharing$', flags: 'i', replace: 'Ekran paylaşımına izin ver' },
    { pattern: '^\\s*Ask\\s+to\\s+share\\s+screen$', flags: 'i', replace: 'Ekran paylaşımı iste' },
    { pattern: '^\\s*Start\\s+screen\\s+sharing$', flags: 'i', replace: 'Ekran paylaşımını başlat' },

    // 7. Video / Camera Moderation
    { pattern: '^\\s*Disable\\s+camera\\s+of\\s+this\\s+participant\\s*\\??\\s*$', flags: 'i', replace: 'Bu katılımcı için kamerayı durdur?' },
    { pattern: '^\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+turn\\s+the\\s+camera\\s+back\\s+on,?\\s*but\\s+they\\s+can\\s+turn\\s+it\\s+back\\s+on\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Kamerayı tekrar açamazsınız ancak istedikleri zaman kendileri açabilirler.' },
    { pattern: '^\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+turn\\s+the\\s+camera\\s+back\\s+on\\s+and\\s+neither\\s+will\\s+they\\.?\\s*$', flags: 'i', replace: 'Kamerayı ne siz tekrar açabilirsiniz ne de kendileri açabilir.' },
    { pattern: '^\\s*Are\\s+you\\s+sure\\s+you\\s+want\\s+to\\s+turn\\s+off\\s+this\\s+participant[\'’]s\\s+camera\\??\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+turn\\s+the\\s+camera\\s+back\\s+on,?\\s*but\\s+they\\s+can\\s+turn\\s+it\\s+back\\s+on\\s+at\\s+any\\s+time\\.?\\s*$', flags: 'i', replace: 'Bu katılımcının kamerasını kapatmak istediğinize emin misiniz? Kamerayı tekrar açamazsınız ancak istedikleri zaman kendileri açabilirler.' },
    { pattern: '^\\s*Are\\s+you\\s+sure\\s+you\\s+want\\s+to\\s+turn\\s+off\\s+this\\s+participant[\'’]s\\s+camera\\??\\s*You\\s+won[\'’]t\\s+be\\s+able\\s+to\\s+turn\\s+the\\s+camera\\s+back\\s+on\\s+and\\s+neither\\s+will\\s+they\\.?\\s*$', flags: 'i', replace: 'Bu katılımcının kamerasını kapatmak istediğinize emin misiniz? Kamerayı ne siz tekrar açabilirsiniz ne de kendileri açabilir.' },
    { pattern: '^\\s*Stop\\s+video\\s*$', flags: 'i', replace: 'Kamerayı durdur' },
    { pattern: '^\\s*Disable\\s+camera\\s+of\\s+everyone\\s+else\\s*$', flags: 'i', replace: 'Diğer herkesin kamerasını devre dışı bırak' },
    { pattern: '^\\s*Stop\\s+everyone[\'’]s\\s+video\\s*$', flags: 'i', replace: 'Herkesin videosunu durdur' },
    { pattern: '^\\s*Stop\\s+everyone\\s+else[\'’]s\\s+video\\s*$', flags: 'i', replace: 'Diğer herkesin videosunu durdur' },

    // 8. Participants Pane & Moderation Actions
    { pattern: '^\\s*Mute\\s+everyone\\s+else\\s*$', flags: 'i', replace: 'Diğer herkesi sessize al' },
    { pattern: '^\\s*Allow\\s+non[- ]moderators\\s+to:\\s*$', flags: 'i', replace: 'Katılımcıların şunları yapmasına izin ver:' },
    { pattern: '^\\s*Unmute\\s+themselves\\s*$', flags: 'i', replace: 'Seslerini açmalarına' },
    { pattern: '^\\s*Start\\s+their\\s+video\\s*$', flags: 'i', replace: 'Videolarını başlatmalarına' },
    { pattern: '^\\s*Block\\s+everyone[\'’]s\\s+mic\\s+and\\s+camera\\s*$', flags: 'i', replace: 'Herkesin mikrofonunu ve kamerasını engelle' },
    { pattern: '^\\s*Unblock\\s+everyone[\'’]s\\s+mic\\s+and\\s+camera\\s*$', flags: 'i', replace: 'Herkesin mikrofonunun ve kamerasının engellemesini kaldır' },
    { pattern: '^\\s*More\\s+moderation\\s+options\\s*$', flags: 'i', replace: 'Daha fazla denetleme seçeneği' },

    // jitsi-meet's own Turkish for "Everyone follows me" reads as the people who
    // follow you rather than the switch that makes them follow you.
    { pattern: '^\\s*Beni\\s+takip\\s+edenler\\s*$', flags: 'i', replace: 'Herkes beni takip etsin' },
    { pattern: '^\\s*Everyone\\s+follows\\s+me\\s*$', flags: 'i', replace: 'Herkes beni takip etsin' },
    { pattern: '^\\s*More\\s+moderation\\s+controls\\s*$', flags: 'i', replace: 'Daha fazla denetleme kontrolü' },
    { pattern: '^\\s*More\\s+participant\\s+options\\s*$', flags: 'i', replace: 'Daha fazla katılımcı seçeneği' },
    { pattern: '^\\s*Search\\s+participants\\s*$', flags: 'i', replace: 'Katılımcıları ara' },
    { pattern: '^\\s*Start\\s+typing\\s+to\\s+filter\\s+participants\\s*$', flags: 'i', replace: 'Katılımcıları filtrelemek için yazmaya başlayın' },
    { pattern: '^\\s*Your\\s+screen\\s+sharing\\s+has\\s+been\\s+stopped\\s+by\\s+(.+)\\s*$', flags: 'i', replace: 'Ekran paylaşımınız $1 tarafından durduruldu' },
    { pattern: '^\\s*Screen\\s+sharing\\s+is\\s+blocked\\s+by\\s+the\\s+moderator\\s*$', flags: 'i', replace: 'Ekran paylaşımı moderatör tarafından engellendi' },
    { pattern: '^\\s*Please\\s+raise\\s+hand\\s+if\\s+you\\s+want\\s+to\\s+share\\s+your\\s+screen\\.?\\s*$', flags: 'i', replace: 'Ekranınızı paylaşmak istiyorsanız lütfen el kaldırın.' },
    { pattern: '^\\s*You\\s+can\\s+unmute\\s+your\\s+microphone,\\s+start\\s+your\\s+camera\\s+or\\s+share\\s+your\\s+screen\\.?\\s*$', flags: 'i', replace: 'Mikrofonunuzun sesini açabilir, kameranızı başlatabilir veya ekranınızı paylaşabilirsiniz.' },

    // 9. Prejoin / Lobby / Miscellaneous
    { pattern: '^The conference has not yet started because no moderators have yet arrived\\.? If you[\'’]d like to become a moderator please log-in\\.? Otherwise, please wait\\.?$', flags: 'i', replace: 'Henüz hiçbir moderatör gelmediği için konferans başlamadı. Moderatör olmak istiyorsanız lütfen giriş yapın. Aksi takdirde lütfen bekleyin.' },
    { pattern: '^The conference has not yet started because no moderators have yet arrived\\.? Please wait\\.?$', flags: 'i', replace: 'Henüz hiçbir moderatör gelmediği için konferans başlamadı. Lütfen bekleyin.' },
    { pattern: '^Apply changes$', flags: 'i', replace: 'Değişiklikleri uygula' },
    { pattern: '^Record & Transcribe$', flags: 'i', replace: 'Kaydet ve Yazıya Dök' },
    { pattern: '^Translate to$', flags: 'i', replace: 'Şuna çevir' },
    { pattern: '^Translation in progress$', flags: 'i', replace: 'Çeviri devam ediyor' },
    { pattern: '^Off$', flags: 'i', replace: 'Kapalı' },
    { pattern: '^Closed captions$', flags: 'i', replace: 'Altyazılar' },
    { pattern: '^Close Picture-in-Picture mode$', flags: 'i', replace: 'Resim içinde Resim modunu kapat' }
];

const reverseTranslationRules: ITranslationRule[] = [
    // 1. Hardware / Voice specific phrases
    { pattern: '^Sistemle aynı\\s*\\(Varsayılan\\)$', flags: 'i', replace: 'Same as system (Default)' },
    { pattern: '^Sistemle aynı$', flags: 'i', replace: 'Same as system' },
    { pattern: '\\bDahili Ses\\b', flags: 'gi', replace: 'Built-in Audio' },
    { pattern: '^Varsayılan(\\s*[-:]?\\s*)', flags: 'i', replace: 'Default$1' },
    { pattern: '\\(Varsayılan\\)', flags: 'gi', replace: '(Default)' },
    { pattern: '^\\s*Varsayılan\\s*$', flags: 'i', replace: 'Default' },
    { pattern: '\\bVarsayılan\\b', flags: 'g', replace: 'Default' },
    { pattern: '^Akustik yankı engelleme$', flags: 'i', replace: 'Acoustic echo cancellation' },
    { pattern: '^Otomatik kazanç kontrolü$', flags: 'i', replace: 'Automatic gain control' },
    { pattern: '^Gürültü engelleme$', flags: 'i', replace: 'Noise suppression' },
    { pattern: '^Ek gürültü engellemeyi etkinleştir$', flags: 'i', replace: 'Enable extra noise suppression' },
    { pattern: '^Ses çevirisini etkinleştir$', flags: 'i', replace: 'Enable audio translation' },
    { pattern: '^Sesi çevir$', flags: 'i', replace: 'Translate audio' },
    { pattern: '^Ses çıkışı$', flags: 'i', replace: 'Audio output' },
    { pattern: '^Cihazı eşleştir$', flags: 'i', replace: 'Pair device' },
    { pattern: '^Çağrı kontrolü$', flags: 'i', replace: 'Call control' },
    { pattern: '^Mikrofon$', flags: 'i', replace: 'Microphone' },
    { pattern: '^Ses$', flags: 'i', replace: 'Audio' },

    // 2. Chat Toolbar, Notifications & Toggle Buttons
    { pattern: '^\\s*Sohbeti\\s+aç(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Open chat$1' },
    { pattern: '^\\s*Sohbeti\\s+kapat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Close chat$1' },
    { pattern: '^\\s*Sohbeti\\s+aç\\s*/\\s*kapat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Open / Close chat$1' },
    { pattern: '^\\s*Sohbeti\\s+aç\\s+veya\\s+kapat(\\s*\\([a-z0-9]\\))?\\s*$', flags: 'i', replace: 'Open or close chat$1' },
    { pattern: '^\\s*Sohbet\\s+mesajları\\s*$', flags: 'i', replace: 'Chat messages' },
    { pattern: '^\\s*Gelen\\s+mesaj\\s*$', flags: 'i', replace: 'Incoming message' },
    { pattern: '^\\s*Yeni\\s+mesajlar\\s*$', flags: 'i', replace: 'New messages' },

    // 3. Chat Screen, Tabs & Input
    { pattern: '^Alıcı:\\s*Herkes$', flags: 'i', replace: 'Send to: Everyone' },
    { pattern: '^Kime:\\s*Herkes$', flags: 'i', replace: 'To: Everyone' },
    { pattern: '^\\s*Herkes\\s*$', flags: 'i', replace: 'Everyone' },
    { pattern: '\\bHerkes\\b', flags: 'g', replace: 'Everyone' },
    { pattern: '^\\s*Sohbet\\s+ve\\s*$', flags: 'i', replace: 'Chat and' },
    { pattern: '^\\s*Sohbet\\s*$', flags: 'i', replace: 'Chat' },
    { pattern: '^\\s*Gönder\\s*$', flags: 'i', replace: 'Send' },
    { pattern: '^\\s*Mesaj\\s+gönder\\s*$', flags: 'i', replace: 'Send a message' },
    { pattern: '^\\s*Bir\\s+mesaj\\s+yazın\\s*$', flags: 'i', replace: 'Type a message' },
    { pattern: '^(.+)\\s+adlı\\s+kişiye\\s+özel\\s+mesaj$', flags: 'i', replace: 'Private message to $1' },
    { pattern: '^(.+)\\s+adlı\\s+kişiye\\s+lobi\\s+mesajı$', flags: 'i', replace: 'Lobby chat message to $1' },
    { pattern: '^\\s*Özel\\s+mesaj\\s*$', flags: 'i', replace: 'Private message' },
    { pattern: '^\\s*Özel\\s+mesaj\\s+gönder\\s*$', flags: 'i', replace: 'Send private message' },
    { pattern: '^\\s*Özel\\s+olarak\\s+gönder\\??\\s*$', flags: 'i', replace: 'Send privately' },
    { pattern: '^\\s*Gruba\\s+gönder\\s*$', flags: 'i', replace: 'Send to the group' },
    { pattern: '^Kısa süre önce özel bir mesaj aldınız\\..*$', flags: 'i', replace: 'You recently received a private message. Would you like to respond to that privately or send your message to the group?' },
    { pattern: '^\\s*Sohbet\\s+mesajı\\s+gönderme\\s+devre\\s+dışı\\s+bırakıldı\\.?\\s*$', flags: 'i', replace: 'Sending chat messages is disabled.' },
    { pattern: '^\\s*Moderatör\\s+olmayanlar\\s+için\\s+sohbeti\\s+kapat\\s*$', flags: 'i', replace: 'Disable chat for non-moderators' },
    { pattern: '^\\s*Sohbette\\s+ara\\s*$', flags: 'i', replace: 'Search in chat' },
    { pattern: '^\\s*Mesajları\\s+ara\\s*$', flags: 'i', replace: 'Search messages' },
    { pattern: '^\\s*Aramayı\\s+kapat\\s*$', flags: 'i', replace: 'Close search' },
    { pattern: '^\\s*Sonuç\\s+bulunamadı\\s*$', flags: 'i', replace: 'No results' },
    { pattern: '^\\s*Sonraki\\s+eşleşme\\s*$', flags: 'i', replace: 'Next match' },
    { pattern: '^\\s*Önceki\\s+eşleşme\\s*$', flags: 'i', replace: 'Previous match' },
    { pattern: '^\\s*Dosyalar\\s*$', flags: 'i', replace: 'Files' },
    { pattern: '^\\s*Dosya\\s+paylaşımı\\s*$', flags: 'i', replace: 'File sharing' },

    // 4. Message Context Menu, Actions & Badges
    { pattern: '^\\s*Düzenle\\s*$', flags: 'i', replace: 'Edit' },
    { pattern: '^\\s*Düzenleniyor\\s*$', flags: 'i', replace: 'Editing' },
    { pattern: '^\\s*\\(düzenlendi\\)\\s*$', flags: 'i', replace: '(edited)' },
    { pattern: '^\\s*Kopyala\\s*$', flags: 'i', replace: 'Copy' },
    { pattern: '^\\s*Mesaj\\s+kopyalandı\\s*$', flags: 'i', replace: 'Message Copied' },
    { pattern: '^\\s*Mesajı\\s+sil\\s*$', flags: 'i', replace: 'Delete message' },
    { pattern: '^\\s*Sil\\s*$', flags: 'i', replace: 'Delete' },
    { pattern: '^\\s*Bu\\s+mesaj\\s+silindi\\.?\\s*$', flags: 'i', replace: 'This message was deleted.' },
    { pattern: '^\\s*Bu\\s+mesajı\\s+sildiniz\\.?\\s*$', flags: 'i', replace: 'You deleted this message.' },
    { pattern: '^\\s*Bir\\s+moderatör\\s+tarafından\\s+silindi\\.?\\s*$', flags: 'i', replace: 'Deleted by a moderator.' },
    { pattern: '^\\s*Neden:\\s*(.+)$', flags: 'i', replace: 'Reason: $1' },
    { pattern: '^\\s*\\(misafir\\)\\s*$', flags: 'i', replace: '(guest)' },
    { pattern: '^\\s*\\(izleyici\\)\\s*$', flags: 'i', replace: '(viewer)' },
    { pattern: '^\\s*Bir\\s+dosya\\s+silindi\\.?\\s*$', flags: 'i', replace: 'A file was deleted.' },
    { pattern: '^\\s*Bir\\s+dosya\\s+yükledim\\.?\\s*$', flags: 'i', replace: 'me uploaded a file.' },
    { pattern: '^\\s*(.+?)\\s+bir\\s+dosya\\s+yükledi\\.?\\s*$', flags: 'i', replace: '$1 uploaded a file.' },
    { pattern: '^\\s*Toplantıda\\s+henüz\\s+mesaj\\s+yok\\.?\\s*(?:Burada\\s+bir\\s+konuşma\\s+başlatın!?)?\\s*$', flags: 'i', replace: 'There are no messages in the meeting yet. Start a conversation here!' },
    { pattern: '^\\s*Bir\\s+konuşma\\s+başlatın(\\s+burada!?)?\\s*$', flags: 'i', replace: 'Start a conversation' },
    { pattern: '^\\s*Bir\\s+takma\\s+ad\\s+seçin\\s*$', flags: 'i', replace: 'Choose a nickname' },
    { pattern: '^\\s*Odaya\\s+gir\\s*$', flags: 'i', replace: 'Enter room' },
    { pattern: '^\\s*Sohbeti\\s+kullanmak\\s+için\\s+bir\\s+takma\\s+ad\\s+girin\\s*$', flags: 'i', replace: 'Enter a nickname to use chat' },
    { pattern: '^\\s*Sohbet\\s+ve\\s+altyazıları\\s+kullanmak\\s+için\\s+bir\\s+takma\\s+ad\\s+girin\\s*$', flags: 'i', replace: 'Enter a nickname to use chat and closed captions' },
    { pattern: '^\\s*Sohbet,\\s*anket\\s+ve\\s+altyazıları\\s+kullanmak\\s+için\\s+bir\\s+takma\\s+ad\\s+girin\\s*$', flags: 'i', replace: 'Enter a nickname to use chat, polls and closed captions' },
    { pattern: '^\\s*Sohbet,\\s*anket,\\s*altyazı\\s+ve\\s+dosyaları\\s+kullanmak\\s+için\\s+bir\\s+takma\\s+ad\\s+girin\\s*$', flags: 'i', replace: 'Enter a nickname to use chat, polls, closed captions and files' },

    // 5. Polls & Reactions
    { pattern: '^\\s*Anketler\\s*$', flags: 'i', replace: 'Polls' },
    { pattern: '^\\s*Anket\\s+oluştur\\s*$', flags: 'i', replace: 'Create a poll' },
    { pattern: '^\\s*Anket\\s+Sorusu\\s*$', flags: 'i', replace: 'Poll Question' },
    { pattern: '^\\s*Soru\\s+sor\\s*$', flags: 'i', replace: 'Ask a question' },
    { pattern: '^\\s*Anket\\s+seçeneği\\s+(.+)$', flags: 'i', replace: 'Poll option $1' },
    { pattern: '^\\s*Seçenek\\s+(.+)$', flags: 'i', replace: 'Option $1' },
    { pattern: '^\\s*Seçenek\\s+ekle\\s*$', flags: 'i', replace: 'Add option' },
    { pattern: '^\\s*Seçeneği\\s+kaldır\\s*$', flags: 'i', replace: 'Remove option' },
    { pattern: '^\\s*Seçenekler\\s+benzersiz\\s+olmalıdır\\s*$', flags: 'i', replace: 'Options must be unique' },
    { pattern: '^\\s*Anketi\\s+gönder\\s*$', flags: 'i', replace: 'Send poll' },
    { pattern: '^\\s*Anketi\\s+kapat\\s*$', flags: 'i', replace: 'Close poll' },
    { pattern: '^\\s*Oyu\\s+değiştir\\s*$', flags: 'i', replace: 'Change vote' },
    { pattern: '^\\s*Detayları\\s+göster\\s*$', flags: 'i', replace: 'Show details' },
    { pattern: '^\\s*Detayları\\s+gizle\\s*$', flags: 'i', replace: 'Hide details' },
    { pattern: '^\\s*Oy\\s+vermek\\s+için\\s+anketler\\s+sekmesini\\s+açın\\s*$', flags: 'i', replace: 'Open polls tab to vote' },
    { pattern: '^\\s*Toplantıya\\s+yeni\\s+bir\\s+anket\\s+eklendi\\s*$', flags: 'i', replace: 'A new poll was added to this meeting' },
    { pattern: '^\\s*Bu\\s+toplantıda\\s+henüz\\s+bir\\s+anket\\s+oluşturulmadı\\.?\\s*$', flags: 'i', replace: 'There are no polls in the meeting yet.' },
    { pattern: '^\\s*GIPHY\\s+menüsünü\\s+aç/kapat\\s*$', flags: 'i', replace: 'Toggle GIPHY menu' },
    { pattern: '^\\s*GIPHY\\s+ara\\s*$', flags: 'i', replace: 'Search GIPHY' },
    { pattern: '^\\s*Sonuç\\s+bulunamadı\\s*:\\(\\s*$', flags: 'i', replace: 'No results found :(' },
    { pattern: '^\\s*Mesaj\\s+tepkileri\\s*$', flags: 'i', replace: 'Message reactions' },
    { pattern: '^\\s*Kalp\\s*$', flags: 'i', replace: 'Heart' },
    { pattern: '^\\s*Kalp\\s+tepkisi\\s+gönder\\s*$', flags: 'i', replace: 'Send heart reaction' },
    { pattern: '^\\s*Sevgi\\s+tepkisi\\s+gönder\\s*$', flags: 'i', replace: 'Send love reaction' },

    // 6. Screenshare & Desktop Moderation
    { pattern: '^\\s*Diğer\\s+herkes\\s+için\\s+ekran\\s+paylaşımını\\s+durdur\\s*$', flags: 'i', replace: 'Stop screen sharing for everyone else' },
    { pattern: '^\\s*Ekran\\s+paylaşımını\\s+durdur\\s*$', flags: 'i', replace: 'Stop screen sharing' },
    { pattern: '^\\s*Bu\\s+katılımcı\\s+için\\s+ekran\\s+paylaşımını\\s+durdur\\??\\s*$', flags: 'i', replace: 'Disable screen share of this participant?' },
    { pattern: '^\\s*Ekran\\s+paylaşımını\\s+tekrar\\s+başlatamazsınız\\s+ancak\\s+istedikleri\\s+zaman\\s+kendileri\\s+başlatabilirler\\.?\\s*$', flags: 'i', replace: 'You won’t be able to start their screen-share, but they can do so at any time.' },
    { pattern: '^\\s*Ekran\\s+paylaşımını\\s+ne\\s+siz\\s+başlatabilirsiniz\\s+ne\\s+de\\s+kendileri\\s+başlatabilir\\.?\\s*$', flags: 'i', replace: 'You won’t be able to start their screen-share and neither will they.' },
    { pattern: '^\\s*Bu\\s+katılımcının\\s+ekran\\s+paylaşımını\\s+kapatmak\\s+istediğinize\\s+emin\\s+misiniz\\?\\s*Ekran\\s+paylaşımını\\s+tekrar\\s+başlatamazsınız\\s+ancak\\s+istedikleri\\s+zaman\\s+kendileri\\s+başlatabilirler\\.?\\s*$', flags: 'i', replace: 'Are you sure you want to turn off this participant’s screen-share? You won’t be able to restart it, but they can do so at any time.' },
    { pattern: '^\\s*Bu\\s+katılımcının\\s+ekran\\s+paylaşımını\\s+kapatmak\\s+istediğinize\\s+emin\\s+misiniz\\?\\s*Ekran\\s+paylaşımını\\s+ne\\s+siz\\s+tekrar\\s+açabilirsiniz\\s+ne\\s+de\\s+kendileri\\s+açabilir\\.?\\s*$', flags: 'i', replace: 'Are you sure you want to turn off this participant’s screen-share? You won’t be able to turn the screen back on and neither will they.' },
    { pattern: '^\\s*(.+?)\\s+dışındaki\\s+herkesin\\s+ekran\\s+paylaşımı\\s+durdurulsun\\s+mu\\??\\s*$', flags: 'i', replace: 'Stop everyone’s screen-share except $1?' },
    { pattern: '^\\s*Ekran\\s+paylaşımı\\s+durdurulduğunda\\s+tekrar\\s+başlatamazsınız\\s+ancak\\s+istedikleri\\s+zaman\\s+kendileri\\s+başlatabilirler\\.?\\s*$', flags: 'i', replace: 'Once the share is stopped, you won’t be able to restart it, but they can do so at any time.' },
    { pattern: '^\\s*Herkesin\\s+ekran\\s+paylaşımı\\s+durdurulsun\\s+mu\\??\\s*$', flags: 'i', replace: 'Stop everyone’s screen-share?' },
    { pattern: '^\\s*Herkesin\\s+ekran\\s+paylaşımını\\s+durdur\\s*$', flags: 'i', replace: 'Stop everyone’s screen-share' },
    { pattern: '^\\s*Katılımcılar\\s+istedikleri\\s+zaman\\s+ekranlarını\\s+paylaşabilirler\\.?\\s*$', flags: 'i', replace: 'The participants can share their screen at any time.' },
    { pattern: '^\\s*Katılımcılar\\s+istedikleri\\s+zaman\\s+ekranlarını\\s+paylaşmak\\s+için\\s+istek\\s+gönderebilirler\\.?\\s*$', flags: 'i', replace: 'The participants can send a request to share their screen at any time.' },
    { pattern: '^\\s*Moderatör\\s+olmayanların\\s+ekran\\s+paylaşmasına\\s+izin\\s+ver\\s*$', flags: 'i', replace: 'Allow non-moderators to share their screen' },
    { pattern: '^\\s*Ekran\\s+paylaşımına\\s+izin\\s+ver\\s*$', flags: 'i', replace: 'Allow screen sharing' },
    { pattern: '^\\s*Ekran\\s+paylaşımı\\s+iste\\s*$', flags: 'i', replace: 'Ask to share screen' },
    { pattern: '^\\s*Ekran\\s+paylaşımını\\s+başlat\\s*$', flags: 'i', replace: 'Start screen sharing' },

    // 7. Video / Camera Moderation
    { pattern: '^\\s*Bu\\s+katılımcı\\s+için\\s+kamerayı\\s+durdur\\??\\s*$', flags: 'i', replace: 'Disable camera of this participant?' },
    { pattern: '^\\s*Kamerayı\\s+tekrar\\s+açamazsınız\\s+ancak\\s+istedikleri\\s+zaman\\s+kendileri\\s+açabilirler\\.?\\s*$', flags: 'i', replace: 'You won’t be able to turn the camera back on, but they can turn it back on at any time.' },
    { pattern: '^\\s*Kamerayı\\s+ne\\s+siz\\s+tekrar\\s+açabilirsiniz\\s+ne\\s+de\\s+kendileri\\s+açabilir\\.?\\s*$', flags: 'i', replace: 'You won’t be able to turn the camera back on and neither will they.' },
    { pattern: '^\\s*Bu\\s+katılımcının\\s+kamerasını\\s+kapatmak\\s+istediğinize\\s+emin\\s+misiniz\\?\\s*Kamerayı\\s+tekrar\\s+açamazsınız\\s+ancak\\s+istedikleri\\s+zaman\\s+kendileri\\s+açabilirler\\.?\\s*$', flags: 'i', replace: 'Are you sure you want to turn off this participant’s camera? You won’t be able to turn the camera back on, but they can turn it back on at any time.' },
    { pattern: '^\\s*Bu\\s+katılımcının\\s+kamerasını\\s+kapatmak\\s+istediğinize\\s+emin\\s+misiniz\\?\\s*Kamerayı\\s+ne\\s+siz\\s+tekrar\\s+açabilirsiniz\\s+ne\\s+de\\s+kendileri\\s+açabilir\\.?\\s*$', flags: 'i', replace: 'Are you sure you want to turn off this participant’s camera? You won’t be able to turn the camera back on and neither will they.' },
    { pattern: '^\\s*Kamerayı\\s+durdur\\s*$', flags: 'i', replace: 'Stop video' },
    { pattern: '^\\s*Diğer\\s+herkesin\\s+kamerasını\\s+devre\\s+dışı\\s+bırak\\s*$', flags: 'i', replace: 'Disable camera of everyone else' },
    { pattern: '^\\s*Herkesin\\s+videosunu\\s+durdur\\s*$', flags: 'i', replace: 'Stop everyone’s video' },
    { pattern: '^\\s*Diğer\\s+herkesin\\s+videosunu\\s+durdur\\s*$', flags: 'i', replace: 'Stop everyone else’s video' },

    // 8. Participants Pane & Moderation Actions
    { pattern: '^\\s*Diğer\\s+herkesi\\s+sessize\\s+al\\s*$', flags: 'i', replace: 'Mute everyone else' },
    { pattern: '^\\s*Katılımcıların\\s+şunları\\s+yapmasına\\s+izin\\s+ver:\\s*$', flags: 'i', replace: 'Allow non-moderators to:' },
    { pattern: '^\\s*Seslerini\\s+açmalarına\\s*$', flags: 'i', replace: 'Unmute themselves' },
    { pattern: '^\\s*Videolarını\\s+başlatmalarına\\s*$', flags: 'i', replace: 'Start their video' },
    { pattern: '^\\s*Herkesin\\s+mikrofonunu\\s+ve\\s+kamerasını\\s+engelle\\s*$', flags: 'i', replace: 'Block everyone’s mic and camera' },
    { pattern: '^\\s*Herkesin\\s+mikrofonunun\\s+ve\\s+kamerasının\\s+engellemesini\\s+kaldır\\s*$', flags: 'i', replace: 'Unblock everyone’s mic and camera' },
    { pattern: '^\\s*Daha\\s+fazla\\s+denetleme\\s+seçeneği\\s*$', flags: 'i', replace: 'More moderation options' },
    { pattern: '^\\s*Daha\\s+fazla\\s+denetleme\\s+kontrolü\\s*$', flags: 'i', replace: 'More moderation controls' },
    { pattern: '^\\s*Daha\\s+fazla\\s+katılımcı\\s+seçeneği\\s*$', flags: 'i', replace: 'More participant options' },
    { pattern: '^\\s*Katılımcıları\\s+ara\\s*$', flags: 'i', replace: 'Search participants' },
    { pattern: '^\\s*Katılımcıları\\s+filtrelemek\\s+için\\s+yazmaya\\s+başlayın\\s*$', flags: 'i', replace: 'Start typing to filter participants' },
    { pattern: '^\\s*Ekran\\s+paylaşımınız\\s+(.+)\\s+tarafından\\s+durduruldu\\s*$', flags: 'i', replace: 'Your screen sharing has been stopped by $1' },
    { pattern: '^\\s*Ekran\\s+paylaşımı\\s+moderatör\\s+tarafından\\s+engellendi\\s*$', flags: 'i', replace: 'Screen sharing is blocked by the moderator' },
    { pattern: '^\\s*Ekranınızı\\s+paylaşmak\\s+istiyorsanız\\s+lütfen\\s+el\\s+kaldırın\\.?\\s*$', flags: 'i', replace: 'Please raise hand if you want to share your screen.' },
    { pattern: '^\\s*Mikrofonunuzun\\s+sesini\\s+açabilir,\\s*kameranızı\\s+başlatabilir\\s+veya\\s+ekranınızı\\s+paylaşabilirsiniz\\.?\\s*$', flags: 'i', replace: 'You can unmute your microphone, start your camera or share your screen.' },

    // 9. Prejoin / Lobby / Miscellaneous
    { pattern: '^Henüz hiçbir moderatör gelmediği için konferans başlamadı\\. Moderatör olmak istiyorsanız lütfen giriş yapın\\. Aksi takdirde lütfen bekleyin\\.$', flags: 'i', replace: 'The conference has not yet started because no moderators have yet arrived. If you’d like to become a moderator please log-in. Otherwise, please wait.' },
    { pattern: '^Henüz hiçbir moderatör gelmediği için konferans başlamadı\\. Lütfen bekleyin\\.$', flags: 'i', replace: 'The conference has not yet started because no moderators have yet arrived. Please wait.' },
    { pattern: '^Değişiklikleri\\s+uygula$', flags: 'i', replace: 'Apply changes' },
    { pattern: '^Kaydet\\s+ve\\s+Yazıya\\s+Dök$', flags: 'i', replace: 'Record & Transcribe' },
    { pattern: '^Şuna\\s+çevir$', flags: 'i', replace: 'Translate to' },
    { pattern: '^Çeviri\\s+devam\\s+ediyor$', flags: 'i', replace: 'Translation in progress' },
    { pattern: '^Kapalı$', flags: 'i', replace: 'Off' },
    { pattern: '^Altyazılar$', flags: 'i', replace: 'Closed captions' },
    { pattern: '^Resim\\s+içinde\\s+Resim\\s+modunu\\s+kapat$', flags: 'i', replace: 'Close Picture-in-Picture mode' }
];

/**
 * Containers whose controls jitsi-meet only mounts while the pointer hovers them.
 * A tap on one of these is treated as a hover first: the container's own click
 * action is dropped for that tap, so the controls it just revealed can be pressed
 * with the next one.
 *
 * Thumbnails deliberately stay out of this. Their click action is pinning, which
 * a tap has to keep meaning, so they are handled by `THUMBNAIL_CONTAINERS` below
 * instead of by a reveal tap.
 */
const HOVER_REVEAL_CONTAINERS = '.list-item-container';

/**
 * Thumbnails, and the menu trigger jitsi-meet mounts inside one only while it
 * reports `isHovered`.
 *
 * On a touchscreen there is nothing to hold that hover: the tap that would
 * reveal the button is the same tap that pins the participant, and pinning
 * re-lays out the filmstrip and mounts a fresh thumbnail with the hover gone —
 * so the button appears and is taken away again within the gesture. Dropping the
 * click instead would cost the pin, which has to keep working.
 *
 * So the thumbnails are simply kept hovered, and the menu button stays mounted.
 * A tap on the tile then means pin, exactly as a click does, and a tap on the
 * button opens the menu, with nothing to reveal first. `isHovered` drives only
 * this button and the connection indicator's auto-hide, so nothing else moves.
 */
const THUMBNAIL_CONTAINERS = '.videocontainer';
const THUMBNAIL_MENU_TRIGGERS = '#remote-video-menu-trigger, #local-video-menu-trigger';

/**
 * Popover triggers that open on hover and toggle themselves shut again on click
 * (`Popover.web` `_onClick`, for a popover left at the default `trigger: 'hover'`
 * with `focusable` defaulting to true). A tap fires both, so the menu would open
 * and close within the same gesture unless that click is dropped.
 *
 * This is a list rather than a rule because the markup offers nothing that tells
 * these apart from an ordinary button: tooltips are Popovers too, and so are the
 * click-triggered menus, which must keep their clicks. Extend it when a menu
 * turns out to open and shut on the same tap; jitsi-meet's own popovers without
 * an id (chat reactions, the device pickers, the prejoin dropdown) have no
 * handle to name here.
 */
const HOVER_POPOVER_TRIGGERS
    = '#remote-video-menu-trigger, #local-video-menu-trigger, #participant-connection-indicator';

/**
 * Touch support for the conference iframe.
 *
 * jitsi-meet decides whether a device has touch from the user agent
 * (`isMobileBrowser()` reads `Platform.OS`), so on Linux/Electron it runs its
 * mouse-only code paths no matter what the screen can do: the participant menu
 * button is mounted only while `isHovered` is set from `onMouseEnter`, popovers
 * open on `mouseenter`, and the toolbar comes back on `mousemove`. A touchscreen
 * produces none of that until Chromium synthesizes its compatibility mouse
 * events at touchend — by which time the click has already been hit-tested
 * against the old DOM, which is why those buttons only respond to a second tap.
 *
 * This turns a tap into the hover the UI is waiting for, at pointerdown, and
 * drops the click of that same tap where it would undo the hover's effect.
 *
 * @returns {string} The script to evaluate inside the conference frame.
 */
function getTouchSupportCode(): string {
    return `
        (function() {
            if (window.location.href === 'about:blank') return;
            if (window.__touchHoverShim) return;
            if (!(navigator.maxTouchPoints > 0)) return;
            window.__touchHoverShim = true;

            var REVEAL_CONTAINERS = ${JSON.stringify(HOVER_REVEAL_CONTAINERS)};
            var POPOVER_TRIGGERS = ${JSON.stringify(HOVER_POPOVER_TRIGGERS)};
            var THUMBNAILS = ${JSON.stringify(THUMBNAIL_CONTAINERS)};
            var THUMBNAIL_MENUS = ${JSON.stringify(THUMBNAIL_MENU_TRIGGERS)};
            var HOVER_CLASS = 'touch-hover';

            if (!document.getElementById('touch-hover-style') && document.head) {
                var style = document.createElement('style');
                style.id = 'touch-hover-style';

                // The participants pane reveals its row actions through a plain CSS
                // :hover rule. Dispatched events cannot move the browser's hover
                // node, so that rule is mirrored here against the class the shim
                // maintains. Filmstrip and CustomPanel already handle touch
                // themselves (they check isTouchDevice()), and chat messages use
                // React state, so they need nothing here.
                style.innerHTML = '.list-item-container.touch-hover .actions {'
                    + ' display: flex !important;'
                    + ' position: relative !important;'
                    + ' top: auto !important; }'
                    + ' .list-item-container.touch-hover .indicators { display: none !important; }';
                document.head.appendChild(style);
            }

            var hovered = null;
            var pending = null;
            // True while the shim, rather than a mouse, decides what is hovered.
            // It starts out owning it: on a touchscreen there is no mouse to hand
            // over to, and the thumbnails must stay hovered from the first frame or
            // Chromium's hover recomputation and this shim would take the menu
            // button away from each other, frame after frame.
            var shimOwnsHover = true;
            var lastMousePos = null;

            function send(el, type, relatedTarget) {
                try {
                    var event = new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        relatedTarget: relatedTarget || null
                    });

                    event.__shim = true;
                    el.dispatchEvent(event);
                } catch (e) {
                    // The element can be detached mid-gesture; nothing to do.
                }
            }

            function chain(el) {
                var out = [];

                while (el && el.nodeType === 1) {
                    out.push(el);
                    el = el.parentElement;
                }

                return out;
            }

            function paint(next) {
                var prevChain = hovered ? chain(hovered) : [];
                var nextChain = next ? chain(next) : [];

                prevChain.forEach(function(el) {
                    if (nextChain.indexOf(el) === -1) {
                        el.classList.remove(HOVER_CLASS);
                    }
                });
                nextChain.forEach(function(el) {
                    el.classList.add(HOVER_CLASS);
                });
            }

            // React derives onMouseEnter/onMouseLeave from mouseout/mouseover pairs.
            // A single mouseout carrying the new element as relatedTarget makes it
            // walk up to the common ancestor, so shared parents keep their hover
            // state — moving onto a menu button inside a thumbnail must not tell
            // the thumbnail it was left, or it would unmount the button being
            // aimed at.
            function moveHoverTo(next) {
                if (hovered === next) {
                    return false;
                }

                paint(next);

                if (hovered && document.contains(hovered)) {
                    send(hovered, 'mouseout', next);
                } else if (next) {
                    send(next, 'mouseover', null);
                }

                hovered = next;
                scheduleReassert();

                return true;
            }

            function enclosing(el, selector) {
                return el && el.closest ? el.closest(selector) : null;
            }

            // Hovers every thumbnail that is currently missing its menu button, so
            // the button stays mounted through pins, re-layouts and the hover the
            // shim moves around. Thumbnails whose menu is disabled have no trigger
            // to fill and are skipped, which is also what keeps this from looping:
            // once the button is there the pass dispatches nothing.
            function reassertThumbnails() {
                // Once a mouse has taken over, hover is its business again.
                if (!shimOwnsHover) return;

                var tiles = document.querySelectorAll(THUMBNAILS);

                for (var i = 0; i < tiles.length; i++) {
                    var trigger = tiles[i].querySelector(THUMBNAIL_MENUS);

                    if (trigger && !trigger.firstElementChild) {
                        send(tiles[i], 'mouseover', null);
                    }
                }
            }

            var reassertQueued = false;

            function scheduleReassert() {
                if (reassertQueued) return;

                reassertQueued = true;
                requestAnimationFrame(function() {
                    reassertQueued = false;
                    reassertThumbnails();
                });
            }

            // Chromium marks the mouse events it synthesizes out of a tap, which is
            // how the shim tells them apart from a mouse that is really being moved.
            function isCompatEvent(e) {
                return Boolean(e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents);
            }

            // Chromium keeps hover on whatever sits under the last real mouse
            // position and re-runs it whenever the layout changes — and revealing a
            // control changes the layout. That recomputation lands as a plain
            // mouseout on the element the tap had just hovered, which is what made
            // the menu button flash and vanish again. Long-pressing hid it only
            // because the context menu moves that stored position onto the touch
            // point, until a real mouse moves and puts it back.
            //
            // So while a tap owns the hover, hover changes from anywhere but this
            // shim are held back. The ones Chromium synthesizes for the tap itself
            // are redundant with the shim's own, so nothing is lost by dropping
            // them too, and a mouse that actually moves takes over immediately.
            //
            // The position is read in screen coordinates on purpose. A stationary
            // cursor keeps the same screen position while the page moves under it,
            // and the meeting window is maximized shortly after it opens, so client
            // coordinates shift on their own at exactly the moment the thumbnails
            // first appear — enough to look like a mouse and hand hover away before
            // the menu buttons were ever put up.
            function releaseToMouse(e) {
                if (e.__shim || isCompatEvent(e)) return;

                var moved = lastMousePos
                    && (lastMousePos.x !== e.screenX || lastMousePos.y !== e.screenY);

                lastMousePos = { x: e.screenX, y: e.screenY };

                if (!moved || !shimOwnsHover) return;

                shimOwnsHover = false;
                moveHoverTo(null);
            }

            function guardHover(e) {
                releaseToMouse(e);

                if (shimOwnsHover && !e.__shim) {
                    e.stopPropagation();
                }
            }

            document.addEventListener('mouseover', guardHover, true);
            document.addEventListener('mouseout', guardHover, true);
            document.addEventListener('mousemove', releaseToMouse, true);

            document.addEventListener('pointerdown', function(e) {
                if (e.pointerType !== 'touch') {
                    if (shimOwnsHover) {
                        shimOwnsHover = false;
                        moveHoverTo(null);
                    }

                    return;
                }

                shimOwnsHover = true;

                var target = e.target && e.target.nodeType === 1 ? e.target : null;
                var fromContainer = enclosing(hovered, REVEAL_CONTAINERS);
                var fromTrigger = enclosing(hovered, POPOVER_TRIGGERS);
                var toContainer = enclosing(target, REVEAL_CONTAINERS);
                var toTrigger = enclosing(target, POPOVER_TRIGGERS);

                moveHoverTo(target);

                // Moving the hover onto the tap can have told a thumbnail it was
                // left. Putting it back in the same task keeps the menu button from
                // blinking out for a frame.
                reassertThumbnails();

                if (hovered) {
                    // Brings the toolbar back: Conference.web binds _onShowToolbar
                    // to onMouseMove on #videoconference_page.
                    send(hovered, 'mousemove', null);
                }

                // The click that follows is dropped only where the hover has
                // already done the tap's work and the click would undo it: the
                // hover just entered a container that revealed its controls (whose
                // own click would select the row instead), or it just entered a
                // popover trigger that toggles shut on click. Moving around inside
                // one it was already on is left alone, so the revealed controls
                // stay pressable with the next tap — and a tap on a thumbnail is
                // never dropped, so pinning keeps working.
                pending = {
                    at: Date.now(),
                    swallow: (Boolean(toContainer) && toContainer !== fromContainer)
                        || (Boolean(toTrigger) && toTrigger !== fromTrigger)
                };
            }, true);

            document.addEventListener('pointercancel', function() {
                pending = null;
            }, true);

            document.addEventListener('click', function(e) {
                var tap = pending;

                pending = null;

                // Keyboard and programmatic clicks carry detail 0 and are not ours,
                // and neither is one arriving long after the tap that set this up.
                if (!tap || !tap.swallow || e.detail === 0 || Date.now() - tap.at > 2000) return;

                e.preventDefault();
                e.stopPropagation();
            }, true);

            // Thumbnails come and go as people join, pin, or the layout switches,
            // and each new one starts unhovered. Watching for them is what makes the
            // menu button survive a pin instead of vanishing with the old tile.
            function watchThumbnails() {
                if (!document.body) return;

                new MutationObserver(scheduleReassert)
                    .observe(document.body, { childList: true, subtree: true });
                reassertThumbnails();
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', watchThumbnails);
            } else {
                watchThumbnails();
            }
        })();
    `;
}

/**
 * How far down the conference info band — the subject, the meeting timer and the
 * labels beside them — sits. jitsi-meet pins that band to the top of the meeting
 * (`.details-container { top: 0 }`); this replaces that offset, so raise or lower
 * the value to move the band.
 */
const CONFERENCE_INFO_TOP_OFFSET = '36px';

function getInjectionCode(): string {
    return `
        (function() {
            if (window.location.href === 'about:blank') return;

            if (!document.getElementById('hide-watermark-style')) {
                var style = document.createElement('style');
                style.id = 'hide-watermark-style';
                style.innerHTML = '.watermark, .leftwatermark { display: none !important; visibility: hidden !important; width: 0 !important; height: 0 !important; opacity: 0 !important; pointer-events: none !important; }';
                if (document.head) {
                    document.head.appendChild(style);
                }
            }

            if (!document.getElementById('conference-info-offset-style')) {
                var infoStyle = document.createElement('style');

                infoStyle.id = 'conference-info-offset-style';

                // jitsi-meet pins the info band to the top of the meeting; this
                // pushes it down. Only the band's own offset is touched, so the
                // show/hide animation on .subject, which drives max-width, and the
                // layout inside .subject-info-container are both left alone.
                infoStyle.innerHTML = '.details-container { top: ${CONFERENCE_INFO_TOP_OFFSET} !important; }';
                if (document.head) {
                    document.head.appendChild(infoStyle);
                }
            }

            if (!document.getElementById('camera-preview-filter-style')) {
                var cameraStyle = document.createElement('style');

                cameraStyle.id = 'camera-preview-filter-style';

                // Drops cameras the system could not produce a preview for from the
                // camera picker. jitsi-meet tries a 5s preview track per device and,
                // when that fails, renders the entry as a dead tile carrying a
                // "preview unavailable" message instead of a picture.
                //
                // The entries are matched structurally because their classes are
                // generated: a working camera is a selectable menu item, while a
                // failed one is rendered with tabIndex -1 and no role at all, so it
                // is the only child of the group that is not reachable.
                cameraStyle.innerHTML
                    = '#video-settings-dialog [role="group"] > div[tabindex="-1"] { display: none !important; }';
                if (document.head) {
                    document.head.appendChild(cameraStyle);
                }
            }

            if (!document.getElementById('hide-audio-device-pickers-style')) {
                var audioStyle = document.createElement('style');

                audioStyle.id = 'hide-audio-device-pickers-style';

                // Takes away the two places a microphone or a speaker can be
                // picked, leaving the meeting on whatever the system uses (see
                // _useSystemDefaultAudioDevices in the conference component).
                //
                // The first is the caret beside the microphone button, whose only
                // content is those two lists; it is hidden along with its tooltip
                // wrapper so the button does not keep a gap where it sat. The
                // second is the pair of selectors at the top and bottom of the
                // settings dialog's audio tab. Both are addressed by ids and roles
                // jitsi-meet writes out verbatim, since the class names around them
                // are generated. The tab's remaining controls — the level meter,
                // noise suppression and the advanced audio checkboxes — are
                // untouched.
                audioStyle.innerHTML
                    = '#audio-settings-button,'
                    + ' .settings-button-small-icon:has(> #audio-settings-button)'
                    + ' { display: none !important; }'
                    + ' #dialogtab-content-audio_tab div[aria-live="polite"]'
                    + ' { display: none !important; }';
                if (document.head) {
                    document.head.appendChild(audioStyle);
                }
            }

            if (!document.getElementById('hide-message-reactions-style')) {
                var reactionStyle = document.createElement('style');

                reactionStyle.id = 'hide-message-reactions-style';

                // Takes away the emoji button that appears on a chat message when
                // it is hovered. The picker in the composer and the reaction menu
                // on the toolbar are switched off through config instead
                // (disableChatSmileys, disableReactions); this one has no such
                // flag in jitsi-meet 11146 — disableReactionsInChat is accepted by
                // the config whitelist but nothing reads it.
                //
                // The buttons sit in an unnamed pair of divs after the message, so
                // the message's own stable class anchors them: the emoji button is
                // the first of the two, and the message menu, which stays, is the
                // second. Where a message carries no emoji button that menu is an
                // only child, which :not(:last-child) keeps out of the way of.
                reactionStyle.innerHTML
                    = '.chatmessage + div > div:first-child:not(:last-child)'
                    + ' { display: none !important; }';
                if (document.head) {
                    document.head.appendChild(reactionStyle);
                }
            }

            if (!document.getElementById('hide-follow-me-recorder-style')) {
                var followMeStyle = document.createElement('style');

                followMeStyle.id = 'hide-follow-me-recorder-style';

                // Takes the "recorder follows me" checkbox out of the settings
                // dialog's moderator tab. It has no config flag, but the checkbox
                // carries the name jitsi-meet writes out verbatim, and Checkbox
                // wraps each one in its own label, so hiding that label takes the
                // box and its text together and leaves the neighbouring
                // "everyone follows me" alone.
                followMeStyle.innerHTML
                    = '.moderator-tab label:has(input[name="follow-me-recorder"])'
                    + ' { display: none !important; }';
                if (document.head) {
                    document.head.appendChild(followMeStyle);
                }
            }

            if (!document.getElementById('chat-timestamp-inline-style')) {
                var timestampStyle = document.createElement('style');

                timestampStyle.id = 'chat-timestamp-inline-style';

                // Moves the time to the end of the message instead of onto a line
                // of its own, which is what makes the bubbles so tall: jitsi-meet
                // puts it in a footer below the text, and both that footer and the
                // time inside it add a top margin.
                //
                // The footer is dropped from the layout with display: contents so
                // its children lay out as if they were the message's own, and the
                // time is then floated to the right. Coming last in the source, a
                // float lands at the end of the final line of text when there is
                // room for it and drops to its own line when there is not, so a
                // short message keeps the time beside it and a long one still
                // reads properly. Anything else in the footer, such as reactions,
                // stays where it was.
                //
                // Matched through the classes jitsi-meet writes out verbatim; the
                // footer's own class is generated, so it is reached through the
                // time it contains.
                // A float's top sits on the top of the line box, and the time is
                // set in a smaller face than the message, so it would otherwise
                // ride high. Taking the message's line height gives it a box of
                // the same height to sit in, which brings the two to within a
                // pixel of each other, and that pixel is given back below.
                // A private message carries a notice between its text and the
                // footer, and that notice is a block, which breaks the line the
                // float was going to land on and sends the time below it again.
                // Laid out inline with a break of its own in front, the notice
                // still gets a line to itself and the time now shares it.
                timestampStyle.innerHTML
                    = '.usermessage p { display: inline; margin: 0; }'
                    + ' .usermessage > div:not(:has(.timestamp))'
                    + ' { display: inline; }'
                    + ' .usermessage > div:not(:has(.timestamp))::before'
                    + ' { content: ""; display: block; }'
                    + ' .usermessage > div:has(> .timestamp)'
                    + ' { float: right; margin: 1px 0 0 8px; }'
                    + ' .usermessage .timestamp { line-height: inherit; margin: 0; }';
                if (document.head) {
                    document.head.appendChild(timestampStyle);
                }
            }

            // Takes the "contact support" button off jitsi-meet's error
            // notifications, the authentication failure among them. That button is
            // rendered only while a support URL exists, and getSupportUrl reads
            // interfaceConfig.SUPPORT_URL — which the deployment leaves pointing at
            // community.jitsi.org — on every render. Clearing the global removes
            // the button at its source, with no reliance on markup or on a
            // translated label. It is done here rather than through
            // interfaceConfigOverwrite because SUPPORT_URL is not in jitsi-meet's
            // interface config whitelist, so that route silently drops it.
            //
            // This runs before the guard below so the retries still catch it if the
            // page had not defined interfaceConfig yet.
            if (window.interfaceConfig && window.interfaceConfig.SUPPORT_URL) {
                window.interfaceConfig.SUPPORT_URL = '';
            }

            if (window.__tr_localization_injected) return;
            window.__tr_localization_injected = true;

            function isTurkish() {
                try {
                    var dl = document.documentElement && document.documentElement.lang;
                    if (dl && typeof dl === 'string' && dl.trim()) {
                        return dl.toLowerCase().startsWith('tr');
                    }
                } catch(e) {}

                try {
                    if (window.APP && window.APP.translation && typeof window.APP.translation.getCurrentLanguage === 'function') {
                        var cur = window.APP.translation.getCurrentLanguage();
                        if (cur && typeof cur === 'string' && cur.trim()) {
                            return cur.toLowerCase().startsWith('tr');
                        }
                    }
                } catch(e) {}

                try {
                    if (window.APP && window.APP.store) {
                        var state = window.APP.store.getState();
                        if (state && state['features/base/i18n'] && state['features/base/i18n'].language) {
                            return state['features/base/i18n'].language.toLowerCase().startsWith('tr');
                        }
                    }
                } catch(e) {}

                try {
                    var ls = localStorage.getItem('language') || localStorage.getItem('i18nextLng');
                    if (ls && typeof ls === 'string' && ls.trim()) {
                        return ls.toLowerCase().startsWith('tr');
                    }
                } catch(e) {}

                try {
                    if (navigator.language && typeof navigator.language === 'string') {
                        return navigator.language.toLowerCase().startsWith('tr');
                    }
                } catch(e) {}

                return false;
            }

            function injectI18nResources() {
                try {
                    if (window.i18next && typeof window.i18next.addResourceBundle === 'function') {
                        window.i18next.addResourceBundle('tr', 'translation', {
                            notify: {
                                openChat: 'Sohbeti aç',
                                chatMessages: 'Sohbet mesajları'
                            },
                            toolbar: {
                                openChat: 'Sohbeti aç',
                                closeChat: 'Sohbeti kapat',
                                chat: 'Sohbeti aç / kapat',
                                accessibilityLabel: {
                                    openChat: 'Sohbeti aç',
                                    closeChat: 'Sohbeti kapat',
                                    chat: 'Sohbeti aç / kapat',
                                    privateMessage: 'Özel mesaj gönder',
                                    react: 'Mesaj tepkileri'
                                }
                            },
                            chat: {
                                everyone: 'Herkes',
                                sendButton: 'Gönder',
                                messagebox: 'Bir mesaj yazın',
                                disabled: 'Sohbet mesajı gönderme devre dışı bırakıldı.',
                                delete: 'Sil',
                                deleteMessage: 'Sil',
                                deletedMessage: 'Bu mesaj silindi.',
                                deletedMessageByMe: 'Bu mesajı sildiniz.',
                                moderatedMessage: 'Bir moderatör tarafından silindi.',
                                moderationReason: 'Neden: {{reason}}',
                                edited: '(düzenlendi)',
                                editingMessage: 'Düzenleniyor',
                                newMessages: 'Yeni mesajlar',
                                fileDeleted: 'Bir dosya silindi.',
                                fileAccessibleTitle: '{{user}} bir dosya yükledi.',
                                fileAccessibleTitleMe: 'Bir dosya yükledim.',
                                guestsChatIndicator: '(misafir)',
                                search: {
                                    placeholder: 'Sohbette ara',
                                    open: 'Mesajları ara',
                                    close: 'Aramayı kapat',
                                    next: 'Sonraki eşleşme',
                                    previous: 'Önceki eşleşme',
                                    noResults: 'Sonuç bulunamadı'
                                },
                                tabs: {
                                    chat: 'Sohbet',
                                    polls: 'Anketler',
                                    fileSharing: 'Dosyalar',
                                    closedCaptions: 'Altyazılar'
                                },
                                title: 'Sohbet',
                                titleWithFeatures: 'Sohbet ve',
                                titleWithCC: 'Altyazılar',
                                titleWithFileSharing: 'Dosyalar',
                                titleWithPolls: 'Anketler'
                            },
                            polls: {
                                closeButton: 'Anketi kapat',
                                create: {
                                    accessibilityLabel: {
                                        send: 'Anketi gönder'
                                    }
                                }
                            },
                            settings: {
                                chatWithPermissions: 'Moderatör olmayanlar için sohbeti kapat'
                            }
                        }, true, true);
                    }
                } catch(e) {}
            }

            // 1. Hook enumerateDevices so hardware device names display "Varsayılan" in Turkish, and "Default" in English
            var nav = (typeof window !== 'undefined' && window.navigator) ? window.navigator : (typeof navigator !== 'undefined' ? navigator : null);
            if (nav && nav.mediaDevices && nav.mediaDevices.enumerateDevices) {
                var origEnumerate = nav.mediaDevices.enumerateDevices.bind(nav.mediaDevices);
                nav.mediaDevices.enumerateDevices = async function() {
                    var list = await origEnumerate();
                    var tr = isTurkish();
                    return list.map(function(d) {
                        if (d.label) {
                            var newLabel = d.label;
                            if (tr) {
                                if (/default|built-in audio/i.test(newLabel)) {
                                    newLabel = newLabel
                                        .replace(/^default(\s*[-:]?\s*)/i, 'Varsayılan$1')
                                        .replace(/\bDefault\b/g, 'Varsayılan')
                                        .replace(/\(Default\)/gi, '(Varsayılan)')
                                        .replace(/\bBuilt-in Audio\b/gi, 'Dahili Ses');
                                }
                            } else {
                                if (/varsayılan|dahili ses/i.test(newLabel)) {
                                    newLabel = newLabel
                                        .replace(/^varsayılan(\s*[-:]?\s*)/i, 'Default$1')
                                        .replace(/\bVarsayılan\b/g, 'Default')
                                        .replace(/\(Varsayılan\)/gi, '(Default)')
                                        .replace(/\bDahili Ses\b/gi, 'Built-in Audio');
                                }
                            }
                            if (newLabel !== d.label) {
                                return new Proxy(d, {
                                    get: function(target, prop) {
                                        if (prop === 'label') return newLabel;
                                        var val = target[prop];
                                        if (typeof val === 'function') return val.bind(target);
                                        return val;
                                    }
                                });
                            }
                        }
                        return d;
                    });
                };
            }

            // 2. Replacements dictionary (Forward & Reverse)
            var rawRules = ${JSON.stringify(translationRules)};
            var rules = rawRules.map(function(r) {
                return { regex: new RegExp(r.pattern, r.flags || 'i'), replace: r.replace };
            });

            var rawReverseRules = ${JSON.stringify(reverseTranslationRules)};
            var reverseRules = rawReverseRules.map(function(r) {
                return { regex: new RegExp(r.pattern, r.flags || 'i'), replace: r.replace };
            });

            function translateStr(str) {
                if (!str || typeof str !== 'string') return str;
                var res = str;
                for (var i = 0; i < rules.length; i++) {
                    res = res.replace(rules[i].regex, rules[i].replace);
                }
                return res;
            }

            function revertStr(str) {
                if (!str || typeof str !== 'string') return str;
                var res = str;
                for (var i = 0; i < reverseRules.length; i++) {
                    res = res.replace(reverseRules[i].regex, reverseRules[i].replace);
                }
                return res;
            }

            function translateNode(node) {
                if (!node) return;
                if (node.nodeType === Node.TEXT_NODE) {
                    var val = node.nodeValue;
                    if (val && val.trim()) {
                        if (typeof node.__origVal === 'undefined') {
                            node.__origVal = val;
                        }
                        var trans = translateStr(node.__origVal);
                        if (trans !== node.nodeValue) {
                            node.__lastSetTrans = trans;
                            node.nodeValue = trans;
                        }
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;

                    if (node.tagName === 'OPTION') {
                        if (typeof node.__origText === 'undefined') {
                            node.__origText = node.text;
                        }
                        if (node.__origText) {
                            var transOpt = translateStr(node.__origText);
                            if (transOpt !== node.text) {
                                node.__lastSetText = transOpt;
                                node.text = transOpt;
                            }
                        }
                        if (typeof node.__origLabel === 'undefined') {
                            node.__origLabel = node.label;
                        }
                        if (node.__origLabel) {
                            var transLbl = translateStr(node.__origLabel);
                            if (transLbl !== node.label) {
                                node.__lastSetLabel = transLbl;
                                node.label = transLbl;
                            }
                        }
                    }

                    if (node.placeholder) {
                        if (typeof node.__origPh === 'undefined') {
                            node.__origPh = node.placeholder;
                        }
                        var transPh = translateStr(node.__origPh);
                        if (transPh !== node.placeholder) {
                            node.__lastSetPh = transPh;
                            node.placeholder = transPh;
                        }
                    }

                    if (node.title) {
                        if (typeof node.__origTitle === 'undefined') {
                            node.__origTitle = node.title;
                        }
                        var transTitle = translateStr(node.__origTitle);
                        if (transTitle !== node.title) {
                            node.__lastSetTitle = transTitle;
                            node.title = transTitle;
                        }
                    }

                    if (node.getAttribute && node.getAttribute('aria-label')) {
                        if (typeof node.__origAria === 'undefined') {
                            node.__origAria = node.getAttribute('aria-label');
                        }
                        var transAria = translateStr(node.__origAria);
                        if (transAria !== node.getAttribute('aria-label')) {
                            node.__lastSetAria = transAria;
                            node.setAttribute('aria-label', transAria);
                        }
                    }

                    if (node.getAttribute && node.getAttribute('aria-description')) {
                        if (typeof node.__origDesc === 'undefined') {
                            node.__origDesc = node.getAttribute('aria-description');
                        }
                        var transDesc = translateStr(node.__origDesc);
                        if (transDesc !== node.getAttribute('aria-description')) {
                            node.__lastSetDesc = transDesc;
                            node.setAttribute('aria-description', transDesc);
                        }
                    }

                    if (node.getAttribute && node.getAttribute('data-tooltip')) {
                        if (typeof node.__origDt === 'undefined') {
                            node.__origDt = node.getAttribute('data-tooltip');
                        }
                        var transDt = translateStr(node.__origDt);
                        if (transDt !== node.getAttribute('data-tooltip')) {
                            node.__lastSetDt = transDt;
                            node.setAttribute('data-tooltip', transDt);
                        }
                    }

                    if (node.value && typeof node.value === 'string' && node.tagName === 'INPUT' && (node.type === 'button' || node.type === 'submit')) {
                        if (typeof node.__origValBtn === 'undefined') {
                            node.__origValBtn = node.value;
                        }
                        var valBtn = translateStr(node.__origValBtn);
                        if (valBtn !== node.value) {
                            node.__lastSetValBtn = valBtn;
                            node.value = valBtn;
                        }
                    }

                    var child = node.firstChild;
                    while (child) {
                        translateNode(child);
                        child = child.nextSibling;
                    }
                }
            }

            function revertNode(node) {
                if (!node) return;
                if (node.nodeType === Node.TEXT_NODE) {
                    var cur = node.nodeValue;
                    if (typeof node.__origVal !== 'undefined') {
                        if (node.nodeValue !== node.__origVal) {
                            node.__lastSetRev = node.__origVal;
                            node.nodeValue = node.__origVal;
                        }
                    } else if (cur && cur.trim()) {
                        var rev = revertStr(cur);
                        if (rev !== cur) {
                            node.__lastSetRev = rev;
                            node.nodeValue = rev;
                        }
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;

                    if (node.tagName === 'OPTION') {
                        if (typeof node.__origText !== 'undefined') {
                            if (node.text !== node.__origText) {
                                node.text = node.__origText;
                            }
                        } else if (node.text) {
                            var revOpt = revertStr(node.text);
                            if (revOpt !== node.text) {
                                node.text = revOpt;
                            }
                        }
                        if (typeof node.__origLabel !== 'undefined') {
                            if (node.label !== node.__origLabel) {
                                node.label = node.__origLabel;
                            }
                        } else if (node.label) {
                            var revLbl = revertStr(node.label);
                            if (revLbl !== node.label) {
                                node.label = revLbl;
                            }
                        }
                    }

                    if (node.placeholder) {
                        if (typeof node.__origPh !== 'undefined') {
                            if (node.placeholder !== node.__origPh) {
                                node.placeholder = node.__origPh;
                            }
                        } else {
                            var revPh = revertStr(node.placeholder);
                            if (revPh !== node.placeholder) {
                                node.placeholder = revPh;
                            }
                        }
                    }

                    if (node.title) {
                        if (typeof node.__origTitle !== 'undefined') {
                            if (node.title !== node.__origTitle) {
                                node.title = node.__origTitle;
                            }
                        } else {
                            var revTitle = revertStr(node.title);
                            if (revTitle !== node.title) {
                                node.title = revTitle;
                            }
                        }
                    }

                    if (node.getAttribute && node.getAttribute('aria-label')) {
                        if (typeof node.__origAria !== 'undefined') {
                            if (node.getAttribute('aria-label') !== node.__origAria) {
                                node.setAttribute('aria-label', node.__origAria);
                            }
                        } else {
                            var curAria = node.getAttribute('aria-label');
                            var revAria = revertStr(curAria);
                            if (revAria !== curAria) {
                                node.setAttribute('aria-label', revAria);
                            }
                        }
                    }

                    if (node.getAttribute && node.getAttribute('aria-description')) {
                        if (typeof node.__origDesc !== 'undefined') {
                            if (node.getAttribute('aria-description') !== node.__origDesc) {
                                node.setAttribute('aria-description', node.__origDesc);
                            }
                        } else {
                            var curDesc = node.getAttribute('aria-description');
                            var revDesc = revertStr(curDesc);
                            if (revDesc !== curDesc) {
                                node.setAttribute('aria-description', revDesc);
                            }
                        }
                    }

                    if (node.getAttribute && node.getAttribute('data-tooltip')) {
                        if (typeof node.__origDt !== 'undefined') {
                            if (node.getAttribute('data-tooltip') !== node.__origDt) {
                                node.setAttribute('data-tooltip', node.__origDt);
                            }
                        } else {
                            var curDt = node.getAttribute('data-tooltip');
                            var revDt = revertStr(curDt);
                            if (revDt !== curDt) {
                                node.setAttribute('data-tooltip', revDt);
                            }
                        }
                    }

                    if (node.value && typeof node.value === 'string' && node.tagName === 'INPUT' && (node.type === 'button' || node.type === 'submit')) {
                        if (typeof node.__origValBtn !== 'undefined') {
                            if (node.value !== node.__origValBtn) {
                                node.value = node.__origValBtn;
                            }
                        } else {
                            var revValBtn = revertStr(node.value);
                            if (revValBtn !== node.value) {
                                node.value = revValBtn;
                            }
                        }
                    }

                    var child = node.firstChild;
                    while (child) {
                        revertNode(child);
                        child = child.nextSibling;
                    }
                }
            }

            function initObserver() {
                if (!document.body) return;
                if (isTurkish()) {
                    injectI18nResources();
                    translateNode(document.body);
                } else {
                    revertNode(document.body);
                }

                // Listen for language changes on <html lang="...">
                if (document.documentElement) {
                    var htmlObserver = new MutationObserver(function(mutations) {
                        for (var i = 0; i < mutations.length; i++) {
                            if (mutations[i].attributeName === 'lang') {
                                if (isTurkish()) {
                                    injectI18nResources();
                                    translateNode(document.body);
                                } else {
                                    revertNode(document.body);
                                }
                            }
                        }
                    });
                    htmlObserver.observe(document.documentElement, {
                        attributes: true,
                        attributeFilter: ['lang']
                    });
                }

                try {
                    if (window.i18next && window.i18next.on) {
                        window.i18next.on('languageChanged', function(lng) {
                            if (lng && lng.toLowerCase().startsWith('tr')) {
                                injectI18nResources();
                                translateNode(document.body);
                            } else {
                                revertNode(document.body);
                            }
                        });
                    }
                } catch(e) {}

                try {
                    if (window.APP && window.APP.store && window.APP.store.subscribe) {
                        var lastLang = null;
                        window.APP.store.subscribe(function() {
                            try {
                                var state = window.APP.store.getState();
                                var lang = state && state['features/base/i18n'] && state['features/base/i18n'].language;
                                if (lang && lang !== lastLang) {
                                    lastLang = lang;
                                    if (lang.toLowerCase().startsWith('tr')) {
                                        injectI18nResources();
                                        translateNode(document.body);
                                    } else {
                                        revertNode(document.body);
                                    }
                                }
                            } catch(e) {}
                        });
                    }
                } catch(e) {}

                var observer = new MutationObserver(function(mutations) {
                    var tr = isTurkish();
                    for (var i = 0; i < mutations.length; i++) {
                        var mutation = mutations[i];
                        if (mutation.type === 'childList') {
                            for (var j = 0; j < mutation.addedNodes.length; j++) {
                                var added = mutation.addedNodes[j];
                                if (tr) {
                                    translateNode(added);
                                } else {
                                    revertNode(added);
                                }
                            }
                        } else if (mutation.type === 'characterData') {
                            var targetNode = mutation.target;
                            if (tr) {
                                if (targetNode.nodeValue === targetNode.__lastSetTrans) continue;
                                targetNode.__origVal = targetNode.nodeValue;
                                var val = targetNode.nodeValue;
                                if (val && val.trim()) {
                                    var trans = translateStr(val);
                                    if (trans !== val) {
                                        targetNode.__lastSetTrans = trans;
                                        targetNode.nodeValue = trans;
                                    }
                                }
                            } else {
                                if (targetNode.nodeValue === targetNode.__lastSetRev) continue;
                                if (typeof targetNode.__origVal !== 'undefined') {
                                    if (targetNode.nodeValue !== targetNode.__origVal) {
                                        targetNode.__lastSetRev = targetNode.__origVal;
                                        targetNode.nodeValue = targetNode.__origVal;
                                    }
                                } else if (targetNode.nodeValue && targetNode.nodeValue.trim()) {
                                    var rev = revertStr(targetNode.nodeValue);
                                    if (rev !== targetNode.nodeValue) {
                                        targetNode.__lastSetRev = rev;
                                        targetNode.nodeValue = rev;
                                    }
                                }
                            }
                        } else if (mutation.type === 'attributes') {
                            var targetEl = mutation.target;
                            if (targetEl.nodeType === Node.ELEMENT_NODE) {
                                var attr = mutation.attributeName;
                                if (attr === 'placeholder') {
                                    if (tr) {
                                        if (targetEl.placeholder === targetEl.__lastSetPh) continue;
                                        targetEl.__origPh = targetEl.placeholder;
                                        var tPh = translateStr(targetEl.placeholder);
                                        if (tPh !== targetEl.placeholder) {
                                            targetEl.__lastSetPh = tPh;
                                            targetEl.placeholder = tPh;
                                        }
                                    } else {
                                        if (typeof targetEl.__origPh !== 'undefined') {
                                            if (targetEl.placeholder !== targetEl.__origPh) targetEl.placeholder = targetEl.__origPh;
                                        } else if (targetEl.placeholder) {
                                            targetEl.placeholder = revertStr(targetEl.placeholder);
                                        }
                                    }
                                } else if (attr === 'aria-label') {
                                    var curAria = targetEl.getAttribute('aria-label');
                                    if (tr) {
                                        if (curAria === targetEl.__lastSetAria) continue;
                                        targetEl.__origAria = curAria;
                                        if (curAria) {
                                            var tAria = translateStr(curAria);
                                            if (tAria !== curAria) {
                                                targetEl.__lastSetAria = tAria;
                                                targetEl.setAttribute('aria-label', tAria);
                                            }
                                        }
                                    } else {
                                        if (typeof targetEl.__origAria !== 'undefined') {
                                            if (curAria !== targetEl.__origAria) targetEl.setAttribute('aria-label', targetEl.__origAria);
                                        } else if (curAria) {
                                            var rAria = revertStr(curAria);
                                            if (rAria !== curAria) targetEl.setAttribute('aria-label', rAria);
                                        }
                                    }
                                } else if (attr === 'title') {
                                    if (tr) {
                                        if (targetEl.title === targetEl.__lastSetTitle) continue;
                                        targetEl.__origTitle = targetEl.title;
                                        var tTtl = translateStr(targetEl.title);
                                        if (tTtl !== targetEl.title) {
                                            targetEl.__lastSetTitle = tTtl;
                                            targetEl.title = tTtl;
                                        }
                                    } else {
                                        if (typeof targetEl.__origTitle !== 'undefined') {
                                            if (targetEl.title !== targetEl.__origTitle) targetEl.title = targetEl.__origTitle;
                                        } else if (targetEl.title) {
                                            targetEl.title = revertStr(targetEl.title);
                                        }
                                    }
                                } else if (attr === 'aria-description') {
                                    var curDesc = targetEl.getAttribute('aria-description');
                                    if (tr) {
                                        if (curDesc === targetEl.__lastSetDesc) continue;
                                        targetEl.__origDesc = curDesc;
                                        if (curDesc) {
                                            var tDesc = translateStr(curDesc);
                                            if (tDesc !== curDesc) {
                                                targetEl.__lastSetDesc = tDesc;
                                                targetEl.setAttribute('aria-description', tDesc);
                                            }
                                        }
                                    } else {
                                        if (typeof targetEl.__origDesc !== 'undefined') {
                                            if (curDesc !== targetEl.__origDesc) targetEl.setAttribute('aria-description', targetEl.__origDesc);
                                        } else if (curDesc) {
                                            var rDesc = revertStr(curDesc);
                                            if (rDesc !== curDesc) targetEl.setAttribute('aria-description', rDesc);
                                        }
                                    }
                                } else if (attr === 'data-tooltip') {
                                    var curDt = targetEl.getAttribute('data-tooltip');
                                    if (tr) {
                                        if (curDt === targetEl.__lastSetDt) continue;
                                        targetEl.__origDt = curDt;
                                        if (curDt) {
                                            var tDt = translateStr(curDt);
                                            if (tDt !== curDt) {
                                                targetEl.__lastSetDt = tDt;
                                                targetEl.setAttribute('data-tooltip', tDt);
                                            }
                                        }
                                    } else {
                                        if (typeof targetEl.__origDt !== 'undefined') {
                                            if (curDt !== targetEl.__origDt) targetEl.setAttribute('data-tooltip', targetEl.__origDt);
                                        } else if (curDt) {
                                            var rDt = revertStr(curDt);
                                            if (rDt !== curDt) targetEl.setAttribute('data-tooltip', rDt);
                                        }
                                    }
                                }
                            }
                        }
                    }
                });

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ['placeholder', 'aria-label', 'title', 'aria-description', 'data-tooltip']
                });
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initObserver);
            } else {
                initObserver();
            }
        })();
    `;
}

function injectIframeCustomizations(): void {
    if (!meetingWindow || meetingWindow.isDestroyed()) {
        return;
    }

    const code = `${getTouchSupportCode()}\n${getInjectionCode()}`;

    try {
        const targetFrames = meetingWindow.webContents.mainFrame.framesInSubtree
            || meetingWindow.webContents.mainFrame.frames;
        targetFrames.forEach(frame => {
            if (frame !== meetingWindow?.webContents.mainFrame) {
                frame.executeJavaScript(code)
                    .then(() => {
                        console.log(`[I18N-INJECT] Successfully injected into frame: ${frame.url}`);
                    })
                    .catch(err => {
                        console.warn(`[I18N-INJECT-WARN] Failed to inject into frame ${frame.url}:`, err.message);
                    });
            }
        });
    } catch (err) {
        console.warn('Failed to inject touch support, watermark CSS and translations', err);
    }
}

ipcMain.on('conference-frame-ready', () => {
    injectIframeCustomizations();
});

/**
 * Open the meeting in Window 2.
 * If a meeting window already exists, focus it and navigate to the new conference.
 * Otherwise create a new one.
 */
ipcMain.on('open-meeting-window', (event, conference) => {
    if (meetingWindow) {
        meetingWindow.focus();
        meetingWindow.webContents.send('navigate-to-conference', conference);
        injectIframeCustomizations();

        return;
    }

    const basePath = isDev ? rootDir : app.getAppPath();

    registerMeetingProtocol(basePath);

    const meetingURL = `${MEETING_SCHEME}://${MEETING_HOST}/meeting.html`;

    const windowOpenHandler = ({ url, frameName }: { frameName: string; url: string; }) => {
        const target = getPopupTarget(url, frameName);

        if (!target || target === 'browser') {
            openExternalLink(url);

            return { action: 'deny' };
        }

        if (target === 'electron') {
            return { action: 'allow' };
        }

        return { action: 'deny' };
    };

    const zoomFactor = getZoomFactor();

    meetingWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        icon: path.resolve(basePath, './resources/icon.png'),
        resizable: true,
        show: false,
        webPreferences: {
            enableBlinkFeatures: 'WebAssemblyCSP',
            contextIsolation: true,
            nodeIntegration: false,
            devTools: devToolsEnabled,
            preload: path.resolve(basePath, './build/preload.js'),
            sandbox: true,
            zoomFactor
        }
    });

    meetingWindow.loadURL(meetingURL);

    if (zoomFactor !== 1.0) {
        meetingWindow.webContents.on('did-finish-load', () => {
            meetingWindow?.webContents.setZoomFactor(zoomFactor);
        });
    }

    meetingWindow.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
        if (!isMainFrame) {
            injectIframeCustomizations();
        }
    });

    meetingWindow.webContents.on('did-frame-navigate', (e, url, httpResponseCode, httpStatusText, isMainFrame) => {
        if (!isMainFrame) {
            injectIframeCustomizations();
        }
    });

    meetingWindow.webContents.on('did-navigate-in-page', () => {
        injectIframeCustomizations();
    });

    // Schedule retries during initial startup so that slow loading frames are guaranteed to be injected
    [ 500, 1000, 1500, 2000, 3000, 5000, 8000, 12000 ].forEach(delay => {
        setTimeout(() => {
            injectIframeCustomizations();
        }, delay);
    });

    meetingWindow.webContents.once('did-finish-load', () => {
        meetingWindow?.webContents.send('navigate-to-conference', conference);
    });

    // SDK setup — these need the window that hosts the conference iframe.
    initPopupsConfigurationMain(meetingWindow, windowOpenHandler);
    setupPictureInPictureMain(meetingWindow);
    setupPowerMonitorMain(meetingWindow);
    setupScreenSharingMain(meetingWindow, config.appName, pkgJson.build.appId);
    setupRemoteControlMain(meetingWindow, { requestConsent: requestRemoteControlConsent });

    // Block redirects — same protection as the launcher window.
    meetingWindow.webContents.addListener('will-redirect', (ev, url) => {
        const allowedProtocols = [ 'http:', 'https:', 'ws:', 'wss:' ];
        const requestedUrl = new URL.URL(url);

        if (!allowedProtocols.includes(requestedUrl.protocol)) {
            console.warn(`Disallowing redirect to ${url}`);
            ev.preventDefault();
        }
    });

    // Closing the meeting window must NOT quit the app — launcher stays open.
    meetingWindow.on('closed', () => {
        meetingWindow = null;
        if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.close();
        }
    });

    meetingWindow.once('ready-to-show', () => {
        meetingWindow?.show();
        setTimeout(() => meetingWindow?.maximize(), 100);
    });
});

/**
 * Close the meeting window — called by renderer when End Call is clicked.
 */
ipcMain.on('close-meeting-window', () => {
    if (meetingWindow) {
        meetingWindow.close();
    }
});
