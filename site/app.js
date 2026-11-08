import './player.js';

const $ = id => document.getElementById(id);
const app = $('app'), player = $('player'), rail = $('rail');

const DEFAULTS = {title: 'Cameras', thumbIntervalSec: 8, idleReturnSec: 300, dailyReloadAt: '', cameras: []};
const THUMB_TIMEOUT_MS = 10000;
const STALE_MS = 60000;
const HEALTH_MS = 15000;

let config = DEFAULTS;
let active = null;      // camera object
let hd = false;
const thumbs = new Map(); // camera id -> {el, img, age, lastOk}

// AbortSignal.timeout() is missing on older tablet browsers.
function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

async function loadConfig() {
    try {
        const res = await fetch('cameras.json', {cache: 'no-store'});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        config = {...DEFAULTS, ...await res.json()};
    } catch (e) {
        $('server-msg').textContent = `Can't load cameras.json (${e.message}). Retrying…`;
        setTimeout(() => location.reload(), 15000);
        throw e;
    }
}

// ---- camera selection ----

function select(cam, useHd = false) {
    active = cam;
    hd = useHd && !!cam.hd;
    for (const [id, t] of thumbs) t.el.classList.toggle('active', id === cam.id);
    $('active-name').textContent = cam.name;
    $('hd-btn').hidden = !cam.hd;
    $('hd-btn').setAttribute('aria-pressed', String(hd));
    player.playStream(hd ? cam.hd : cam.id);
}

function buildRail() {
    for (const cam of config.cameras) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'thumb';
        el.innerHTML = '<img alt=""><span class="thumb-label"></span><span class="thumb-age"></span>';
        el.querySelector('.thumb-label').textContent = cam.name;
        el.addEventListener('click', () => { if (cam !== active) select(cam); });
        rail.appendChild(el);
        thumbs.set(cam.id, {el, img: el.querySelector('img'), age: el.querySelector('.thumb-age'), lastOk: Date.now()});
    }
}

// ---- status overlay ----

player.addEventListener('cam-status', ev => {
    const {state, detail, mode} = ev.detail;
    $('overlay').hidden = state === 'live';
    $('overlay-text').textContent = detail || 'Connecting…';
    $('live-dot').className = 'live-dot ' + state;
    $('mode').textContent = state === 'live' ? `· LIVE${mode ? ' · ' + mode : ''}${hd ? ' · HD' : ''}` : '';
});

// ---- thumbnails: one request at a time, never overlapping ----

async function refreshThumb(cam) {
    const t = thumbs.get(cam.id);
    try {
        const res = await fetch(`/api/frame.jpeg?src=${encodeURIComponent(cam.id)}`, {
            cache: 'no-store', signal: timeout(THUMB_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        const old = t.img.src;
        t.img.src = url;
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
        t.lastOk = Date.now();
    } catch {
        // keep the last good image; staleness is shown by paintAges()
    }
}

function paintAges() {
    const now = Date.now();
    for (const t of thumbs.values()) {
        const age = t.lastOk ? now - t.lastOk : Infinity;
        const stale = age > STALE_MS;
        t.el.classList.toggle('stale', stale);
        t.age.textContent = !stale ? '' : t.lastOk ? `${Math.round(age / 60000) || 1}m old` : 'no image';
    }
}

async function thumbLoop() {
    for (;;) {
        if (!document.hidden) {
            for (const cam of config.cameras) await refreshThumb(cam);
            paintAges();
        }
        await new Promise(r => setTimeout(r, config.thumbIntervalSec * 1000));
    }
}

// ---- server health ----

async function checkHealth() {
    let ok = false;
    try {
        ok = (await fetch('/healthz', {cache: 'no-store', signal: timeout(5000)})).ok;
    } catch { /* offline */ }
    $('server-dot').classList.toggle('bad', !ok);
    $('server-msg').textContent = ok ? '' : 'Server unreachable';
}

// ---- kiosk behaviour ----

function setupIdleReturn() {
    if (!config.idleReturnSec) return;
    let tid = 0;
    const reset = () => {
        clearTimeout(tid);
        tid = setTimeout(() => {
            const home = config.cameras[0];
            if (active !== home || hd) select(home);
        }, config.idleReturnSec * 1000);
    };
    document.addEventListener('pointerdown', reset, {passive: true});
    reset();
}

function setupDailyReload() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(config.dailyReloadAt || '');
    if (!m) return;
    const next = new Date();
    next.setHours(+m[1], +m[2], 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    setTimeout(() => location.reload(), next - Date.now());
}

function tick() {
    const d = new Date();
    $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- start ----

await loadConfig();
document.title = $('title').textContent = config.title;
buildRail();

$('hd-btn').addEventListener('click', () => select(active, !hd));
$('rail-btn').addEventListener('click', () => app.classList.toggle('rail-hidden'));
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

const wanted = new URLSearchParams(location.search).get('cam');
if (config.cameras.length) select(config.cameras.find(c => c.id === wanted) || config.cameras[0]);

thumbLoop();
setInterval(paintAges, 5000);
checkHealth();
setInterval(checkHealth, HEALTH_MS);
setupIdleReturn();
setupDailyReload();
tick();
setInterval(tick, 10000);
