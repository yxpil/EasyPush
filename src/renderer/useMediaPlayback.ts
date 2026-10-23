import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem, MediaSession, MediaState, MediaStateReport } from '../shared/types';
import { api } from './api';

interface PlaybackState {
  session: MediaSession | null;
  phase: MediaState;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  autoplayImages: boolean;
  error: string | null;
  imageSize: { width: number; height: number } | null;
}

const EMPTY: PlaybackState = {
  session: null,
  phase: 'idle',
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  autoplayImages: false,
  error: null,
  imageSize: null,
};

export interface MediaPlayback extends PlaybackState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  current: MediaItem | null;
  toggle(): void;
  seekTo(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setAutoplayImages(value: boolean): void;
  playIndex(itemId: string): void;
  stop(): void;
  imageLoaded(width: number, height: number): void;
  imageFailed(): void;
}

export function useMediaPlayback(slideMs: number, ready: boolean): MediaPlayback {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const slideMsRef = useRef(slideMs);
  const slideTimer = useRef<number | null>(null);
  const reportAt = useRef(0);
  const sessionRef = useRef<MediaSession | null>(null);
  const phaseRef = useRef<MediaState>('idle');
  const autoplayRef = useRef(false);
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const imageSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [state, setState] = useState<PlaybackState>(EMPTY);

  const currentItem = useCallback((): MediaItem | null => {
    const session = sessionRef.current;
    return session?.items[session.index] ?? null;
  }, []);

  const buildReport = useCallback((): MediaStateReport | null => {
    const session = sessionRef.current;
    const item = currentItem();
    if (!session || !item) return null;
    let position = 0;
    let duration = 0;
    let width: number | null = null;
    let height: number | null = null;
    if (item.kind === 'video') {
      const el = videoRef.current;
      position = el?.currentTime ?? 0;
      duration = el && Number.isFinite(el.duration) ? el.duration : 0;
      width = el?.videoWidth || null;
      height = el?.videoHeight || null;
    } else if (item.kind === 'audio') {
      const el = audioRef.current;
      position = el?.currentTime ?? 0;
      duration = el && Number.isFinite(el.duration) ? el.duration : 0;
    } else if (imageSizeRef.current) {
      width = imageSizeRef.current.width;
      height = imageSizeRef.current.height;
    }
    const canSeek = item.kind !== 'image' && Number.isFinite(duration) && duration > 0 && duration < 86_400;
    return {
      sessionId: session.id,
      state: phaseRef.current,
      positionSec: Number.isFinite(position) ? Math.max(0, position) : 0,
      durationSec: Number.isFinite(duration) ? Math.max(0, duration) : 0,
      volume: volumeRef.current,
      muted: mutedRef.current,
      index: session.index,
      error: errorRef.current,
      canSeek,
      width,
      height,
    };
  }, [currentItem]);

  const report = useCallback(() => {
    const payload = buildReport();
    if (!payload) return;
    reportAt.current = Date.now();
    api.reportMediaState(payload);
  }, [buildReport]);

  const setPhase = useCallback((phase: MediaState, error: string | null = null) => {
    phaseRef.current = phase;
    errorRef.current = error;
    setState((prev) => ({ ...prev, phase, error }));
  }, []);

  const clearSlideTimer = useCallback(() => {
    if (slideTimer.current !== null) {
      window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
    }
  }, []);

  const restartSlideTimer = useCallback(() => {
    clearSlideTimer();
    const session = sessionRef.current;
    const item = currentItem();
    if (!session || !item || item.kind !== 'image') return;
    if (!autoplayRef.current || phaseRef.current !== 'playing' || session.items.length < 2) return;
    slideTimer.current = window.setTimeout(() => {
      slideTimer.current = null;
      const active = sessionRef.current;
      const activeItem = currentItem();
      if (!active || !activeItem || activeItem.kind !== 'image' || !autoplayRef.current) return;
      if (active.index < active.items.length - 1) {
        setPhase('ended');
        report();
      } else {
        setPhase('paused');
        report();
      }
    }, Math.max(1000, slideMsRef.current));
  }, [clearSlideTimer, currentItem, report, setPhase]);

  useEffect(() => {
    slideMsRef.current = slideMs;
    if (phaseRef.current === 'playing') restartSlideTimer();
  }, [slideMs, restartSlideTimer]);

  const destroySource = useCallback(() => {
    clearSlideTimer();
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  }, [clearSlideTimer]);

  const applyVolume = useCallback((volume: number, muted: boolean) => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, []);

  const attemptPlay = useCallback(() => {
    const item = currentItem();
    if (!item) return;
    const el = item.kind === 'video' ? videoRef.current : item.kind === 'audio' ? audioRef.current : null;
    if (!el) return;
    phaseRef.current = 'loading';
    setState((prev) => ({ ...prev, phase: 'loading', error: null }));
    void el.play().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setPhase('error', `无法开始播放：${message}`);
      report();
    });
  }, [currentItem, report, setPhase]);

  const load = useCallback(
    (session: MediaSession, autoplay: boolean) => {
      destroySource();
      sessionRef.current = session;
      phaseRef.current = 'loading';
      errorRef.current = null;
      autoplayRef.current = session.autoplayImages;
      imageSizeRef.current = null;
      applyVolume(session.volume, session.muted);
      setState({
        session,
        phase: 'loading',
        position: session.positionSec ?? 0,
        duration: session.durationSec ?? 0,
        volume: session.volume,
        muted: session.muted,
        autoplayImages: session.autoplayImages,
        error: null,
        imageSize: null,
      });
      const item = session.items[session.index];
      if (!item) {
        setPhase('error', '播放列表为空');
        return;
      }
      if (item.kind === 'image') {
        phaseRef.current = autoplay ? 'playing' : 'paused';
        setState((prev) => ({ ...prev, phase: phaseRef.current }));
        restartSlideTimer();
        report();
        return;
      }
      const isHls = item.kind === 'video' && /\.m3u8(\?|$)/i.test(item.url);
      if (isHls) {
        const video = videoRef.current;
        if (!video) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
          hlsRef.current = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
              return;
            }
            setPhase('error', `HLS 播放失败：${data.details}`);
            report();
          });
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoplay) attemptPlay();
            else setPhase('paused');
          });
          hls.loadSource(item.url);
          hls.attachMedia(video);
        } else {
          video.src = item.url;
          video.load();
          if (autoplay) attemptPlay();
          else setPhase('paused');
        }
        return;
      }
      const el = item.kind === 'video' ? videoRef.current : audioRef.current;
      if (!el) return;
      el.src = item.url;
      el.load();
      if (autoplay) attemptPlay();
      else setPhase('paused');
    },
    [applyVolume, attemptPlay, destroySource, report, restartSlideTimer, setPhase],
  );

  const stopPlayback = useCallback(() => {
    destroySource();
    sessionRef.current = null;
    phaseRef.current = 'idle';
    errorRef.current = null;
    imageSizeRef.current = null;
    autoplayRef.current = false;
    setState(EMPTY);
  }, [destroySource]);

  useEffect(() => {
    if (!ready) return;
    const cleanups: Array<() => void> = [];

    const attach = (el: HTMLVideoElement | HTMLAudioElement, kind: 'video' | 'audio') => {
      const matches = () => {
        const item = currentItem();
        if (!sessionRef.current || !item || item.kind !== kind) return false;
        const current = el.currentSrc || el.src;
        if (current === item.url || el.src === item.url) return true;
        return Boolean(hlsRef.current && /\.m3u8(\?|$)/i.test(item.url));
      };
      const onPlay = () => {
        if (!matches()) return;
        setPhase('playing');
        restartSlideTimer();
        report();
      };
      const onPause = () => {
        if (!matches()) return;
        if (phaseRef.current === 'error' || phaseRef.current === 'ended') return;
        setPhase('paused');
        report();
      };
      const onEnded = () => {
        if (!matches()) return;
        setPhase('ended');
        report();
      };
      const onLoaded = () => {
        if (!matches()) return;
        const duration = Number.isFinite(el.duration) ? el.duration : 0;
        setState((prev) => ({ ...prev, duration }));
        report();
      };
      const onTime = () => {
        if (!matches()) return;
        const position = el.currentTime;
        setState((prev) => (Math.abs(prev.position - position) > 0.2 ? { ...prev, position } : prev));
        if (Date.now() - reportAt.current > 1000) report();
      };
      const onError = () => {
        if (!matches()) return;
        const code = el.error?.code;
        const message =
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? '无法播放：格式不受支持或文件无法读取'
            : el.error?.message || '媒体播放失败';
        setPhase('error', message);
        report();
      };
      const onVolume = () => {
        volumeRef.current = el.volume;
        mutedRef.current = el.muted;
        setState((prev) => ({ ...prev, volume: el.volume, muted: el.muted }));
      };
      const onWaiting = () => {
        if (matches() && phaseRef.current === 'playing') setState((prev) => ({ ...prev, phase: 'loading' }));
      };
      const onPlaying = () => {
        if (!matches()) return;
        if (phaseRef.current !== 'playing') setPhase('playing');
        restartSlideTimer();
      };
      el.addEventListener('play', onPlay);
      el.addEventListener('playing', onPlaying);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);
      el.addEventListener('loadedmetadata', onLoaded);
      el.addEventListener('durationchange', onLoaded);
      el.addEventListener('timeupdate', onTime);
      el.addEventListener('error', onError);
      el.addEventListener('volumechange', onVolume);
      el.addEventListener('waiting', onWaiting);
      cleanups.push(() => {
        el.removeEventListener('play', onPlay);
        el.removeEventListener('playing', onPlaying);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('ended', onEnded);
        el.removeEventListener('loadedmetadata', onLoaded);
        el.removeEventListener('durationchange', onLoaded);
        el.removeEventListener('timeupdate', onTime);
        el.removeEventListener('error', onError);
        el.removeEventListener('volumechange', onVolume);
        el.removeEventListener('waiting', onWaiting);
      });
    };

    if (videoRef.current) attach(videoRef.current, 'video');
    if (audioRef.current) attach(audioRef.current, 'audio');

    const unsubLoad = api.onMediaLoad(({ session, autoplay }) => load(session, autoplay));
    const unsubSync = api.onMediaSync(({ session }) => {
      const current = sessionRef.current;
      if (!current || current.id !== session.id) return;
      const merged: MediaSession = { ...current, items: session.items, index: session.index, updatedAt: session.updatedAt };
      sessionRef.current = merged;
      setState((prev) => ({ ...prev, session: merged }));
      if (currentItem()?.kind === 'image' && phaseRef.current === 'playing') restartSlideTimer();
    });
    const unsubCommand = api.onMediaCommand(({ sessionId, command, value }) => {
      const session = sessionRef.current;
      if (!session || session.id !== sessionId) return;
      const item = currentItem();
      if (!item) return;
      if (command === 'stop') {
        stopPlayback();
        return;
      }
      if (command === 'volume') {
        applyVolume(typeof value === 'number' ? value : volumeRef.current, mutedRef.current);
        setState((prev) => ({ ...prev, volume: volumeRef.current }));
        return;
      }
      if (command === 'mute') {
        applyVolume(volumeRef.current, Boolean(value));
        setState((prev) => ({ ...prev, muted: mutedRef.current }));
        return;
      }
      if (command === 'autoplay-images') {
        autoplayRef.current = Boolean(value);
        setState((prev) => ({ ...prev, autoplayImages: autoplayRef.current }));
        if (item.kind === 'image' && phaseRef.current === 'playing') restartSlideTimer();
        else clearSlideTimer();
        return;
      }
      if (command === 'seek') {
        const target = typeof value === 'number' ? value : 0;
        if (item.kind === 'video' && videoRef.current) {
          videoRef.current.currentTime = Math.max(0, target);
          setState((prev) => ({ ...prev, position: Math.max(0, target) }));
          report();
        } else if (item.kind === 'audio' && audioRef.current) {
          audioRef.current.currentTime = Math.max(0, target);
          setState((prev) => ({ ...prev, position: Math.max(0, target) }));
          report();
        }
        return;
      }
      if (item.kind === 'image') {
        if (command === 'play') {
          setPhase('playing');
          restartSlideTimer();
          report();
        } else if (command === 'pause') {
          setPhase('paused');
          clearSlideTimer();
          report();
        }
        return;
      }
      if (command === 'play') {
        attemptPlay();
        return;
      }
      if (command === 'pause') {
        const el = item.kind === 'video' ? videoRef.current : audioRef.current;
        el?.pause();
      }
    });

    return () => {
      unsubLoad();
      unsubSync();
      unsubCommand();
      for (const cleanup of cleanups) cleanup();
      clearSlideTimer();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [ready]);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) api.reportMediaGone({ sessionId: session.id, reason: '界面已关闭' });
    };
  }, []);

  const toggle = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (phaseRef.current === 'playing' || phaseRef.current === 'loading') api.mediaCommand('pause');
    else api.mediaCommand('play');
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const session = sessionRef.current;
    if (!session) return;
    if (currentItem()?.kind === 'image') return;
    api.mediaCommand('seek', Math.max(0, seconds));
  }, [currentItem]);

  const setVolume = useCallback(
    (volume: number) => {
      const clamped = Math.min(1, Math.max(0, volume));
      applyVolume(clamped, mutedRef.current);
      setState((prev) => ({ ...prev, volume: clamped }));
      api.mediaCommand('volume', clamped);
    },
    [applyVolume],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      applyVolume(volumeRef.current, muted);
      setState((prev) => ({ ...prev, muted }));
      api.mediaCommand('mute', muted);
    },
    [applyVolume],
  );

  const setAutoplayImages = useCallback((value: boolean) => {
    api.mediaCommand('autoplay-images', value);
  }, []);

  const playIndex = useCallback((itemId: string) => {
    api.mediaCommand('play-item', itemId);
  }, []);

  const stop = useCallback(() => {
    api.mediaCommand('stop');
  }, []);

  const imageLoaded = useCallback(
    (width: number, height: number) => {
      imageSizeRef.current = { width, height };
      setState((prev) => ({ ...prev, imageSize: imageSizeRef.current }));
      report();
    },
    [report],
  );

  const imageFailed = useCallback(() => {
    setPhase('error', '无法显示此图片：浏览器可能不支持该格式，请转换为 JPEG 或 PNG');
    report();
  }, [report, setPhase]);

  return {
    ...state,
    videoRef,
    audioRef,
    current: currentItem(),
    toggle,
    seekTo,
    setVolume,
    setMuted,
    setAutoplayImages,
    playIndex,
    stop,
    imageLoaded,
    imageFailed,
  };
}
