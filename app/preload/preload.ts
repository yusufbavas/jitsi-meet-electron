import { install as installJitsiElectronSdk } from '@jitsi/electron-sdk/preload';
import { IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';

// Expose the SDK's own bridge (window.jitsiElectronSDK, an SDK-internal detail
// the renderer helpers read) before wiring up our own bridge below.
installJitsiElectronSdk();

const whitelistedIpcChannels = [
    'protocol-data-msg',
    'renderer-ready',
    'restore-meeting-window',
    'open-meeting-window',
    'close-meeting-window',
    'navigate-to-conference',
    'conference-frame-ready',
    'mini-pip-action',
    'mini-pip-state',
    'mini-pip-state-request',
    'mini-pip-dispose'
];

ipcRenderer.setMaxListeners(0);

/**
 * Open an external URL.
 *
 * @param {string} url - The URL we with to open.
 * @returns {void}
 */
function openExternalLink(url: string): void {
    ipcRenderer.send('jitsi-open-url', url);
}

// The Jitsi Meet SDK exposes its own bridge (window.jitsiElectronSDK) via the
// side-effect import above. This is the app's own, separate bridge; it only
// carries cloneable data plus callbacks (listeners and the unsubscribe they
// return), which contextBridge supports, so it works under contextIsolation.
contextBridge.exposeInMainWorld('jitsiElectronApp', {
    deviceType: process.env.DEVICE_TYPE,
    title: process.env.TITLE,
    zoomLevel: process.env.ZOOM_LEVEL,
    openExternalLink,
    ipc: {
        addListener: (channel: string, listener: (...args: any[]) => void) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }

            const cb = (_event: IpcRendererEvent, ...args: any[]) => {
                listener(...args);
            };

            const remove = () => {
                ipcRenderer.removeListener(channel, cb);
            };

            ipcRenderer.addListener(channel, cb);

            return remove;
        },
        send: (channel: string, ...args: any[]) => {
            if (!whitelistedIpcChannels.includes(channel)) {
                return;
            }

            ipcRenderer.send(channel, ...args);
        }
    }
});

try {
    contextBridge.exposeInMainWorld('process', {
        env: {
            DEVICE_TYPE: process.env.DEVICE_TYPE,
            TITLE: process.env.TITLE,
            ZOOM_LEVEL: process.env.ZOOM_LEVEL
        }
    });
} catch {
    // Non-fatal if process is already registered or cannot be exposed.
}
