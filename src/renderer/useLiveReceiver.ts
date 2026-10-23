import { useCallback, useEffect, useRef, useState } from 'react';
import type { IceCandidatePayload, LiveSession, LiveStats, SdpDescription } from '../shared/types';
import { api, errorText } from './api';

export type LivePhase = 'idle' | 'preparing' | 'connecting' | 'live' | 'disconnected' | 'ended' | 'failed';

type PlaybackIssue = 'audio' | 'video' | null;

interface ReceiverState {
  session: LiveSession | null;
  phase: LivePhase;
  stats: LiveStats | null;
  error: string | null;
  muted: boolean;
  volume: number;
  playbackIssue: PlaybackIssue;
}

export interface LiveReceiver extends ReceiverState {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  requestMute(value: boolean): void;
  requestVolume(value: number): void;
  resumePlayback(): void;
  stop(): void;
}

export function useLiveReceiver(options: { onNotice(message: string): void; onError(message: string): void }): LiveReceiver {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionRef = useRef<LiveSession | null>(null);
  const pendingIce = useRef<IceCandidatePayload[]>([]);
  const statsTimer = useRef<number | null>(null);
  const lastSample = useRef<{ at: number; videoBytes: number; frames: number } | null>(null);
  const phaseRef = useRef<LivePhase>('idle');
  const mutedRef = useRef(false);
  const volumeRef = useRef(1);
  const volumeSend = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const resumeRef = useRef<() => void>(() => undefined);

  const [state, setState] = useState<ReceiverState>({
    session: null,
    phase: 'idle',
    stats: null,
    error: null,
    muted: false,
    volume: 1,
    playbackIssue: null,
  });

  const setPhase = useCallback((phase: LivePhase, error: string | null = null) => {
    phaseRef.current = phase;
    setState((prev) => ({ ...prev, phase, error }));
  }, []);

  useEffect(() => {
    const applyMuted = (value: boolean) => {
      mutedRef.current = value;
      setState((prev) => ({ ...prev, muted: value }));
      if (videoRef.current) videoRef.current.muted = value;
    };
    const applyVolume = (value: number) => {
      const clamped = Math.min(1, Math.max(0, value));
      volumeRef.current = clamped;
      setState((prev) => ({ ...prev, volume: clamped }));
      if (videoRef.current) videoRef.current.volume = clamped;
    };

    const clearStats = () => {
      if (statsTimer.current !== null) {
        window.clearInterval(statsTimer.current);
        statsTimer.current = null;
      }
      lastSample.current = null;
    };

    const setPlaybackIssue = (issue: PlaybackIssue) => {
      setState((prev) => (prev.playbackIssue === issue ? prev : { ...prev, playbackIssue: issue }));
    };

    const report = (phase: 'connecting' | 'live' | 'failed', error: string | null = null, stats: LiveStats | null = null) => {
      const session = sessionRef.current;
      if (!session) return;
      api.reportLiveState({ sessionId: session.id, state: phase, error, stats });
    };

    const teardown = (phase: LivePhase, error: string | null = null, notify = false) => {
      clearStats();
      const pc = pcRef.current;
      pcRef.current = null;
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        try {
          pc.close();
        } catch {
          // already closed
        }
      }
      pendingIce.current = [];
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      setState((prev) => ({ ...prev, phase, error, stats: null, playbackIssue: null, session: notify ? prev.session : null }));
      phaseRef.current = phase;
    };

    const collectStats = async () => {
      const pc = pcRef.current;
      const session = sessionRef.current;
      if (!pc || !session) return;
      let video: Record<string, unknown> | null = null;
      let audio: Record<string, unknown> | null = null;
      let pair: Record<string, unknown> | null = null;
      try {
        const reports = await pc.getStats();
        const byId = new Map<string, Record<string, unknown>>();
        reports.forEach((entry) => {
          byId.set(entry.id, entry as unknown as Record<string, unknown>);
        });
        reports.forEach((entry) => {
          const record = entry as unknown as Record<string, unknown>;
          if (record['type'] === 'inbound-rtp' && record['kind'] === 'video') video = record;
          else if (record['type'] === 'inbound-rtp' && record['kind'] === 'audio') audio = record;
          else if (record['type'] === 'candidate-pair' && (record['nominated'] || record['state'] === 'succeeded')) {
            if (record['currentRoundTripTime'] !== undefined) pair = record;
          }
        });
        const codecOf = (record: Record<string, unknown> | null): string => {
          if (!record) return 'unknown';
          const codecId = record['codecId'];
          if (typeof codecId !== 'string') return 'unknown';
          const codec = byId.get(codecId);
          const mime = codec?.['mimeType'];
          if (typeof mime !== 'string') return 'unknown';
          return mime.replace(/^(audio|video)\//, '').split(';')[0] ?? mime;
        };
        if (!pcRef.current) return;
        const now = Date.now();
        const videoBytes = Number(video?.['bytesReceived'] ?? 0);
        const frames = Number(video?.['framesDecoded'] ?? 0);
        const prev = lastSample.current;
        const elapsed = prev ? Math.max(0.2, (now - prev.at) / 1000) : 1;
        const bitrateKbps = prev && videoBytes >= prev.videoBytes ? Math.round(((videoBytes - prev.videoBytes) * 8) / elapsed / 1000) : 0;
        const jitterBufferMs =
          video && Number(video['jitterBufferEmittedCount']) > 0
            ? Math.round((Number(video['jitterBufferDelay']) / Number(video['jitterBufferEmittedCount'])) * 1000)
            : null;
        lastSample.current = { at: now, videoBytes, frames };
        const stats: LiveStats = {
          at: now,
          width: Number(video?.['frameWidth'] ?? 0),
          height: Number(video?.['frameHeight'] ?? 0),
          fps: Math.round(Number(video?.['framesPerSecond'] ?? 0)),
          bitrateKbps,
          rttMs: pair && typeof pair['currentRoundTripTime'] === 'number' ? Math.round((pair['currentRoundTripTime'] as number) * 1000) : null,
          jitterMs: Math.round(Number(video?.['jitter'] ?? 0) * 1000),
          packetsLost: Number(video?.['packetsLost'] ?? 0),
          bytesReceived: videoBytes,
          framesDecoded: frames,
          codec: codecOf(video),
          audioCodec: audio ? codecOf(audio) : null,
          jitterBufferMs,
        };
        setState((prevState) => ({ ...prevState, stats }));
        if (phaseRef.current === 'live') report('live', null, stats);
      } catch {
        // getStats can fail while the peer is closing
      }
    };

    const ensureStats = () => {
      if (statsTimer.current === null) {
        statsTimer.current = window.setInterval(() => void collectStats(), 1000);
        void collectStats();
      }
    };

    const markLive = () => {
      if (!sessionRef.current) return;
      if (phaseRef.current !== 'live') {
        setPhase('live');
        report('live');
      }
      ensureStats();
    };

    let playbackPending = false;

    const attemptPlay = async () => {
      const video = videoRef.current;
      if (!video || !video.srcObject || !sessionRef.current) return;
      if (playbackPending) return;
      playbackPending = true;
      try {
        video.muted = mutedRef.current;
        let refusal: unknown = null;
        try {
          await video.play();
        } catch (error) {
          refusal = error;
        }
        if (!refusal) {
          setPlaybackIssue(null);
          markLive();
          return;
        }
        // Audible autoplay may be refused; muted playback is always permitted.
        // Other refusals (for example an interrupted load) also recover here.
        video.muted = true;
        try {
          await video.play();
          markLive();
          const audible = !mutedRef.current && refusal instanceof DOMException && refusal.name === 'NotAllowedError';
          setPlaybackIssue(audible ? 'audio' : null);
        } catch {
          setPlaybackIssue('video');
        }
      } finally {
        playbackPending = false;
      }
    };
    resumeRef.current = () => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = mutedRef.current;
      void attemptPlay();
    };

    const prepare = (incoming: LiveSession) => {
      teardown('preparing');
      sessionRef.current = incoming;
      setState({
        session: incoming,
        phase: 'preparing',
        stats: null,
        error: null,
        muted: mutedRef.current,
        volume: volumeRef.current,
        playbackIssue: null,
      });
      phaseRef.current = 'preparing';
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      pc.onicecandidate = (event) => {
        const session = sessionRef.current;
        if (!session) return;
        if (event.candidate) {
          api.reportLiveSignal({
            sessionId: session.id,
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            },
          });
        } else {
          api.reportLiveSignal({ sessionId: session.id, candidate: null });
        }
      };
      pc.ontrack = (event) => {
        const video = videoRef.current;
        if (!video) return;
        const current = video.srcObject;
        let stream: MediaStream;
        if (current instanceof MediaStream) {
          stream = current;
        } else {
          stream = event.streams[0] ?? new MediaStream();
          video.srcObject = stream;
        }
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
        video.muted = mutedRef.current;
        video.volume = volumeRef.current;
        void attemptPlay();
      };
      pc.onconnectionstatechange = () => {
        if (!pcRef.current) return;
        switch (pc.connectionState) {
          case 'connected':
            ensureStats();
            break;
          case 'disconnected':
            setPhase('disconnected');
            break;
          case 'failed':
            teardown('failed');
            report('failed', '点对点连接失败，请检查两台设备是否在同一局域网、防火墙是否放行');
            optionsRef.current.onError('投屏连接失败，请检查局域网与防火墙设置');
            break;
          default:
            break;
        }
      };
    };

    const deliverOffer = async (sessionId: string, sdp: SdpDescription) => {
      const pc = pcRef.current;
      const session = sessionRef.current;
      if (!pc || !session || session.id !== sessionId || sdp.type !== 'offer') return;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: sdp.sdp });
        for (const candidate of pendingIce.current) {
          await pc.addIceCandidate(candidate).catch(() => undefined);
        }
        pendingIce.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const local = pc.localDescription;
        if (!local?.sdp) throw new Error('未能生成 SDP 应答');
        api.reportLiveSignal({ sessionId, answer: { type: 'answer', sdp: local.sdp } });
        setPhase('connecting');
        report('connecting');
        ensureStats();
      } catch (error) {
        setPhase('failed', errorText(error));
        report('failed', errorText(error));
        optionsRef.current.onError(`建立连接失败：${errorText(error)}`);
      }
    };

    const deliverIce = async (sessionId: string, candidate: IceCandidatePayload | null) => {
      const pc = pcRef.current;
      const session = sessionRef.current;
      if (!pc || !session || session.id !== sessionId) return;
      if (!pc.remoteDescription) {
        if (candidate) pendingIce.current.push(candidate);
        return;
      }
      try {
        if (candidate) await pc.addIceCandidate(candidate);
        else await pc.addIceCandidate();
      } catch {
        // a late candidate after teardown is harmless
      }
    };

    const unsubPrepare = api.onLivePrepare((incoming) => prepare(incoming));
    const unsubOffer = api.onLiveOffer(({ sessionId, sdp }) => void deliverOffer(sessionId, sdp));
    const unsubIce = api.onLiveIce(({ sessionId, candidate }) => void deliverIce(sessionId, candidate));
    const unsubStop = api.onLiveStop(({ reason }) => {
      teardown('ended');
      sessionRef.current = null;
      if (reason && reason !== 'stopped by receiver') optionsRef.current.onNotice(`投屏已结束：${reason}`);
    });
    const unsubNotice = api.onLiveNotice(({ message }) => optionsRef.current.onNotice(message));
    const unsubCommand = api.onLiveCommand(({ action, value }) => {
      if (action === 'mute') applyMuted(Boolean(value));
      else applyVolume(typeof value === 'number' ? value : volumeRef.current);
    });

    return () => {
      unsubPrepare();
      unsubOffer();
      unsubIce();
      unsubStop();
      unsubNotice();
      unsubCommand();
      clearStats();
      if (volumeSend.current !== null) window.clearTimeout(volumeSend.current);
      resumeRef.current = () => undefined;
      const session = sessionRef.current;
      if (session) api.reportLiveGone({ sessionId: session.id, reason: '接收界面已关闭' });
      const pc = pcRef.current;
      pcRef.current = null;
      sessionRef.current = null;
      if (pc) {
        try {
          pc.close();
        } catch {
          // already closed
        }
      }
    };
  }, [setPhase]);

  const requestMute = useCallback((value: boolean) => {
    mutedRef.current = value;
    setState((prev) => ({ ...prev, muted: value }));
    if (videoRef.current) videoRef.current.muted = value;
    resumeRef.current();
    const session = sessionRef.current;
    if (session) {
      void api.setLiveMuted(session.id, value).catch((error) => optionsRef.current.onError(errorText(error)));
    }
  }, []);

  const requestVolume = useCallback((value: number) => {
    const clamped = Math.min(1, Math.max(0, value));
    volumeRef.current = clamped;
    setState((prev) => ({ ...prev, volume: clamped }));
    if (videoRef.current) videoRef.current.volume = clamped;
    if (volumeSend.current !== null) window.clearTimeout(volumeSend.current);
    volumeSend.current = window.setTimeout(() => {
      volumeSend.current = null;
      const session = sessionRef.current;
      if (session) void api.setLiveVolume(session.id, clamped).catch(() => undefined);
    }, 80);
  }, []);

  const resumePlayback = useCallback(() => resumeRef.current(), []);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    void api.stopLive(session.id).catch((error) => optionsRef.current.onError(errorText(error)));
  }, []);

  return { ...state, videoRef, requestMute, requestVolume, resumePlayback, stop };
}
