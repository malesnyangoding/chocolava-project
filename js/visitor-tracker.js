(function () {
  'use strict';

  const state = {
    visitId: null,
    photoCount: 0,
    lastCaptureAt: 0,
    faceDetector: null,
    faceDetectorLoading: false,
    faceDetectorRetryAt: 0,
    faceDetectorLibraryWarningShown: false,
    isTrackingStarted: false,
    visitRequestInFlight: false,
    uploadInFlight: false,
  };

  function setPhotoStatus(message) {
    const status = document.getElementById('facePhotoStatus');
    if (status) status.textContent = message;
  }

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://ipapi.co/json/', {
        cache: 'no-store',
        signal: controller.signal,
      });
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
      console.warn('IP geolocation lookup failed', error);
      return {
        ip: 'unknown',
        location: 'Unknown location',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function recordVisit() {
    if (state.visitId || state.visitRequestInFlight) return;
    state.visitRequestInFlight = true;

    try {
      const info = await getVisitorLocation();
      const payload = {
        ip: info.ip,
        location: info.location,
        deviceName: getDeviceName(),
        userAgent: navigator.userAgent,
        page: 'main',
      };
      const response = await fetch('/api/track-visit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      if (data && data.ok && data.visitId) {
        state.visitId = data.visitId;
        if (document.getElementById('facePhotoConsent')?.checked) {
          setPhotoStatus('Kunjungan tercatat. Menunggu kamera aktif dan wajah terdeteksi...');
        }
      } else {
        console.error('Visit tracking failed:', data.message || response.statusText);
        if (document.getElementById('facePhotoConsent')?.checked) {
          setPhotoStatus(`Kunjungan belum tercatat (${data.message || response.statusText}). Foto belum bisa disimpan; akan dicoba lagi.`);
        }
      }
    } catch (error) {
      console.error('Visit tracking failed', error);
      if (document.getElementById('facePhotoConsent')?.checked) {
        setPhotoStatus('Kunjungan belum tercatat karena koneksi gagal. Foto belum bisa disimpan; akan dicoba lagi.');
      }
    } finally {
      state.visitRequestInFlight = false;
    }
  }

  function createPhotoDataUrl(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(width, 960);
    canvas.height = Math.round(canvas.width * height / width);
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function uploadFacePhoto() {
    if (!state.visitId) return;
    if (state.photoCount >= 5) return;
    if (!document.getElementById('facePhotoConsent')?.checked || state.uploadInFlight) return;

    const video = document.getElementById('cam');
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    const now = Date.now();
    if (now - state.lastCaptureAt < 10000) return;

    const imageDataUrl = createPhotoDataUrl(video);
    if (!imageDataUrl) {
      setPhotoStatus('Kamera aktif, tetapi frame foto belum tersedia. Coba lagi sebentar.');
      return;
    }

    state.lastCaptureAt = now;
    state.uploadInFlight = true;
    setPhotoStatus('Wajah terdeteksi. Mengunggah foto yang disetujui...');

    try {
      const response = await fetch('/api/photo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ visitId: state.visitId, imageDataUrl }),
      });

      const data = await response.json().catch(() => ({}));
      if (data && data.ok) {
        state.photoCount += 1;
        setPhotoStatus(`Foto tersimpan (${state.photoCount}/5). Foto berikutnya bisa diambil setelah 10 detik jika wajah masih terdeteksi.`);
      } else if (data && data.message && data.message.includes('Maximum')) {
        state.photoCount = 5;
        setPhotoStatus('Batas maksimal 5 foto untuk kunjungan ini sudah tercapai.');
      } else if (!response.ok) {
        const message = data.message || `HTTP ${response.status} ${response.statusText}`;
        console.error('Photo upload failed:', message);
        setPhotoStatus(`Upload foto gagal: ${message}`);
      }
    } catch (error) {
      console.error('Face photo capture failed', error);
      setPhotoStatus('Upload foto gagal. Periksa koneksi lalu coba lagi.');
    } finally {
      state.uploadInFlight = false;
    }
  }

  async function initializeFaceDetector() {
    if (state.faceDetector || state.faceDetectorLoading) return;
    if (Date.now() < state.faceDetectorRetryAt) return;
    const visionTasks = window.Vision;
    if (!visionTasks?.FaceLandmarker || !visionTasks?.FilesetResolver) {
      setPhotoStatus('Library deteksi wajah tidak termuat. Periksa koneksi/CDN, lalu muat ulang halaman.');
      state.faceDetectorRetryAt = Date.now() + 15000;
      if (!state.faceDetectorLibraryWarningShown) {
        console.error('MediaPipe Vision bundle or its FaceLandmarker exports are missing.');
        state.faceDetectorLibraryWarningShown = true;
      }
      return;
    }

    state.faceDetectorLibraryWarningShown = false;
    state.faceDetectorLoading = true;
    try {
      const wasmFileset = await visionTasks.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm');
      state.faceDetector = await visionTasks.FaceLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      setPhotoStatus('Detektor siap. Nyalakan kamera untuk mulai mendeteksi wajah; foto hanya diunggah setelah wajah terdeteksi.');
    } catch (error) {
      console.error('Face detector initialization failed', error);
      setPhotoStatus(`Deteksi wajah gagal dimuat: ${error.message || 'periksa koneksi internet lalu muat ulang halaman.'}`);
      state.faceDetectorRetryAt = Date.now() + 15000;
    } finally {
      state.faceDetectorLoading = false;
    }
  }

  function checkFacePresence() {
    const video = document.getElementById('cam');
    if (!document.getElementById('facePhotoConsent')?.checked) return;
    if (!video || !state.faceDetector || !state.visitId) return;
    if (video.readyState < 2) return;
    if (!video.srcObject || !video.srcObject.getVideoTracks().some((track) => track.readyState === 'live')) return;
    if (state.photoCount >= 5) return;

    try {
      const result = state.faceDetector.detectForVideo(video, performance.now());
      const landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
      if (!landmarks) return;

      const xs = landmarks.map((point) => point.x);
      const ys = landmarks.map((point) => point.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      if (width > 0.18 && height > 0.18) {
        uploadFacePhoto();
      } else if (state.photoCount === 0 && !state.uploadInFlight) {
        setPhotoStatus('Detektor siap. Dekatkan wajah ke kamera hingga terlihat cukup besar.');
      }
    } catch (error) {
      console.error('Face detection failed', error);
    }
  }

  function startTracking() {
    if (state.isTrackingStarted) return;
    state.isTrackingStarted = true;

    recordVisit();

    setInterval(() => {
      if (!state.visitId) recordVisit();
      if (document.getElementById('facePhotoConsent')?.checked && !state.faceDetector) {
        initializeFaceDetector();
      }
      checkFacePresence();
    }, 500);

    document.getElementById('facePhotoConsent')?.addEventListener('change', (event) => {
      if (event.currentTarget.checked) {
        setPhotoStatus('Memuat deteksi wajah dan menyiapkan pencatatan kunjungan...');
        recordVisit();
        initializeFaceDetector();
      } else {
        setPhotoStatus('Deteksi wajah dan pengambilan foto nonaktif.');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTracking, { once: true });
  } else {
    startTracking();
  }
})();
