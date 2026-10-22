
import {
    initPopupsConfigurationRender,
    setupPictureInPictureRender,
    setupPowerMonitorRender,
    setupScreenSharingRender
} from '@jitsi/electron-sdk/renderer';
import React, { Component } from 'react';
import { connect } from 'react-redux';
import { Dispatch } from 'redux';

import i18n from '../../../i18n';
import { setupMiniPipRenderer } from '../../../pip/renderer';
import type { IConference, IState } from '../../../types';
import config from '../../config';
import { getSetting } from '../../settings';
import Spinner from '../../shared/components/Spinner';
import { parseURLParams } from '../../utils/parseURLParams';
import { conferenceEnded, conferenceJoined } from '../actions';
import JitsiMeetExternalAPI from '../external_api';
import { LoadingIndicator, Wrapper } from '../styled';

/**
 * The device id Chromium gives the input and output the system itself is set to.
 * It is not a fixed device: the browser re-resolves it whenever the system's own
 * choice changes, which is what makes it usable as "follow the system".
 */
const SYSTEM_DEFAULT_DEVICE_ID = 'default';

/**
 * The toolbar key of Jitsi Meet's screen share button.
 */
const SCREEN_SHARE_BUTTON = 'desktop';

interface IProps {
    _alwaysOnTopWindowEnabled?: boolean;
    _disableAGC?: boolean;
    _serverTimeout?: number;
    _serverURL?: string;
    conference: IConference;
    dispatch: Dispatch;
}

interface IConferenceState {
    isLoading: boolean;
}

/**
 * Conference component.
 */
class Conference extends Component<IProps, IConferenceState> {
    _ref = React.createRef<HTMLDivElement>();
    _api?: JitsiMeetExternalAPI;
    _conference!: { room: string; serverURL: string; };
    _iframeLoaded?: boolean;
    _disposeMiniPip?: () => void;

    /**
     * The toolbar as configured for this meeting, which the screen share button
     * is removed from and restored to as other people start and stop sharing.
     */
    _toolbarButtons: string[] = [];

    /**
     * Whether the screen share button is currently taken out of the toolbar.
     */
    _screenShareBlocked = false;

    /**
     * The local participant, known once the meeting is joined. Needed to tell our
     * own screen share apart from everybody else's.
     */
    _localParticipantId?: string;

    /**
     * Whether we are the one sharing. Tracked as well as the participant id above
     * so that neither signal arriving late can take away the button that stops
     * our own share.
     */
    _localScreenSharing = false;

    /**
     * Everyone currently sharing content, as last reported by the meeting.
     */
    _sharingParticipantIds: string[] = [];

    /**
     * Initializes a new {@code Conference} instance.
     *
     * @inheritdoc
     */
    constructor(props: IProps) {
        super(props);

        this.state = {
            isLoading: true
        };

        this._ref = React.createRef();

        this._onIframeLoad = this._onIframeLoad.bind(this);
        this._onVideoConferenceEnded = this._onVideoConferenceEnded.bind(this);
    }

    /**
     * Attach the script to this component.
     *
     * @returns {void}
     */
    componentDidMount() {
        const room = this.props.conference.room;
        const serverURL = this.props.conference.serverURL
            || this.props._serverURL
            || config.defaultServerURL;

        this._conference = {
            room,
            serverURL
        };

        this._loadConference();


    }

    /**
     * Remove conference on unmounting.
     *
     * @returns {void}
     */
    componentWillUnmount() {
        this._disposeMiniPip?.();
        this._disposeMiniPip = undefined;

        if (this._api) {
            this._api.dispose();
        }
    }

    /**
     * Handle joining another another meeing while in one.
     *
     * @param {Object} prevProps - The previous props.
     * @returns {void}
     */
    componentDidUpdate(prevProps: IProps) {
        const prevConference = prevProps.conference || {};
        const currentConference = this.props.conference || {};

        if (prevConference.room !== currentConference.room
            || prevConference.serverURL !== currentConference.serverURL) {

            // Simulate a re-mount so the new meeting is joined.
            this._iframeLoaded = false;
            this.componentWillUnmount();
            this.componentDidMount();
        }
    }

    /**
     * Implements React's {@link Component#render()}.
     *
     * @returns {ReactElement}
     */
    render() {
        return (
            <Wrapper innerRef = { this._ref }>
                {this._maybeRenderLoadingIndicator()}
            </Wrapper>
        );
    }

    /**
     * Load the conference by creating the iframe element in this component
     * and attaching utils from jitsi-meet-electron-utils.
     *
     * @returns {void}
     */
    _loadConference() {
        const appProtocolSurplus = `${config.appProtocolPrefix}://`;

        // replace the custom url with https, otherwise new URL() raises 'Invalid URL'.
        if (this._conference.serverURL.startsWith(appProtocolSurplus)) {
            this._conference.serverURL = this._conference.serverURL.replace(appProtocolSurplus, 'https://');
        }
        const url = new URL(this._conference.room, this._conference.serverURL);
        const roomName = url.pathname.split('/').pop();
        const host = this._conference.serverURL.replace(/https?:\/\//, '');
        const searchParameters = Object.fromEntries(url.searchParams);
        const hashParameters = parseURLParams(url);

        const locale = { lng: i18n.language };
        const urlParameters = {
            ...searchParameters,
            ...locale
        };


        const deviceType = (typeof window !== 'undefined' && window.jitsiElectronApp?.deviceType)
            || (typeof process !== 'undefined' ? process.env.DEVICE_TYPE : undefined);

        // TITLE replaces the room name on screen only; the room that is joined
        // stays the one from the URL.
        const title = (typeof window !== 'undefined' && window.jitsiElectronApp?.title)
            || (typeof process !== 'undefined' ? process.env.TITLE : undefined);

        const configOverwrite: Record<string, any> = {
            // No language is forced on the meeting, so that one chosen in
            // settings is remembered.
            //
            // Jitsi Meet picks a language in this order: the lang URL parameter,
            // then what the person chose, then the system's language, then the
            // deployment's default. Neither lang nor defaultLanguage is passed
            // from here, because both end up in that first slot — the iframe API
            // turns defaultLanguage into the lang parameter — and anything in it
            // wins on every launch, leaving a chosen language unable to stick.
            //
            // What is left is the system's language as the default, which a
            // choice in settings then overrides for good.
            enableCalendarIntegration: false,
            disableAGC: this.props._disableAGC,

            // Takes away the smiley picker in the chat composer, and the reaction
            // menu the raise hand button otherwise carries — with reactions off it
            // falls back to a plain raise hand button. The moderation flag drops
            // the "mute reaction sounds for everyone" checkbox from the settings
            // dialog, which disableReactions leaves behind on its own.
            disableChatSmileys: true,
            disableReactions: true,
            disableReactionsModeration: true,
            disableVirtualBackground: true,
            disableRemoteControl: true,
            remoteControl: {
                enabled: false
            },
            subject: title || roomName,
            prejoinConfig: {
                enabled: true
            },
            hiddenPremeetingButtons: [ 'invite' ],
            hideEmailInSettings: true,
            readOnlyName: true,
            toolbarButtons: [
                'camera',
                'chat',
                'closedcaptions',
                ...(deviceType !== 'M5' ? [ 'desktop' ] : []),
                'download',
                // 'embedmeeting',
                'etherpad',
                'feedback',
                'filmstrip',
                'fullscreen',
                'hangup',
                'help',
                // 'invite',
                'livestreaming',
                'microphone',
                'mute-everyone',
                'mute-video-everyone',
                'participants-pane',
                'profile',
                'raisehand',
                'recording',
                // 'security',
                'select-background',
                'settings',
                // 'shareaudio',
                // 'sharedvideo',
                // 'shortcuts',
                'stats',
                'tileview',
                'toggle-camera',
                'videoquality',
                'add-passcode'
            ]
        };

        // Kept so the screen share button can be taken out of this list and put
        // back while the meeting runs, see _updateScreenShareAvailability. The
        // rest is reset here too, because joining another meeting reuses this
        // component rather than mounting a new one.
        this._toolbarButtons = configOverwrite.toolbarButtons;
        this._screenShareBlocked = false;
        this._localScreenSharing = false;
        this._sharingParticipantIds = [];
        this._localParticipantId = undefined;

        const interfaceConfigOverwrite = {
            SHOW_CHROME_EXTENSION_BANNER: false
        };
        let jwt;
        if (searchParameters.jwt) {
            jwt = searchParameters.jwt;
        }

        Object.entries(hashParameters).forEach(([ key, value ]) => {
            if (key.startsWith('config.')) {
                const configKey = key.substring('config.'.length);

                configOverwrite[configKey] = value;
            } else if (key === 'jwt') {
                jwt = value;
            }
        });

        let isModerator = false;
        if (jwt) {
            try {
                const base64Url = jwt.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
                const payload = JSON.parse(jsonPayload);
                if (payload.context && payload.context.user && payload.context.user.moderator === true) {
                    isModerator = true;
                }
            } catch (e) {
                console.error('Failed to parse JWT', e);
            }
        }

        if (!isModerator) {
            configOverwrite.toolbarButtons = configOverwrite.toolbarButtons.filter((btn: string) => btn !== 'invite');
            configOverwrite.disableInviteFunctions = true;
        }

        const options = {
            configOverwrite,
            interfaceConfigOverwrite,
            jwt,
            parentNode: this._ref.current,
            roomName,
            sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-downloads'
        };

        this._api = new JitsiMeetExternalAPI(host, {
            ...options,
            ...urlParameters
        });

        // This event is fired really early, at the same time as 'ready', but has been
        // around for longer.
        // TODO: remove after a while. -saghul
        this._api.on('browserSupport', () => {
            this._onIframeLoad();
            window.jitsiElectronApp?.ipc?.send('conference-frame-ready');
        });

        this._api.on('suspendDetected', this._onVideoConferenceEnded);
        this._api.on('readyToClose', this._onVideoConferenceEnded);
        this._api.on('videoConferenceJoined',
            ({ id }: { id?: string; }) => {
                this._localParticipantId = id;
                this.props.dispatch(conferenceJoined(this._conference));
                window.jitsiElectronApp?.ipc?.send('conference-frame-ready');
                this._useSystemDefaultAudioDevices();
            }
        );

        this._api.on('contentSharingParticipantsChanged',
            ({ data }: { data?: string[]; }) => {
                this._sharingParticipantIds = Array.isArray(data) ? data : [];
                this._updateScreenShareAvailability();
            }
        );

        this._api.on('screenSharingStatusChanged',
            ({ on }: { on?: boolean; }) => {
                this._localScreenSharing = Boolean(on);
                this._updateScreenShareAvailability();
            }
        );

        // Notify frame readiness with periodic retries
        [ 500, 1500, 3000, 5000 ].forEach(delay => {
            setTimeout(() => {
                window.jitsiElectronApp?.ipc?.send('conference-frame-ready');
            }, delay);
        });

        // Setup Jitsi Meet Electron SDK on this renderer. These run in the page
        // ("main world") next to the iframe API and reach the main process only
        // through the window.jitsiElectronSDK bridge installed by the SDK preload.
        initPopupsConfigurationRender(this._api);
        setupScreenSharingRender(this._api);
        if (this.props._alwaysOnTopWindowEnabled) {
            this._disposeMiniPip = setupMiniPipRenderer(this._api);
            setupPictureInPictureRender(this._api);
        }
        setupPowerMonitorRender(this._api);
    }

    /**
     * Keeps the screen share button available to one person at a time.
     *
     * Jitsi Meet lets everyone share at once and offers nothing to restrict that,
     * so the button is taken out of the toolbar for as long as somebody else is
     * sharing and put back once they stop. Our own share never counts, otherwise
     * the button that stops it would disappear with the first frame we send.
     *
     * The toolbar is changed through the {@code overwriteConfig} command rather
     * than by styling the button, because toolbar buttons carry no id or class of
     * their own — only a translated aria-label — so there is nothing stable to
     * style. A config overwrite instead makes the toolbox recompute its buttons.
     *
     * @private
     * @returns {void}
     */
    _updateScreenShareAvailability() {
        // Nothing to hide on device types whose toolbar has no screen share.
        if (!this._toolbarButtons.includes(SCREEN_SHARE_BUTTON)) {
            return;
        }

        const sharedByOthers = this._sharingParticipantIds
            .some(id => id !== this._localParticipantId);
        const blocked = sharedByOthers && !this._localScreenSharing;

        if (blocked === this._screenShareBlocked) {
            return;
        }

        this._screenShareBlocked = blocked;

        this._api?.executeCommand('overwriteConfig', {
            toolbarButtons: blocked
                ? this._toolbarButtons.filter(button => button !== SCREEN_SHARE_BUTTON)
                : this._toolbarButtons
        });
    }

    /**
     * Puts the meeting on the microphone and the speaker the system itself uses.
     *
     * The pickers for both are hidden, so a device Jitsi Meet stored in an
     * earlier session would otherwise stay selected for good — including one the
     * machine has since stopped using, or that is no longer plugged in. Selecting
     * the browser's {@code default} device instead hands that choice back to the
     * system, which keeps making it as its own default changes.
     *
     * Devices already on the default are left alone so that joining does not
     * needlessly replace a working track.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _useSystemDefaultAudioDevices() {
        const api = this._api;

        if (!api) {
            return;
        }

        try {
            const [ available, current ] = await Promise.all([
                api.getAvailableDevices(),
                api.getCurrentDevices()
            ]);

            // Not every platform offers a 'default' entry; where it is missing
            // there is nothing to follow and the browser's own pick already
            // stands.
            const canFollowSystem = (kind: 'audioInput' | 'audioOutput') =>
                (available?.[kind] ?? []).some(device => device.deviceId === SYSTEM_DEFAULT_DEVICE_ID)
                    && current?.[kind]?.deviceId !== SYSTEM_DEFAULT_DEVICE_ID;

            if (canFollowSystem('audioInput')) {
                api.setAudioInputDevice(undefined, SYSTEM_DEFAULT_DEVICE_ID);
            }

            if (canFollowSystem('audioOutput')) {
                api.setAudioOutputDevice(undefined, SYSTEM_DEFAULT_DEVICE_ID);
            }
        } catch (error) {
            console.warn('Could not put the audio devices back on the system default', error);
        }
    }

    /**
     * It renders a loading indicator, if appropriate.
     *
     * @returns {?ReactElement}
     */
    _maybeRenderLoadingIndicator() {
        if (this.state.isLoading) {
            return (
                <LoadingIndicator>
                    <Spinner size = 'large' />
                </LoadingIndicator>
            );
        }
    }

    /**
     * Dispatches conference ended and closes the meeting window (Window 2).
     *
     * @returns {void}
     * @private
     */
    _onVideoConferenceEnded() {
        this.props.dispatch(conferenceEnded(this._conference));
        window.jitsiElectronApp.ipc.send('close-meeting-window');
    }


    /**
     * Sets state of loading to false when iframe has completely loaded.
     *
     * @returns {void}
     */
    _onIframeLoad() {
        if (this._iframeLoaded) {
            // Skip spurious event after meeting close.
            return;
        }

        console.log('IFrame loaded');

        this._iframeLoaded = true;


        this.setState({
            isLoading: false
        });
    }
}

/**
 * Maps (parts of) the redux state to the React props.
 *
 * @param {Object} state - The redux state.
 * @returns {Props}
 */
function _mapStateToProps(state: IState) {
    return {
        _alwaysOnTopWindowEnabled: getSetting(state, 'alwaysOnTopWindowEnabled', true),
        _disableAGC: state.settings.disableAGC,
        _serverURL: state.settings.serverURL,
        _serverTimeout: state.settings.serverTimeout
    };
}

export default connect(_mapStateToProps)(Conference);
