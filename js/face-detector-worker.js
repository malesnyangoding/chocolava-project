'use strict';

let detector = null;
let visionTasks = null;

self.onmessage = async (event) => {
  const { type, bitmap, timestamp } = event.data || {};

  if (type === 'init') {
    try {
      importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.js');
      visionTasks = self.Vision;
      if (!visionTasks?.FaceLandmarker || !visionTasks?.FilesetResolver) {
        throw new Error('MediaPipe Vision exports are unavailable in the worker.');
      }

      const wasmFileset = await visionTasks.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm'
      );
      detector = await visionTasks.FaceLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
      });

      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Face detector failed to initialize.',
      });
    }
    return;
  }

  if (type !== 'detect' || !bitmap) return;

  try {
    if (!detector) throw new Error('Face detector is not initialized.');
    const result = detector.detectForVideo(bitmap, timestamp);
    const landmarks = result.faceLandmarks?.[0]?.map(({ x, y }) => ({ x, y })) || null;
    self.postMessage({ type: 'result', landmarks });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Face detection failed.',
    });
  } finally {
    bitmap.close();
  }
};
