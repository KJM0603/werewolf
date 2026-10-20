// A classic worker is intentional: MediaPipe's WASM loader uses importScripts.
let segmenter;
let compositor;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const [{ FilesetResolver, ImageSegmenter }, { createCompositor }] = await Promise.all([
        import('./vendor/mediapipe/vision_bundle.js'),
        import('./camera-compositor.js'),
      ]);
      const root = new URL('./vendor/mediapipe/', self.location.href);
      const files = await FilesetResolver.forVisionTasks(new URL('wasm', root).href);
      segmenter = await ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: new URL('selfie_segmenter.tflite', root).href, delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      compositor = createCompositor(data.width, data.height);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        segmenter.segmentForVideo(data.frame, data.timestamp, result => {
          // This pinned selfie model has one confidence channel: person.
          if (result.confidenceMasks?.length !== 1) throw new Error('Missing person mask');
          const frame = compositor.compose(data.frame, result.confidenceMasks[0]);
          self.postMessage({ type: 'frame', frame }, [frame]);
        });
      } finally {
        data.frame.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error) });
  }
};
