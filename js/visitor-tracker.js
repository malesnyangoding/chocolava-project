(function () {
  'use strict';

  const state = {
    visitId: null,
    photoCount: 0,
    lastCaptureAt: 0,
    faceDetector: null,
    faceDetectorLoading: false,
    isTrackingStarted: false,
    uploadInFlight: false,
  };

  function getDeviceName() {
    const ua = navigator.userAgent || '';

    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone/iPad';
    if (/Android/i.test(ua)) return 'Android device';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Mac/i.test(ua)) return 'MacBook';
    if (/Linux/i.test(ua)) return 'Linux PC';

    return 'Unknown device';
  }

  async function getVisitorLocation() {
    try {
      const response = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
      if (!response.ok) {
        return {
          ip: 'unknown',
          location: 'Unknown location',
        };
      }

      const data = await response.json();
      const location = [data.city, data.region, data.country_name].filter(Boolean).join(', ') || 'Unknown location';

      return {
        ip: data.ip || 'unknown',
        location,
      };
    } catch (error) {
      return {
        ip: 'unknown',
        location: 'Unknown location',
      };
    }
  }

  async function recordVisit() {
    if (state.visitId) return;

    const info = await getVisitorLocation();
    const payload = {
      ip: info.ip,
      location: info.location,
      deviceName: getDeviceName(),
      userAgent: navigator.userAgent,
      page: 'main',
    };

    try {
      const response = await fetch('/api/track-visit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (data && data.ok && data.visitId) {
        state.visitId = data.visitId;
      }
    } catch (error) {
      console.warn('Visit tracking failed', error);
    }
  }

  async function uploadFacePhoto() {
    if (!state.visitId) return;
    if (state.photoCount >= 5) return;
    if (!document.getElementById('facePhotoConsent')?.checked || state.uploadInFlight) return;

    const canvas = document.getElementById('view');
    if (!canvas) return;

    const now = Date.now();
    if (now - state.lastCaptureAt < 10000) return;

    state.lastCaptureAt = now;
    state.uploadInFlight = true;
    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.85);

    try {
      const response = await fetch('/api/photo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ visitId: state.visitId, imageDataUrl }),
      });

      const data = await response.json();
      if (data && data.ok) {
        state.photoCount += 1;
      } else if (data && data.message && data.message.includes('Maximum')) {
        state.photoCount = 5;
      } else if (!response.ok) {
        console.warn('Photo upload failed:', data.message || response.statusText);
      }
    } catch (error) {
      console.warn('Face photo capture failed', error);
    } finally {
      state.uploadInFlight = false;
    }
  }

  async function initializeFaceDetector() {
    if (state.faceDetector || state.faceDetectorLoading || !window.FaceLandmarker || !window.FilesetResolver) {
      return;
    }

    const status = document.getElementById('facePhotoStatus');
    state.faceDetectorLoading = true;
    try {
      const vision = await window.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
      state.faceDetector = await window.FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      status.textContent = 'Persetujuan aktif. Deteksi berjalan di browser; foto hanya diunggah setelah wajah terdeteksi.';
    } catch (error) {
      console.error('Face detector initialization failed', error);
      status.textContent = 'Deteksi wajah gagal dimuat. Periksa koneksi internet lalu coba muat ulang halaman.';
    } finally {
      state.faceDetectorLoading = false;
    }
  }

  function checkFacePresence() {
    const video = document.getElementById('cam');
    if (!document.getElementById('facePhotoConsent')?.checked) return;
    if (!video || !state.faceDetector || !state.visitId) return;
    if (video.readyState < 2) return;
    if (state.photoCount >= 5) return;

    try {
      const result = state.faceDetector.detectForVideo(video, performance.now());
      const landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
      if (!landmarks) return;

      const xs = landmarks.map((point) => point.x);
      const ys = landmarks.map((point) => point.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      if (width > 0.18 && height > 0.18) uploadFacePhoto();
    } catch (error) {
      console.error('Face detection failed', error);
    }
  }

  function startTracking() {
    if (state.isTrackingStarted) return;
    state.isTrackingStarted = true;

    recordVisit();

    setInterval(() => {
      if (document.getElementById('facePhotoConsent')?.checked && !state.faceDetector) {
        initializeFaceDetector();
      }
      checkFacePresence();
    }, 500);

    document.getElementById('facePhotoConsent')?.addEventListener('change', (event) => {
      const status = document.getElementById('facePhotoStatus');
      if (event.currentTarget.checked) {
        status.textContent = 'Memuat deteksi wajah...';
        initializeFaceDetector();
      } else {
        status.textContent = 'Deteksi wajah dan pengambilan foto nonaktif.';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTracking, { once: true });
  } else {
    startTracking();
  }
})();
