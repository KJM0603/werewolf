import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { personAlpha } from '../public/camera-compositor.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split('setInterval(()=>')[0];
function fixture(factory) {
  const messages = [], sent = [];
  class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  }
  const context = vm.createContext({
    document: { querySelector: () => null, querySelectorAll: () => [] },
    MediaStream, AbortController, setTimeout, clearTimeout, factory,
    record: track => sent.push(track), message: text => messages.push(text),
  });
  vm.runInContext(`${source}
    loadPrivateCamera=async()=>({createPrivateCamera:factory});
    render=()=>{};notify=message;syncPeers=()=>{};
    state.room={phase:'discussion'};
    globalThis.api={state,toggleCamera,stopCamera,syncMediaToPhase,syncLocalMediaToPeer};
  `, context);
  const f = { ...context.api, messages, sent };
  const sender = { track: null, async replaceTrack(track) { this.track = track; sent.push(track); } };
  f.state.peers.set('peer', { getTransceivers: () => [{ receiver: { track: { kind: 'video' } }, sender }] });
  return f;
}
function pipeline() {
  const track = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] }, stopped: false, stop() { this.stopped = true; track.stop(); } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('uncertain or invalid segmentation pixels remain hidden', () => {
  for (const p of [NaN, Infinity, -1, 0, 0.5, 0.7]) assert.equal(personAlpha(p), 0);
  assert.equal(personAlpha(1), 255);
  assert.ok(personAlpha(0.8) > 0 && personAlpha(0.8) < 255);
});
test('only the processed track reaches the WebRTC sender', async () => {
  const p = pipeline(), f = fixture(async () => p);
  await f.toggleCamera();
  assert.equal(f.state.videoStream, p.stream);
  assert.equal(f.sent.at(-1), p.track);
  await f.toggleCamera();
  assert.equal(f.sent.at(-1), null);
  assert.equal(p.stopped, true);
});
test('preparation failure never publishes video', async () => {
  const f = fixture(async () => { throw new Error('model unavailable'); });
  await f.toggleCamera();
  assert.equal(f.state.cameraOn, false);
  assert.equal(f.state.cameraPending, false);
  assert.equal(f.state.videoStream, null);
  assert.ok(f.sent.every(track => track === null));
});
test('cancel during preparation discards a late stream', async () => {
  const gate = deferred(), p = pipeline(), f = fixture(() => gate.promise);
  const pending = f.toggleCamera();
  await Promise.resolve();
  await f.toggleCamera();
  gate.resolve(p);
  await pending;
  assert.equal(p.stopped, true);
  assert.equal(f.state.videoStream, null);
  assert.ok(!f.sent.includes(p.track));
});
test('leaving discussion while preparing cannot enable a camera later', async () => {
  const gate = deferred(), p = pipeline(), f = fixture(() => gate.promise);
  const pending = f.toggleCamera();
  await Promise.resolve();
  f.state.room.phase = 'voting';
  f.syncMediaToPhase();
  gate.resolve(p);
  await pending;
  assert.equal(p.stopped, true);
  assert.equal(f.state.cameraOn, false);
  assert.ok(!f.sent.includes(p.track));
});
test('processing failure stops output and detaches the sender', async () => {
  let options;
  const p = pipeline(), f = fixture(async o => { options = o; return p; });
  await f.toggleCamera();
  options.onError();
  assert.equal(p.stopped, true);
  assert.equal(f.state.cameraOn, false);
  assert.equal(f.sent.at(-1), null);
});
test('pausing turns off camera without turning off the microphone preference', async () => {
  const p = pipeline(), f = fixture(async () => p);
  await f.toggleCamera();
  f.state.micOn = true;
  f.state.room.phase = 'paused';
  f.syncMediaToPhase();
  assert.equal(p.stopped, true);
  assert.equal(f.state.cameraOn, false);
  assert.equal(f.state.micOn, true);
});
test('stale pipeline callbacks cannot turn off a new camera', async () => {
  const options = [], pipelines = [pipeline(), pipeline()];
  const f = fixture(async o => { options.push(o); return pipelines[options.length - 1]; });
  await f.toggleCamera();
  await f.toggleCamera();
  await f.toggleCamera();
  options[0].onError();
  assert.equal(f.state.cameraOn, true);
  assert.equal(f.state.videoStream, pipelines[1].stream);
});

function processingFixture({ modelError = false } = {}) {
  const timers = new Map(), tracks = [], workers = [];
  let timerId = 0, captures = 0;
  const track = () => { const t = { stop() { t.stopped = true; }, addEventListener() {} }; tracks.push(t); return t; };
  const rawTrack = track(), safeTrack = track();
  const raw = { getTracks: () => [rawTrack], getVideoTracks: () => [rawTrack] };
  const output = { getTracks: () => [safeTrack] };
  class Worker {
    constructor() { workers.push(this); }
    postMessage(data) {
      queueMicrotask(() => this.onmessage?.({ data: data.type === 'init'
        ? { type: modelError ? 'error' : 'ready' }
        : { type: 'frame', frame: { close() {} } } }));
    }
    terminate() { this.stopped = true; }
  }
  const context = vm.createContext({
    Worker, OffscreenCanvas: class {}, URL, DOMException,
    HTMLCanvasElement: { prototype: { captureStream() {} } },
    document: { createElement: tag => tag === 'canvas'
      ? { getContext: () => ({ fillRect() {}, drawImage() {} }), captureStream: () => output }
      : { play: async () => {}, pause() {} } },
    performance: { now: () => 1 },
    createImageBitmap: async () => ({ close() {} }),
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const module = readFileSync(new URL('../public/camera-privacy.js', import.meta.url), 'utf8')
    .replace('export async function', 'async function')
    .replace('import.meta.url', "'http://localhost/camera-privacy.js'");
  vm.runInContext(`${module}\nglobalThis.create=createPrivateCamera;`, context);
  return { timers, tracks, workers, output, rawTrack,
    get captures() { return captures; },
    start: options => context.create({ getUserMedia: async () => { captures++; return raw; }, ...options }),
  };
}
test('first protected frame cancels startup watchdog; camera is not stopped ten seconds later', async () => {
  const f = processingFixture(), camera = await f.start();
  assert.equal(camera.stream, f.output);
  assert.equal(f.timers.size, 1);
  assert.ok([...f.timers.values()][0].ms < 100);
  camera.stop();
  assert.equal(f.timers.size, 0);
  assert.ok(f.tracks.every(t => t.stopped));
  assert.ok(f.workers.every(w => w.stopped));
});
test('model load failure does not even open the physical camera', async () => {
  const f = processingFixture({ modelError: true });
  await assert.rejects(f.start());
  assert.equal(f.captures, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(f.workers.every(w => w.stopped));
});
test('aborting a running processor releases raw and protected tracks', async () => {
  const f = processingFixture(), controller = new AbortController();
  await f.start({ signal: controller.signal });
  controller.abort();
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.timers.size, 0);
});
