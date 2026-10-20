(function () {
  'use strict';

  const state = {
    visitId: null,
    photoCount: 0,
    photoCooldownUntil: 0,
    lastCaptureAt: 0,
    faceDetectorWorker: null,
    faceDetectorReady: false,
    faceDetectionInFlight: false,
    faceDetectorLoading: false,
    faceDetectorRetryAt: 0,
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
        state.photoCount = Number(data.photoCount) || 0;
        state.photoCooldownUntil = data.photoCooldownUntil ? Date.parse(data.photoCooldownUntil) : 0;
        if (document.getElementById('facePhotoConsent')?.checked) {
          if (state.photoCount >= 5) {
            const availableAt = new Date(state.photoCooldownUntil).toLocaleString('id-ID');
            setPhotoStatus(`Kunjungan tercatat. Batas 5 foto per 24 jam tercapai; foto dapat diambil lagi setelah ${availableAt}.`);
          } else {
            setPhotoStatus(`Kunjungan tercatat. ${state.photoCount}/5 foto digunakan dalam 24 jam terakhir; menunggu kamera aktif dan wajah terdeteksi...`);
          }
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
      } else if (response.status === 429) {
        state.photoCount = 5;
        const availableAt = data.availableAt ? new Date(data.availableAt).toLocaleString('id-ID') : null;
        state.photoCooldownUntil = data.availableAt ? Date.parse(data.availableAt) : Date.now() + 24 * 60 * 60 * 1000;
        setPhotoStatus(availableAt
          ? `Batas 5 foto per 24 jam tercapai. Foto bisa diambil lagi setelah ${availableAt}.`
          : 'Batas 5 foto per 24 jam tercapai. Coba lagi setelah cooldown 24 jam.');
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

  function initializeFaceDetector() {
    if (state.faceDetectorWorker || state.faceDetectorLoading) return;
    if (Date.now() < state.faceDetectorRetryAt) return;
    state.faceDetectorLoading = true;
    try {
      const worker = new Worker('/js/face-detector-worker.js');
      state.faceDetectorWorker = worker;
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'ready') {
          state.faceDetectorReady = true;
          state.faceDetectorLoading = false;
          setPhotoStatus('Detektor siap. Nyalakan kamera untuk mulai mendeteksi wajah; foto hanya diunggah setelah wajah terdeteksi.');
          return;
        }

        if (data.type === 'result') {
          state.faceDetectionInFlight = false;
          const landmarks = data.landmarks;
          if (!document.getElementById('facePhotoConsent')?.checked || !landmarks?.length) return;

          const xs = landmarks.map((point) => point.x);
          const ys = landmarks.map((point) => point.y);
          const width = Math.max(...xs) - Math.min(...xs);
          const height = Math.max(...ys) - Math.min(...ys);
          if (width > 0.18 && height > 0.18) {
            uploadFacePhoto();
          } else if (state.photoCount === 0 && !state.uploadInFlight) {
            setPhotoStatus('Detektor siap. Dekatkan wajah ke kamera hingga terlihat cukup besar.');
          }
          return;
        }

        if (data.type === 'error') {
          console.error('Face detector worker failed:', data.message);
          setPhotoStatus(`Deteksi wajah gagal dimuat: ${data.message || 'periksa koneksi/CDN lalu coba lagi.'}`);
          stopFaceDetectorWorker();
        }
      };
      worker.onerror = (error) => {
        console.error('Face detector worker error:', error);
        setPhotoStatus('Deteksi wajah gagal dimuat di worker. Periksa koneksi/CDN, lalu coba lagi.');
        stopFaceDetectorWorker();
      };
      worker.postMessage({ type: 'init' });
    } catch (error) {
      console.error('Face detector worker could not start:', error);
      setPhotoStatus(`Deteksi wajah gagal dimulai: ${error.message || 'browser tidak mendukung Web Worker.'}`);
      stopFaceDetectorWorker();
    }
  }

  function stopFaceDetectorWorker() {
    state.faceDetectorWorker?.terminate();
    state.faceDetectorWorker = null;
    state.faceDetectorReady = false;
    state.faceDetectorLoading = false;
    state.faceDetectionInFlight = false;
    state.faceDetectorRetryAt = Date.now() + 15000;
  }

  async function checkFacePresence() {
    const video = document.getElementById('cam');
    if (!document.getElementById('facePhotoConsent')?.checked) return;
    if (!video || !state.faceDetectorReady || !state.faceDetectorWorker || !state.visitId) return;
    if (video.readyState < 2) return;
    if (!video.srcObject || !video.srcObject.getVideoTracks().some((track) => track.readyState === 'live')) return;
    if (state.photoCount >= 5) {
      if (Date.now() < state.photoCooldownUntil) return;
      state.photoCount = 0;
      state.photoCooldownUntil = 0;
      state.lastCaptureAt = 0;
      setPhotoStatus('Cooldown 24 jam selesai. Deteksi foto aktif kembali selama persetujuan tetap diberikan.');
    }
    if (state.faceDetectionInFlight) return;

    state.faceDetectionInFlight = true;
    try {
      const bitmap = await createImageBitmap(video);
      if (!document.getElementById('facePhotoConsent')?.checked || !state.faceDetectorWorker) {
        bitmap.close();
        state.faceDetectionInFlight = false;
        return;
      }
      state.faceDetectorWorker.postMessage({
        type: 'detect',
        bitmap,
        timestamp: performance.now(),
      }, [bitmap]);
    } catch (error) {
      console.error('Face detection failed', error);
      state.faceDetectionInFlight = false;
    }
  }

  function startTracking() {
    if (state.isTrackingStarted) return;
    state.isTrackingStarted = true;

    recordVisit();

    setInterval(() => {
      if (!state.visitId) recordVisit();
      if (document.getElementById('facePhotoConsent')?.checked && !state.faceDetectorWorker) {
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
        state.faceDetectionInFlight = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTracking, { once: true });
  } else {
    startTracking();
  }
})();
