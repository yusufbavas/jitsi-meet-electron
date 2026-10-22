import { contextBridge, ipcRenderer } from 'electron';

const actions = new Set([ 'ready', 'return', 'close', 'toggleAudio', 'toggleVideo', 'hangup' ]);

// This popup inherits the conference origin to share its MediaStream. Expose only
// its own controls, with a second sender check in MiniPipController.
contextBridge.exposeInMainWorld('jitsiElectronApp', {
    ipc: {
        send: (channel: string, action: string) => {
            if (channel === 'mini-pip-action' && actions.has(action)) {
                ipcRenderer.send(channel, action);
            }
        },
        addListener: (channel: string, listener: (state: unknown) => void) => {
            if (channel !== 'mini-pip-state') {
                return;
            }

            const callback = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);

            ipcRenderer.on(channel, callback);

            return () => ipcRenderer.removeListener(channel, callback);
        }
    }
});
