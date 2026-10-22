import { BrowserWindow, type HandlerDetails, type IpcMainEvent, type WebContents,
    type WindowOpenHandlerResponse, ipcMain } from 'electron';

import { getMiniPipFrameCode } from './frame';

const WINDOW_NAME = 'video-konferans-mini-pip';
const WINDOW_TITLE = 'Pencere içinde pencere';

interface IMiniPipState {
    audioMuted: boolean | null;
    videoMuted: boolean | null;
}

/** Owns the app's video popup and restricts its IPC to the owning meeting. */
export class MiniPipController {
    private _window?: BrowserWindow;
    private _state: IMiniPipState = { audioMuted: null, videoMuted: null };
    private _backgroundThrottling?: boolean;
    private _creating = false;
    private _creationTimer?: ReturnType<typeof setTimeout>;
    private readonly _contents: WebContents;
    private _cancelReturn?: () => void;

    /**
     * @param {BrowserWindow} owner - The window containing the conference iframe.
     * @param {string} preloadPath - The popup's restricted preload script.
     */
    constructor(private readonly owner: BrowserWindow, private readonly preloadPath: string) {
        this._contents = owner.webContents;
        owner.webContents.on('did-create-window', this._onCreated);
        owner.webContents.on('render-process-gone', this._close);
        owner.webContents.on('will-navigate', this._close);
        owner.once('closed', this._dispose);
        ipcMain.on('mini-pip-action', this._onAction);
        ipcMain.on('mini-pip-state', this._onState);
        ipcMain.on('mini-pip-dispose', this._onDisposeRequest);
        ipcMain.on('jitsi-pip-channel', this._onPipRequest);
    }

    /** The live popup, if one exists. */
    get window(): BrowserWindow | undefined {
        return this._window;
    }

    /**
     * Handles only our named, same-origin blank window; other popups retain their existing routing.
     *
     * @param {HandlerDetails} details - Electron's window.open request.
     * @returns {WindowOpenHandlerResponse|undefined}
     */
    handleWindowOpen(details: HandlerDetails): WindowOpenHandlerResponse | undefined {
        if (details.frameName !== WINDOW_NAME) {
            return;
        }

        if (details.url !== 'about:blank' || this._window || this._creating || this.owner.isDestroyed()) {
            return { action: 'deny' };
        }

        this._creating = true;
        this._creationTimer = setTimeout(() => {
            this._creating = false;
        }, 5000);

        return {
            action: 'allow',
            outlivesOpener: false,
            overrideBrowserWindowOptions: {
                title: WINDOW_TITLE,
                width: 360,
                height: 280,
                minWidth: 360,
                minHeight: 280,
                frame: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                fullscreenable: false,
                maximizable: false,
                backgroundColor: '#10141c',
                autoHideMenuBar: true,
                webPreferences: {
                    preload: this.preloadPath,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    backgroundThrottling: false,
                    devTools: false,
                    zoomFactor: 1
                }
            }
        };
    }

    private _onCreated = (popup: BrowserWindow, details: { frameName: string; }) => {
        if (details.frameName !== WINDOW_NAME) {
            return;
        }

        clearTimeout(this._creationTimer);
        this._creating = false;
        this._window = popup;
        this._backgroundThrottling = this._contents.getBackgroundThrottling();
        this._contents.setBackgroundThrottling(false);
        popup.webContents.setBackgroundThrottling(false);
        popup.webContents.setZoomFactor(1);
        // The app applies its meeting zoom to every newly loaded window. Keep
        // these fixed-size touch controls at their designed scale afterwards.
        popup.webContents.on('did-finish-load', () => popup.webContents.setZoomFactor(1));
        popup.setMenu(null);
        popup.setTitle(WINDOW_TITLE);
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        popup.webContents.on('will-navigate', event => event.preventDefault());
        popup.webContents.on('will-redirect', event => event.preventDefault());
        popup.webContents.on('page-title-updated', event => {
            event.preventDefault();
            popup.setTitle(WINDOW_TITLE);
        });
        popup.webContents.once('render-process-gone', this._close);
        popup.once('closed', () => {
            if (this._window === popup) {
                this._cancelReturn?.();
                this._window = undefined;
                this._restoreThrottling();
                void this._notifyFrameClosed();
            }
        });
    };

    private _isOwner(event: IpcMainEvent): boolean {
        return !this.owner.isDestroyed()
            && !this._contents.isDestroyed()
            && event.sender === this._contents
            && event.senderFrame === this._contents.mainFrame;
    }

    private _onPipRequest = (event: IpcMainEvent, frameName: unknown) => {
        if (!this._isOwner(event) || typeof frameName !== 'string') {
            return;
        }
        const frame = this._contents.mainFrame.frames.find(child => child.name === frameName);

        if (!frame) {
            return;
        }
        // Install before invoking Jitsi's helper, including its first request.
        // The helper owns Jitsi's pending flag and its video readiness checks.
        const code = `${getMiniPipFrameCode()}
            window.JitsiMeetJS?.app?.electron?.requestPictureInPicture?.();`;

        void frame.executeJavaScript(code, true).catch(error => {
            console.warn('Could not open the mini video window:', error.message);
        });
    };

    private _notifyFrameClosed(): Promise<unknown> {
        if (this._contents.isDestroyed()) {
            return Promise.resolve();
        }

        try {
            const mainFrame = this._contents.mainFrame;

            return Promise.allSettled(mainFrame.framesInSubtree.filter(frame => frame !== mainFrame)
                .map(async frame => frame.executeJavaScript('window.__videoKonferansMiniPipClose?.(true);')));
        } catch {
            // Its frame tree can already be gone during owner shutdown.
            return Promise.resolve();
        }
    }

    private _returnToMeeting = () => {
        const popup = this._window;

        if (!popup || popup.isDestroyed() || this.owner.isDestroyed() || this._cancelReturn) {
            return;
        }

        const finish = () => {
            if (this._window === popup) {
                this._close();
            }
        };

        // Wayland activation is asynchronous and uses the input surface.
        // Keep the clicked popup alive until the meeting receives focus.
        // A compositor that declines activation must not leave a pending
        // listener or prevent the user from closing/reopening the popup.
        const timer = setTimeout(finish, 1000);

        this._cancelReturn = () => {
            clearTimeout(timer);
            this.owner.removeListener('focus', finish);
            this._cancelReturn = undefined;
        };
        this.owner.once('focus', finish);
        if (this.owner.isMinimized()) {
            this.owner.restore();
        }
        this.owner.show();
        this.owner.focus();
        if (this.owner.isFocused()) {
            finish();
        }
    };

    private _onAction = (event: IpcMainEvent, action: unknown) => {
        const popup = this._window;

        if (!popup || popup.isDestroyed() || event.sender !== popup.webContents
                || event.senderFrame !== popup.webContents.mainFrame || this.owner.isDestroyed()) {
            return;
        }

        switch (action) {
        case 'ready':
            popup.webContents.send('mini-pip-state', this._state);
            this._contents.send('mini-pip-state-request');
            break;
        case 'return':
            this._returnToMeeting();
            break;
        case 'close':
            this._close();
            break;
        case 'toggleAudio':
        case 'toggleVideo':
        case 'hangup':
            this._contents.send('mini-pip-action', action);
            if (action === 'hangup') {
                this._close();
            }
            break;
        }
    };

    private _onState = (event: IpcMainEvent, state: unknown) => {
        if (!this._isOwner(event) || !state || typeof state !== 'object') {
            return;
        }

        const { audioMuted, videoMuted } = state as IMiniPipState;

        if ((audioMuted !== null && typeof audioMuted !== 'boolean')
                || (videoMuted !== null && typeof videoMuted !== 'boolean')) {
            return;
        }

        this._state = { audioMuted, videoMuted };
        this._window?.webContents.send('mini-pip-state', this._state);
    };

    private _onDisposeRequest = (event: IpcMainEvent) => {
        if (this._isOwner(event)) {
            this._close();
            this._state = { audioMuted: null, videoMuted: null };
        }
    };

    private _restoreThrottling(): void {
        if (!this._contents.isDestroyed()
                && this._backgroundThrottling !== undefined) {
            this._contents.setBackgroundThrottling(this._backgroundThrottling);
        }
        this._backgroundThrottling = undefined;
    }

    private _close = () => {
        this._cancelReturn?.();
        const popup = this._window;

        if (popup && !popup.isDestroyed()) {
            // The popup only renders borrowed media; it must never keep the meeting alive.
            popup.destroy();
        }
    };

    private _dispose = () => {
        clearTimeout(this._creationTimer);
        this._close();
        ipcMain.removeListener('mini-pip-action', this._onAction);
        ipcMain.removeListener('mini-pip-state', this._onState);
        ipcMain.removeListener('mini-pip-dispose', this._onDisposeRequest);
        ipcMain.removeListener('jitsi-pip-channel', this._onPipRequest);
        if (!this._contents.isDestroyed()) {
            this._contents.removeListener('did-create-window', this._onCreated);
            this._contents.removeListener('render-process-gone', this._close);
            this._contents.removeListener('will-navigate', this._close);
        }
    };
}
