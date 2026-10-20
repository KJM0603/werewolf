// Raw camera tracks are private to this pipeline and never returned to WebRTC.
export async function createPrivateCamera({ signal, onError = () => {}, getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints) } = {}) {
  if (!globalThis.Worker || !globalThis.OffscreenCanvas || !globalThis.createImageBitmap ||
      !HTMLCanvasElement.prototype.captureStream) throw new Error('배경 가림을 지원하지 않는 브라우저입니다.');
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const context = canvas.getContext('2d', { alpha: false });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const worker = new Worker(new URL('./camera-worker.js', import.meta.url));
  let raw, stream, stopped = false, timer, watchdog, rejectWait, resolveWait;
  let starting = true;

  function cover() {
    context.fillStyle = '#202530';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    cover();
    worker.terminate();
    raw?.getTracks().forEach(track => track.stop());
    stream?.getTracks().forEach(track => track.stop());
    video.pause();
    video.srcObject = null;
    signal?.removeEventListener('abort', stop);
    rejectWait?.(new DOMException('Camera cancelled', 'AbortError'));
  }
  function fail(reason) {
    if (stopped) return;
    if (starting) {
      rejectWait?.(new Error(reason?.message || '배경 가림 처리에 실패했습니다.'));
      rejectWait = null;
    }
    stop();
    if (!starting) onError(new Error(reason?.message || reason?.type || '배경 가림 처리 시간 초과'));
  }
  function waitFor(type, timeout) {
    return new Promise((resolve, reject) => {
      rejectWait = reject;
      resolveWait = received => {
        if (received !== type) return;
        clearTimeout(watchdog);
        rejectWait = resolveWait = null;
        resolve();
      };
      watchdog = setTimeout(fail, timeout);
    });
  }
  async function nextFrame() {
    if (stopped) return;
    try {
      const frame = await createImageBitmap(video, { resizeWidth: canvas.width, resizeHeight: canvas.height });
      if (stopped) { frame.close(); return; }
      // No overlapping inference, no old mask applied to a newer camera image.
      clearTimeout(watchdog);
      watchdog = setTimeout(fail, 5000);
      worker.postMessage({ type: 'frame', frame, timestamp: performance.now() }, [frame]);
    } catch { fail(); }
  }
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }) => {
    if (stopped) { data.frame?.close(); return; }
    if (data.type === 'error') { fail(data); return; }
    if (data.type === 'frame') {
      clearTimeout(watchdog);
      context.drawImage(data.frame, 0, 0);
      data.frame.close();
      resolveWait?.('frame');
      timer = setTimeout(nextFrame, 1000 / 15);
    } else resolveWait?.(data.type);
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('Camera cancelled', 'AbortError');
    cover();
    const ready = waitFor('ready', 30000);
    worker.postMessage({ type: 'init', width: canvas.width, height: canvas.height });
    await ready;
    if (stopped) throw new DOMException('Camera cancelled', 'AbortError');
    raw = await getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } });
    if (stopped) { raw.getTracks().forEach(track => track.stop()); throw new DOMException('Camera cancelled', 'AbortError'); }
    raw.getVideoTracks().forEach(track => {
      track.addEventListener('ended', fail, { once: true });
      track.addEventListener('mute', fail, { once: true });
    });
    video.srcObject = raw;
    // play() may remain pending if the device disappears.
    const firstFrame = waitFor('frame', 10000);
    void video.play().then(() => { if (!stopped) void nextFrame(); }, fail);
    await firstFrame;
    if (stopped) throw new DOMException('Camera cancelled', 'AbortError');
    stream = canvas.captureStream(15);
    starting = false;
    return { stream, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
