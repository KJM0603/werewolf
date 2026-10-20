# Local camera segmentation assets

- Runtime: `@mediapipe/tasks-vision` **0.10.32**, from the npm package.
- Model: MediaPipe Selfie Segmenter float16 **1**.
- Model source: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
- Upstream: https://github.com/google-ai-edge/mediapipe
- License: Apache-2.0, see LICENSE.

These files are served by the game itself. Camera frames are processed in a
browser worker, not uploaded to an AI service. Keep the runtime, WASM files and
model pinned together. Both SIMD and non-SIMD runtimes are included.
