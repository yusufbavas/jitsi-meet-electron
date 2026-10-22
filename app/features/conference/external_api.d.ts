/**
 * Minimal declaration for the vendored, pre-bundled {@code external_api.js}
 * (the Jitsi Meet iframe External API). Only the surface used by the
 * application is described.
 */

interface IDeviceInfo {
    deviceId: string;
    groupId?: string;
    kind?: string;
    label?: string;
}

/**
 * The devices the meeting can choose from, as returned by
 * {@code getAvailableDevices}.
 */
interface IAvailableDevices {
    audioInput?: IDeviceInfo[];
    audioOutput?: IDeviceInfo[];
    videoInput?: IDeviceInfo[];
}

/**
 * The device in use per kind, as returned by {@code getCurrentDevices}. A kind
 * is absent while its device is not known yet.
 */
interface ICurrentDevices {
    audioInput?: IDeviceInfo;
    audioOutput?: IDeviceInfo;
    videoInput?: IDeviceInfo;
}

declare class JitsiMeetExternalAPI {
    constructor(domain: string, options?: any);
    on(event: string, listener: (...args: any[]) => void): void;
    removeListener(event: string, listener: (...args: any[]) => void): void;
    dispose(): void;
    executeCommand(command: string, ...args: any[]): void;
    isAudioMuted(): Promise<boolean>;
    isVideoMuted(): Promise<boolean>;
    getAvailableDevices(): Promise<IAvailableDevices>;
    getCurrentDevices(): Promise<ICurrentDevices>;

    /**
     * Selects a device by label, or by id when no label is given.
     */
    setAudioInputDevice(label?: string, deviceId?: string): Promise<unknown>;
    setAudioOutputDevice(label?: string, deviceId?: string): Promise<unknown>;
}

export default JitsiMeetExternalAPI;
