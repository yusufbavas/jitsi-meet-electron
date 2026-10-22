interface IMiniPipApi {
    executeCommand: (command: string) => void;
    isAudioMuted: () => Promise<boolean>;
    isVideoMuted: () => Promise<boolean>;
    on: (event: string, listener: (...args: any[]) => void) => unknown;
    removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
}

interface IMiniPipState {
    audioMuted: boolean | null;
    videoMuted: boolean | null;
}

/**
 * Routes the small video window's controls to this meeting and keeps their
 * mute indicators in sync with changes made elsewhere in the meeting.
 *
 * @param {Object} api - The meeting's iframe API.
 * @returns {Function} Removes this meeting's listeners and closes its popup.
 */
export function setupMiniPipRenderer(api: IMiniPipApi): () => void {
    const { ipc } = window.jitsiElectronApp;
    const state: IMiniPipState = { audioMuted: null, videoMuted: null };
    const revisions = { audioMuted: 0, videoMuted: 0 };
    let disposed = false;

    const publishState = () => {
        if (!disposed) {
            ipc.send('mini-pip-state', { ...state });
        }
    };

    // Queries can complete after a mute event, a newer query, or disposal. A
    // revision for each field prevents those responses from restoring old state.
    const refreshField = async (field: keyof IMiniPipState, query: () => Promise<boolean>) => {
        const revision = ++revisions[field];

        try {
            const muted = await query();

            if (!disposed && revision === revisions[field] && typeof muted === 'boolean') {
                state[field] = muted;
                publishState();
            }
        } catch {
            // The iframe may be joining or shutting down. Keep the last known
            // state until a later query or a mute event supplies an answer.
        }
    };

    const refreshState = () => {
        if (!disposed) {
            publishState();
            void refreshField('audioMuted', () => api.isAudioMuted());
            void refreshField('videoMuted', () => api.isVideoMuted());
        }
    };

    const updateMuteState = (field: keyof IMiniPipState, event: { muted?: unknown; } | undefined) => {
        if (!disposed && typeof event?.muted === 'boolean') {
            ++revisions[field];
            state[field] = event.muted;
            publishState();
        }
    };
    const onAudioMuteChanged = (event: { muted?: unknown; } | undefined) => updateMuteState('audioMuted', event);
    const onVideoMuteChanged = (event: { muted?: unknown; } | undefined) => updateMuteState('videoMuted', event);
    const removeActionListener = ipc.addListener('mini-pip-action', (action: unknown) => {
        if (!disposed && (action === 'toggleAudio' || action === 'toggleVideo' || action === 'hangup')) {
            api.executeCommand(action);
        }
    });
    const removeStateListener = ipc.addListener('mini-pip-state-request', refreshState);

    api.on('audioMuteStatusChanged', onAudioMuteChanged);
    api.on('videoMuteStatusChanged', onVideoMuteChanged);
    api.on('videoConferenceJoined', refreshState);
    refreshState();

    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        removeActionListener?.();
        removeStateListener?.();
        api.removeListener('audioMuteStatusChanged', onAudioMuteChanged);
        api.removeListener('videoMuteStatusChanged', onVideoMuteChanged);
        api.removeListener('videoConferenceJoined', refreshState);
        ipc.send('mini-pip-dispose');
    };
}
