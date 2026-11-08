// <cam-player>: go2rtc's VideoRTC player, plus a watchdog.
//
// On its own, VideoRTC reconnects only when its WebSocket closes. When the
// camera feed dies (e.g. the NVR returns EOF), go2rtc sends an "error" message
// and the socket stays open, and a WebRTC session can stay "connected" after
// frames stop. Either way the stock player shows a black or frozen picture
// until someone reloads. This element watches for decoded frames and tears the
// connection down and rebuilds it, with backoff, whenever they stop.
import {VideoRTC} from '/video-rtc.js';

const STALL_MS = 8000;      // no new frame for this long = stalled
const CHECK_MS = 2000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

class CamPlayer extends VideoRTC {
    constructor() {
        super();
        this.mode = 'webrtc,mse';
        this.media = 'video';
        this.RECONNECT_TIMEOUT = 5000;
        this.pcConfig = {...this.pcConfig, iceServers: []};

        this.stream = '';
        this.lastFrameTS = 0;
        this.lastFrameCount = 0;
        this.attempt = 0;
        this.retryTID = 0;
        this.watchTID = 0;
        this.status = {state: '', detail: '', mode: ''};
    }

    /** Switch to a go2rtc stream by name. Unlike setting `src`, works while connected. */
    playStream(name) {
        this.stream = name;
        this.attempt = 0;
        this.restart();
    }

    /** Tear everything down and connect again now. */
    restart() {
        clearTimeout(this.retryTID);
        this.retryTID = 0;
        if (this.reconnectTID) {
            clearTimeout(this.reconnectTID);
            this.reconnectTID = 0;
        }
        if (this.video) this.ondisconnect();
        this.lastFrameTS = 0;
        this.lastFrameCount = 0;
        if (this.stream) this.src = `/api/ws?src=${encodeURIComponent(this.stream)}`;
    }

    scheduleRetry(reason) {
        if (this.retryTID) return;
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
        this.attempt++;
        this.setStatus('retrying', `${reason}. Retrying in ${Math.round(delay / 1000)}s`);
        this.retryTID = setTimeout(() => {
            this.retryTID = 0;
            if (document.hidden) {
                // Don't stream to a sleeping screen. Waking up reconnects via connectedCallback.
                this.ondisconnect();
                return;
            }
            this.restart();
        }, delay);
    }

    setStatus(state, detail = '') {
        const mode = this.pcState === WebSocket.OPEN ? 'WebRTC' : this.mseCodecs ? 'MSE' : '';
        const s = this.status;
        if (s.state === state && s.detail === detail && s.mode === mode) return;
        this.status = {state, detail, mode};
        this.dispatchEvent(new CustomEvent('cam-status', {bubbles: true, detail: this.status}));
    }

    oninit() {
        super.oninit();
        this.video.controls = false;
        this.video.muted = true;
        this.video.autoplay = true;
        this.video.disablePictureInPicture = true;

        // Count frames as they are actually decoded. requestVideoFrameCallback
        // is the precise signal; getVideoPlaybackQuality is the fallback in watch().
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            const onFrame = () => {
                this.markFrame();
                this.video.requestVideoFrameCallback(onFrame);
            };
            this.video.requestVideoFrameCallback(onFrame);
        }

        this.watchTID = setInterval(() => this.watch(), CHECK_MS);
    }

    markFrame() {
        this.lastFrameTS = Date.now();
        this.attempt = 0;
        this.setStatus('live');
    }

    watch() {
        if (document.hidden || !this.stream || this.retryTID) return;

        const q = this.video.getVideoPlaybackQuality?.();
        if (q && q.totalVideoFrames !== this.lastFrameCount) {
            this.lastFrameCount = q.totalVideoFrames;
            this.markFrame();
        }

        const since = Date.now() - Math.max(this.lastFrameTS, this.connectTS || 0);
        if (since > STALL_MS) {
            this.scheduleRetry(this.status.state === 'live' ? 'Stream froze' : 'No video');
        }
    }

    onconnect() {
        const started = super.onconnect();
        if (started) {
            this.setStatus('connecting', this.attempt ? `Reconnecting (attempt ${this.attempt + 1})` : '');
        }
        return started;
    }

    onopen() {
        const modes = super.onopen();
        this.onmessage['watchdog'] = msg => {
            // Producer failures (NVR EOF, timeouts) come through as errors on a socket
            // that stays open. WebRTC offer errors are already handled by the base class.
            if (msg.type === 'error' && !msg.value.includes('webrtc/offer')) {
                console.warn('[cam-player]', this.stream, msg.value);
                this.scheduleRetry('Camera unavailable');
            }
        };
        return modes;
    }

    onpcvideo(video2) {
        super.onpcvideo(video2);
        this.setStatus(this.status.state, this.status.detail); // report the winning mode
    }

    connectedCallback() {
        super.connectedCallback();
        this.lastFrameTS = Date.now(); // grace period after attach or waking from sleep
    }
}

customElements.define('cam-player', CamPlayer);
