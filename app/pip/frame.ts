/**
 * Installs the mini-video adapter in the conference's own JavaScript world.
 * Everything it uses must stay inside this function: its source is evaluated
 * in a remote iframe, without this module or Node.js globals.
 *
 * @returns {void}
 */
function installMiniPip(): void {
    const frameWindow = window as Window & {
        __videoKonferansMiniPip?: boolean;
        __videoKonferansMiniPipClose?: (onlyIfClosed?: boolean) => void;
    };

    if (frameWindow.__videoKonferansMiniPip || location.href === 'about:blank') {
        return;
    }

    const nativeRequest = HTMLVideoElement.prototype.requestPictureInPicture;
    const nativeExit = document.exitPictureInPicture.bind(document);
    const nativeElement = Object.getOwnPropertyDescriptor(Document.prototype, 'pictureInPictureElement')?.get;

    interface IMiniSession {
        active: boolean;
        disposeControls?: () => void;
        facade: PictureInPictureWindow;
        onPageHide: () => void;
        ownerTimer?: number;
        popup: Window;
        preview: HTMLVideoElement;
        source: HTMLVideoElement;
        timer?: number;
        unsubscribe?: () => void;
    }

    let session: IMiniSession | undefined;
    let pending: Promise<PictureInPictureWindow> | undefined;

    const emit = (current: IMiniSession, type: string) => {
        const event = new Event(type);

        Object.defineProperty(event, 'pictureInPictureWindow', { value: current.facade });
        current.source.dispatchEvent(event);
    };

    const cleanup = (current: IMiniSession, closeWindow: boolean) => {
        if (session !== current) {
            return;
        }
        session = undefined;
        window.clearInterval(current.ownerTimer);
        current.disposeControls?.();
        if (!current.popup.closed) {
            current.popup.clearInterval(current.timer);
        }
        try {
            current.unsubscribe?.();
        } catch {
            // Forced BrowserWindow destruction can invalidate its preload
            // bridge before the opener observes that it has closed.
        }
        current.popup.removeEventListener('pagehide', current.onPageHide);
        // This is a borrowed meeting stream. Releasing the preview must never
        // stop its tracks, which are still being used by the conference.
        current.preview.srcObject = null;
        current.preview.removeAttribute('src');
        if (current.active) {
            current.active = false;
            emit(current, 'leavepictureinpicture');
        }
        if (closeWindow && !current.popup.closed) {
            current.popup.close();
        }
    };

    // Jitsi Meet's mic, camera, hangup and close glyphs (base/icons/svg,
    // Apache-2.0). Keep them inside the installer so the popup needs no assets
    // or network requests and the evaluated source has no module dependencies.
    const icons = {
        audio: '<path fill-rule="evenodd" clip-rule="evenodd" d="M12 1.5C9.51472 1.5 7.5 3.51472 7.5 6V12C7.5 14.4853 9.51472 16.5 12 16.5C14.4853 16.5 16.5 14.4853 16.5 12V6C16.5 3.51472 14.4853 1.5 12 1.5ZM15 12V6C15 4.34315 13.6569 3 12 3C10.3431 3 9 4.34315 9 6V12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12Z" /> <path d="M11.25 19.463C7.46001 19.0867 4.5 15.889 4.5 12V10.5C4.5 10.0858 4.83579 9.75 5.25 9.75C5.66421 9.75 6 10.0858 6 10.5V12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12V10.5C18 10.0858 18.3358 9.75 18.75 9.75C19.1642 9.75 19.5 10.0858 19.5 10.5V12C19.5 15.889 16.54 19.0867 12.75 19.463V21.75C12.75 22.1642 12.4142 22.5 12 22.5C11.5858 22.5 11.25 22.1642 11.25 21.75V19.463Z" />',
        audioOff: '<path fill-rule="evenodd" clip-rule="evenodd" d="M16.5 6.43934V6C16.5 3.51472 14.4853 1.5 12 1.5C9.51472 1.5 7.5 3.51472 7.5 6V12C7.5 12.9719 7.80809 13.8718 8.33194 14.6074L7.26011 15.6792C6.47031 14.6632 6 13.3865 6 12V10.5C6 10.0858 5.66421 9.75 5.25 9.75C4.83579 9.75 4.5 10.0858 4.5 10.5V12C4.5 13.801 5.13477 15.4536 6.19279 16.7465L3.21967 19.7197C2.92678 20.0126 2.92678 20.4874 3.21967 20.7803C3.51256 21.0732 3.98744 21.0732 4.28033 20.7803L20.7803 4.28033C21.0732 3.98744 21.0732 3.51256 20.7803 3.21967C20.4874 2.92678 20.0126 2.92678 19.7197 3.21967L16.5 6.43934ZM15 7.93934V6C15 4.34315 13.6569 3 12 3C10.3431 3 9 4.34315 9 6V12C9 12.5564 9.15145 13.0773 9.41536 13.524L15 7.93934Z" /> <path d="M9.79045 17.58C10.4743 17.8511 11.2198 18 12 18C15.3138 18 18 15.3137 18 12L18 10.5C18 10.0858 18.3358 9.75 18.75 9.75C19.1642 9.75 19.5 10.0858 19.5 10.5V12C19.5 15.889 16.54 19.0867 12.75 19.463V21.75C12.75 22.1642 12.4142 22.5 12 22.5C11.5858 22.5 11.25 22.1642 11.25 21.75V19.463C10.4805 19.3866 9.74523 19.1939 9.06199 18.9027C8.59675 18.7044 8.52093 18.1041 8.87854 17.7465C9.11615 17.5089 9.47805 17.4562 9.79045 17.58Z" /> <path d="M15.75 11.25C15.3358 11.25 15 11.5858 15 12C15 13.6569 13.6569 15 12 15C11.5858 15 11.25 15.3358 11.25 15.75C11.25 16.1642 11.5858 16.5 12 16.5C14.4853 16.5 16.5 14.4853 16.5 12C16.5 11.5858 16.1642 11.25 15.75 11.25Z" />',
        camera: '<path fill-rule="evenodd" clip-rule="evenodd" d="M17.25 16.2258V16.5C17.25 18.1569 15.9069 19.5 14.25 19.5H4.5C2.84315 19.5 1.5 18.1569 1.5 16.5V7.5C1.5 5.84315 2.84315 4.5 4.5 4.5H14.25C15.9069 4.5 17.25 5.84315 17.25 7.5V7.7742L20.0838 5.58813C21.0699 4.82739 22.5 5.53034 22.5 6.7758V17.2242C22.5 18.4697 21.0699 19.1726 20.0838 18.4119L17.25 16.2258ZM4.5 6H14.25C15.0784 6 15.75 6.67157 15.75 7.5V16.5C15.75 17.3284 15.0784 18 14.25 18H4.5C3.67157 18 3 17.3284 3 16.5V7.5C3 6.67157 3.67157 6 4.5 6ZM17.25 14.3313L21 17.2242V6.7758L17.25 9.66866V14.3313Z" />',
        cameraOff: '<path fill-rule="evenodd" clip-rule="evenodd" d="M20.7803 3.21967C21.0732 3.51256 21.0732 3.98744 20.7803 4.28033L17.4095 7.65114L17.4149 7.64696L15.75 9.3119V9.31066L7.06066 18H7.0619L5.5619 19.5H5.56066L4.28033 20.7803C3.98744 21.0732 3.51256 21.0732 3.21967 20.7803C2.92678 20.4874 2.92678 20.0126 3.21967 19.7197L3.5823 19.357C2.37432 18.9693 1.5 17.8368 1.5 16.5V7.5C1.5 5.84315 2.84315 4.5 4.5 4.5H14.25C15.3842 4.5 16.3714 5.12941 16.8813 6.05799L19.7197 3.21967C20.0126 2.92678 20.4874 2.92678 20.7803 3.21967ZM15.7232 7.21616C15.5905 6.52345 14.9814 6 14.25 6H4.5C3.67157 6 3 6.67157 3 7.5V16.5C3 17.3284 3.67157 18 4.5 18H4.93934L15.7232 7.21616Z" /> <path d="M21 6.75C21 6.33579 21.3358 6 21.75 6C22.1642 6 22.5 6.33579 22.5 6.75V17.2242C22.5 18.4697 21.0699 19.1726 20.0838 18.4119L17.25 16.2258V16.5C17.25 18.1569 15.9069 19.5 14.25 19.5H9C8.58579 19.5 8.25 19.1642 8.25 18.75C8.25 18.3358 8.58579 18 9 18H14.25C15.0784 18 15.75 17.3284 15.75 16.5V12C15.75 11.5858 16.0858 11.25 16.5 11.25C16.9142 11.25 17.25 11.5858 17.25 12V14.3313L21 17.2242V6.75Z" />',
        hangup: '<path fill-rule="evenodd" clip-rule="evenodd" d="M15.5354 14.2137C15.7419 15.0465 15.9228 15.4474 16.4337 15.8121C16.8922 16.1384 19.3358 16.5121 20.3023 16.4997C20.811 16.4933 21.2542 16.3621 21.6056 16.0384L21.6232 16.0217C22.4813 15.1709 22.6574 12.8488 22.3762 11.6107C22.2078 10.4059 21.3703 9.47571 19.9807 8.85603L19.7682 8.76541C16.0438 7.06296 7.96818 7.0911 4.2181 8.77268C2.73412 9.36142 1.82253 10.3345 1.61993 11.6621C1.35005 12.7299 1.50796 15.133 2.37837 16.0151C2.75243 16.3607 3.19644 16.492 3.70455 16.4986C4.66973 16.5111 7.11478 16.1372 7.57192 15.8123C8.04127 15.4779 8.23266 15.113 8.42034 14.413L8.48734 14.1503C8.61337 13.6444 8.68996 13.4979 8.88053 13.4009C10.9611 12.4505 13.0448 12.4503 15.1496 13.4114C15.3001 13.4887 15.3773 13.6153 15.4834 14.0097L15.5354 14.2137ZM7.03286 13.7836C7.09435 13.537 7.18016 13.2139 7.33129 12.9257C7.53766 12.5321 7.83388 12.2506 8.19985 12.0642L8.22827 12.0497L8.25728 12.0365C10.7362 10.9041 13.2746 10.9063 15.7726 12.0469L15.8041 12.0613L15.8348 12.0771C16.172 12.2502 16.4436 12.5087 16.6381 12.8519C16.7893 13.1187 16.8744 13.4061 16.9319 13.6203L16.9344 13.6297L16.9913 13.8528C17.0895 14.2487 17.1504 14.4019 17.1903 14.4759C17.2045 14.5022 17.2134 14.5129 17.22 14.5202C17.2232 14.5238 17.2288 14.5297 17.238 14.5381C17.2912 14.5563 17.3694 14.5801 17.4752 14.6078C17.7266 14.6735 18.0585 14.7419 18.4262 14.8037C19.1854 14.9313 19.9341 15.0043 20.2831 14.9998C20.4163 14.9981 20.4929 14.9805 20.5311 14.9675C20.5519 14.9605 20.565 14.9538 20.5751 14.9467C20.5839 14.9356 20.5993 14.9144 20.6195 14.8799C20.6539 14.8211 20.6946 14.7372 20.7367 14.6243C20.822 14.395 20.8939 14.098 20.941 13.7564C21.0381 13.0527 21.0058 12.3494 20.9135 11.9429L20.8994 11.8811L20.8906 11.8183C20.8162 11.286 20.4566 10.7133 19.3804 10.2307L19.1621 10.1377L19.1446 10.1296C17.572 9.41083 14.876 8.99573 12.005 9.00003C9.13686 9.00433 6.42584 9.42661 4.83184 10.1414L4.80183 10.1548L4.77125 10.167C3.6348 10.6178 3.20355 11.2279 3.10276 11.8884L3.09187 11.9598L3.07419 12.0297C3.00084 12.3199 2.95972 12.9826 3.05793 13.7067C3.10477 14.052 3.17689 14.3595 3.26453 14.6008C3.30774 14.7197 3.35008 14.8096 3.38676 14.8737C3.40432 14.9044 3.41869 14.9259 3.42889 14.9399C3.44732 14.9527 3.46432 14.9604 3.48327 14.967C3.51959 14.9796 3.59191 14.997 3.72377 14.9987C4.07193 15.0032 4.82076 14.9302 5.58033 14.8027C5.94817 14.7409 6.28022 14.6726 6.5317 14.607C6.63747 14.5794 6.71567 14.5557 6.76883 14.5375C6.77621 14.5308 6.78123 14.5257 6.78452 14.5222C6.79241 14.5138 6.79948 14.5051 6.80951 14.4881C6.83641 14.4425 6.88869 14.3319 6.96925 14.033L7.03286 13.7836Z" />',
        close: '<path d="M18.5303 6.53033C18.8232 6.23744 18.8232 5.76256 18.5303 5.46967C18.2374 5.17678 17.7626 5.17678 17.4697 5.46967L12 10.9393L6.53033 5.46967C6.23744 5.17678 5.76256 5.17678 5.46967 5.46967C5.17678 5.76256 5.17678 6.23744 5.46967 6.53033L10.9393 12L5.46967 17.4697C5.17678 17.7626 5.17678 18.2374 5.46967 18.5303C5.76256 18.8232 6.23744 18.8232 6.53033 18.5303L12 13.0607L17.4697 18.5303C17.7626 18.8232 18.2374 18.8232 18.5303 18.5303C18.8232 18.2374 18.8232 17.7626 18.5303 17.4697L13.0607 12L18.5303 6.53033Z" />',
        restore: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5M14 3h7v7M21 3l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    };
    const icon = (name: keyof typeof icons) => `<svg width="24" height="24" viewBox="0 0 24 24"
        fill="currentColor" aria-hidden="true" focusable="false">${icons[name]}</svg>`;

    const installControls = (popup: Window): (() => void) => {
        const popupDocument = popup.document;
        const root = popupDocument.getElementById('mini-pip') as HTMLElement;
        const heldPointers = new Set<number>();
        const revealPointers = new Set<number>();
        const listeners = new AbortController();
        const options = { capture: true, signal: listeners.signal };
        let idleTimer: number | undefined;
        let keyboardMode = false;

        const scheduleHide = () => {
            window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(() => {
                const focused = popupDocument.activeElement as HTMLElement | null;

                if (heldPointers.size || (keyboardMode && focused?.matches('button'))) {
                    return;
                }
                root.classList.add('controls-hidden');
                // Pointer focus must not keep the overlay open or leave a
                // hidden button as the keyboard's active action.
                if (focused?.matches('button')) {
                    focused.blur();
                }
            }, 2500);
        };
        const showControls = () => {
            root.classList.remove('controls-hidden');
            scheduleHide();
        };
        const hover = (event: PointerEvent) => {
            // Touch pointerenter precedes pointerdown. Revealing there would
            // let that same first tap activate a previously hidden button.
            if (event.pointerType === 'mouse') {
                showControls();
            }
        };

        // Listen only for entering the window: hiding a hovered button changes
        // the hit target and emits pointerover even when the mouse stays still.
        root.addEventListener('pointerenter', hover, { signal: listeners.signal });
        popupDocument.addEventListener('pointermove', hover, options);
        popupDocument.addEventListener('pointerdown', event => {
            keyboardMode = false;
            if (!heldPointers.size) {
                revealPointers.clear();
            }
            if (root.classList.contains('controls-hidden')) {
                revealPointers.add(event.pointerId);
            }
            heldPointers.add(event.pointerId);
            showControls();
        }, options);
        popupDocument.addEventListener('pointerup', event => {
            heldPointers.delete(event.pointerId);
            scheduleHide();
        }, options);
        popupDocument.addEventListener('pointercancel', event => {
            heldPointers.delete(event.pointerId);
            revealPointers.delete(event.pointerId);
            scheduleHide();
        }, options);
        popupDocument.addEventListener('click', event => {
            if (revealPointers.delete(event.pointerId)) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, options);
        popupDocument.addEventListener('keydown', event => {
            if (event.key === 'Tab' || popupDocument.activeElement?.matches('button')) {
                keyboardMode = true;
                // Restore the tab order before the browser moves focus.
                showControls();
            }
        }, options);
        popupDocument.addEventListener('focusin', () => {
            if (keyboardMode) {
                showControls();
            }
        }, options);
        popupDocument.addEventListener('focusout', () => {
            if (!root.classList.contains('controls-hidden')) {
                scheduleHide();
            }
        }, options);
        popup.addEventListener('blur', () => {
            heldPointers.clear();
            revealPointers.clear();
            keyboardMode = false;
            scheduleHide();
        }, { signal: listeners.signal });
        scheduleHide();

        return () => {
            window.clearTimeout(idleTimer);
            listeners.abort();
        };
    };

    const start = async (source: HTMLVideoElement): Promise<PictureInPictureWindow> => {
        const popup = window.open('about:blank', 'video-konferans-mini-pip', 'width=360,height=280');

        if (!popup || popup.closed) {
            throw new DOMException('Küçük video penceresi açılamadı.', 'NotAllowedError');
        }

        let openedSession: IMiniSession | undefined;

        try {
            const popupDocument = popup.document;

            popupDocument.title = 'Pencere içinde pencere';
            popupDocument.documentElement.lang = 'tr';
            const style = popupDocument.createElement('style');

            style.textContent = `
            * { box-sizing: border-box; }
            html, body { margin: 0; height: 100%; overflow: hidden; }
            body { color: #f5f7fa; background: #090b10; font: 14px system-ui, sans-serif; }
            #mini-pip { position: relative; height: 100%; isolation: isolate; overflow: hidden;
                touch-action: manipulation;
                border: 1px solid rgba(255,255,255,.12); border-radius: 12px; }
            #mini-pip-stage { position: absolute; inset: 0; background: #090b10; }
            #mini-pip-stage::after { content: ''; position: absolute; inset: 0; pointer-events: none;
                background: linear-gradient(180deg, rgba(0,0,0,.4), transparent 28%,
                    transparent 65%, rgba(0,0,0,.55)); transition: opacity .18s; }
            video { width: 100%; height: 100%; display: block; object-fit: cover; object-position: center; }
            header { position: absolute; z-index: 2; top: 0; left: 0; right: 0;
                display: flex; align-items: center; gap: 6px; padding: 10px; pointer-events: none; }
            .drag-region { flex: 1; min-width: 0; height: 48px; -webkit-app-region: drag;
                pointer-events: auto; }
            button { display: grid; place-items: center; flex: 0 0 48px; width: 48px; height: 48px;
                min-width: 48px; min-height: 48px; padding: 0; border: 1px solid transparent;
                border-radius: 50%; color: #f5f7fa; background: rgba(255,255,255,.1);
                cursor: pointer; touch-action: manipulation; -webkit-app-region: no-drag;
                pointer-events: auto; transition: background .15s, color .15s; }
            button svg { display: block; width: 24px; height: 24px; pointer-events: none;
                transition: transform .15s; }
            button:hover:not(:disabled) { background: rgba(255,255,255,.2); }
            button:active:not(:disabled) svg { transform: scale(.94); }
            button:focus-visible { outline: 2px solid #8ecbff; outline-offset: 3px; }
            button:disabled { opacity: .4; cursor: default; }
            .top-control { background: rgba(18,21,28,.62); border-color: rgba(255,255,255,.12);
                backdrop-filter: blur(12px); }
            .top-control:hover:not(:disabled) { background: rgba(55,61,72,.92); }
            #mini-pip-status { position: absolute; z-index: 1; inset: 0; display: grid;
                place-items: center; padding: 72px 16px 90px; color: #cbd5e1;
                text-align: center; pointer-events: none; }
            #mini-pip-status[hidden] { display: none; }
            footer { position: absolute; z-index: 2; bottom: 12px; left: 50%;
                transform: translateX(-50%); display: flex; gap: 8px; padding: 8px;
                border: 1px solid rgba(255,255,255,.12); border-radius: 36px;
                background: rgba(22,26,34,.88); backdrop-filter: blur(16px);
                box-shadow: 0 6px 24px rgba(0,0,0,.28); }
            button.is-muted { background: #f2f4f7; color: #202530; }
            button.is-muted:hover:not(:disabled) { background: #fff; }
            #mini-pip-hangup { background: #e0474f; color: #fff; }
            #mini-pip-hangup:hover:not(:disabled) { background: #f05a62; }
            header, footer { opacity: 1; visibility: visible;
                transition: opacity .18s, visibility 0s; }
            .controls-hidden header, .controls-hidden footer { opacity: 0; visibility: hidden;
                transition: opacity .18s, visibility 0s .18s; }
            .controls-hidden header, .controls-hidden footer,
            .controls-hidden button, .controls-hidden .drag-region { pointer-events: none; }
            .controls-hidden .drag-region { -webkit-app-region: no-drag; }
            .controls-hidden #mini-pip-stage::after { opacity: 0; }
            @media (prefers-reduced-motion: reduce) {
                button, button svg, header, footer, .controls-hidden header, .controls-hidden footer,
                #mini-pip-stage::after { transition: none; }
            }
        `;
            popupDocument.head.appendChild(style);
            popupDocument.body.innerHTML = `
            <main id="mini-pip">
                <div id="mini-pip-stage">
                    <video id="mini-pip-video" autoplay muted playsinline></video>
                    <span id="mini-pip-status" role="status">Video bekleniyor…</span>
                </div>
                <header aria-label="Pencere kontrolleri">
                    <span class="drag-region" aria-hidden="true"></span>
                    <button id="mini-pip-return" class="top-control" type="button"
                        aria-label="Görüşmeye geri dön" title="Görüşmeye geri dön">${icon('restore')}</button>
                    <button id="mini-pip-close" class="top-control" type="button"
                        aria-label="Küçük pencereyi kapat" title="Küçük pencereyi kapat">${icon('close')}</button>
                </header>
                <footer aria-label="Görüşme kontrolleri">
                    <button id="mini-pip-audio" type="button" disabled
                        aria-label="Mikrofon" title="Mikrofon">${icon('audio')}</button>
                    <button id="mini-pip-camera" type="button" disabled
                        aria-label="Kamera" title="Kamera">${icon('camera')}</button>
                    <button id="mini-pip-hangup" type="button" disabled
                        aria-label="Görüşmeyi bitir" title="Görüşmeyi bitir">${icon('hangup')}</button>
                </footer>
            </main>
        `;

            const preview = popupDocument.getElementById('mini-pip-video') as HTMLVideoElement;
            const status = popupDocument.getElementById('mini-pip-status') as HTMLElement;
            const audio = popupDocument.getElementById('mini-pip-audio') as HTMLButtonElement;
            const camera = popupDocument.getElementById('mini-pip-camera') as HTMLButtonElement;
            const hangup = popupDocument.getElementById('mini-pip-hangup') as HTMLButtonElement;
            const facade = new EventTarget() as PictureInPictureWindow;

            Object.defineProperties(facade, {
                width: { get: () => popup.innerWidth },
                height: { get: () => popup.innerHeight }
            });
            facade.onresize = null;
            const current: IMiniSession = {
                active: false,
                popup,
                source,
                preview,
                facade,
                onPageHide: () => cleanup(current, false)
            };

            session = current;
            openedSession = current;
            current.disposeControls = installControls(popup);
            // BrowserWindow.destroy() does not send pagehide, and the popup's own
            // timers stop with it. Keep this small lifecycle check in the opener.
            current.ownerTimer = window.setInterval(() => {
                if (popup.closed || !source.isConnected) {
                    cleanup(current, true);
                }
            }, 100);
            popup.addEventListener('pagehide', current.onPageHide);
            popup.addEventListener('resize', () => {
                const event = new Event('resize');

                facade.dispatchEvent(event);
                facade.onresize?.call(facade, event);
            });

            const syncMedia = () => {
                if (popup.closed || !source.isConnected) {
                    cleanup(current, true);

                    return;
                }
                if (preview.srcObject !== source.srcObject) {
                    preview.srcObject = source.srcObject;
                    if (source.srcObject instanceof MediaStream) {
                        source.srcObject.getVideoTracks().forEach(track => {
                        // Avatar canvas streams may publish only on change.
                        // Ask for their current frame when adding this new sink.
                            (track as MediaStreamTrack & { requestFrame?: () => void; }).requestFrame?.();
                        });
                    }
                }
                const url = source.srcObject ? '' : source.currentSrc || source.getAttribute('src') || '';

                if (preview.getAttribute('src') !== (url || null)) {
                    if (url) {
                        preview.src = url;
                    } else {
                        preview.removeAttribute('src');
                    }
                }
                preview.muted = true;
                status.hidden = preview.readyState >= 2;
                if (preview.paused && (preview.srcObject || url)) {
                    void preview.play().catch(() => {
                        status.hidden = false;
                    });
                }
            };

            // A popup has a separate preload. Wait for its restricted bridge,
            // then register the state listener before asking for a replay.
            const deadline = Date.now() + 5000;

            while (!popup.jitsiElectronApp?.ipc) {
                if (popup.closed || session !== current || Date.now() >= deadline) {
                    throw new DOMException('Küçük pencere başlatılamadı.', 'AbortError');
                }
                await new Promise(resolve => window.setTimeout(resolve, 25));
            }
            if (popup.closed || session !== current) {
                throw new DOMException('Küçük pencere kapatıldı.', 'AbortError');
            }
            const bridge = popup.jitsiElectronApp.ipc;
            const sendAction = (action: string) => bridge.send('mini-pip-action', action);

            [ [ 'mini-pip-return', 'return' ], [ 'mini-pip-close', 'close' ],
                [ 'mini-pip-audio', 'toggleAudio' ], [ 'mini-pip-camera', 'toggleVideo' ],
                [ 'mini-pip-hangup', 'hangup' ] ].forEach(([ id, action ]) => {
                popupDocument.getElementById(id)?.addEventListener('click', () => sendAction(action));
            });
            popup.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    sendAction('close');
                }
            });
            current.unsubscribe = bridge.addListener('mini-pip-state', state => {
                if (session !== current || !state || typeof state !== 'object') {
                    return;
                }
                const hasAudio = typeof state.audioMuted === 'boolean';
                const hasVideo = typeof state.videoMuted === 'boolean';

                audio.disabled = !hasAudio;
                camera.disabled = !hasVideo;
                hangup.disabled = !hasAudio && !hasVideo;
                const audioLabel = hasAudio ? state.audioMuted ? 'Mikrofonu aç' : 'Mikrofonu kapat' : 'Mikrofon';
                const cameraLabel = hasVideo ? state.videoMuted ? 'Kamerayı aç' : 'Kamerayı kapat' : 'Kamera';

                audio.innerHTML = icon(hasAudio && state.audioMuted ? 'audioOff' : 'audio');
                camera.innerHTML = icon(hasVideo && state.videoMuted ? 'cameraOff' : 'camera');
                audio.setAttribute('aria-label', audioLabel);
                camera.setAttribute('aria-label', cameraLabel);
                audio.title = audioLabel;
                camera.title = cameraLabel;
                audio.classList.toggle('is-muted', hasAudio && state.audioMuted);
                camera.classList.toggle('is-muted', hasVideo && state.videoMuted);
                audio.setAttribute('aria-pressed', String(hasAudio && !state.audioMuted));
                camera.setAttribute('aria-pressed', String(hasVideo && !state.videoMuted));
            });
            sendAction('ready');
            syncMedia();
            if (session !== current) {
                throw new DOMException('Video kaynağı kapatıldı.', 'AbortError');
            }
            current.timer = popup.setInterval(syncMedia, 100);
            current.active = true;
            emit(current, 'enterpictureinpicture');

            return facade;
        } catch (error) {
            if (openedSession) {
                cleanup(openedSession, true);
            } else if (!popup.closed) {
                popup.close();
            }
            throw error;
        }
    };

    Object.defineProperty(document, 'pictureInPictureElement', {
        configurable: true,
        get: () => session?.active ? session.source : nativeElement?.call(document) || null
    });
    document.exitPictureInPicture = () => {
        if (session) {
            cleanup(session, true);

            return Promise.resolve();
        }

        return nativeExit();
    };
    HTMLVideoElement.prototype.requestPictureInPicture = function() {
        if (this.id !== 'pipVideo' || this.ownerDocument !== document) {
            return nativeRequest.call(this);
        }
        if (pending) {
            return pending;
        }
        if (session && !session.popup.closed) {
            return Promise.resolve(session.facade);
        }
        if (session) {
            cleanup(session, false);
        }
        pending = start(this).finally(() => {
            pending = undefined;
        });

        return pending;
    };
    frameWindow.__videoKonferansMiniPipClose = (onlyIfClosed = false) => {
        // A main-process notification can arrive after another popup opens.
        // Such a notification only releases an already closed session.
        if (session && (!onlyIfClosed || session.popup.closed)) {
            cleanup(session, true);
        }
    };
    window.addEventListener('pagehide', () => frameWindow.__videoKonferansMiniPipClose?.());
    frameWindow.__videoKonferansMiniPip = true;
}

/**
 * Returns the self-contained adapter for execution in the conference frame.
 *
 * @returns {string} The installer source.
 */
export function getMiniPipFrameCode(): string {
    return `(${installMiniPip.toString()})();`;
}
