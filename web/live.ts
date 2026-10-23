import type {
  ClientMessage,
  IceCandidatePayload,
  LiveStats,
  ServerMessage,
  SdpDescription,
} from '../src/shared/types';

export type LivePhase =
  | 'requesting'
  | 'awaiting-approval'
  | 'awaiting-takeover'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ended'
  | 'error';

export type LiveMedia = 'camera' | 'screen';

export interface LiveEvents {
  stream(stream: MediaStream): void;
  phase(phase: LivePhase): void;
  stats(stats: LiveStats): void;
  notice(message: string): void;
  error(message: string): void;
  ended(reason: string): void;
}

type Hello = Extract<ServerMessage, { type: 'hello' }>;
type StateMessage = Extract<ServerMessage, { type: 'state' }>;

const RESUME_DELAYS = [0, 700, 1500, 2500, 3800];
const RESUME_DEADLINE_MS = 7000;

export class LiveSender {
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private streamRef: MediaStream | null = null;
  private media: LiveMedia = 'camera';
  private phase: LivePhase = 'ended';
  private sessionId: string | null = null;
  private pendingIce: (IceCandidatePayload | null)[] = [];
  private offerCreated = false;
  private intentional = false;
  private generation = 0;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private reconnectDeadline = 0;

  constructor(private readonly events: LiveEvents) {}

  get currentPhase(): LivePhase {
    return this.phase;
  }

  get currentMedia(): LiveMedia {
    return this.media;
  }

  get active(): boolean {
    return this.streamRef !== null && this.phase !== 'ended' && this.phase !== 'error';
  }

  get hasAudio(): boolean {
    return (this.streamRef?.getAudioTracks().length ?? 0) > 0;
  }

  async start(media: LiveMedia, stream: MediaStream): Promise<void> {
    this.reset(true);
    const generation = this.generation;
    this.media = media;
    this.streamRef = stream;
    this.intentional = false;
    this.setPhase('requesting');
    try {
      const hello = await this.connect(8000);
      if (generation !== this.generation) return;
      this.bindSocket(generation);
      if (hello.sessionId) this.send({ type: 'end', reason: '发送端重新开始投屏' });
      this.send({ type: 'intent', media, audio: this.hasAudio });
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error instanceof Error ? error.message : '无法连接电脑');
    }
  }

  stop(): void {
    if (this.sessionId) this.send({ type: 'end', reason: '发送端结束投屏' });
    this.reset(true);
    this.setPhase('ended');
  }

  setAudioEnabled(enabled: boolean): boolean {
    const tracks = this.streamRef?.getAudioTracks() ?? [];
    for (const track of tracks) track.enabled = enabled;
    return tracks.length > 0;
  }

  async switchCamera(): Promise<'environment' | 'user' | 'none'> {
    if (this.media !== 'camera') return 'none';
    const current = this.streamRef;
    const oldTrack = current?.getVideoTracks()[0];
    if (!current || !oldTrack) return 'none';
    const facing: 'environment' | 'user' = oldTrack.getSettings().facingMode === 'environment' ? 'user' : 'environment';
    const next = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });
    const newTrack = next.getVideoTracks()[0];
    if (!newTrack) {
      next.getTracks().forEach((track) => track.stop());
      throw new Error('无法切换摄像头');
    }
    const sender = this.peer?.getSenders().find((entry) => entry.track?.kind === 'video');
    try {
      if (sender) await sender.replaceTrack(newTrack);
    } catch {
      newTrack.stop();
      throw new Error('切换摄像头失败，请重新开始投屏');
    }
    oldTrack.stop();
    const combined = new MediaStream([newTrack, ...current.getAudioTracks()]);
    this.streamRef = combined;
    this.events.stream(combined);
    return facing;
  }

  private reset(stopTracks: boolean): void {
    this.generation += 1;
    this.intentional = true;
    this.clearTimers();
    if (this.peer) {
      this.peer.onicecandidate = null;
      this.peer.onconnectionstatechange = null;
      try {
        this.peer.close();
      } catch {
        // already closed
      }
      this.peer = null;
    }
    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close(1000, 'client reset');
      } catch {
        // already closing
      }
      this.socket = null;
    }
    if (stopTracks) {
      this.streamRef?.getTracks().forEach((track) => track.stop());
      this.streamRef = null;
    }
    this.pendingIce = [];
    this.offerCreated = false;
    this.sessionId = null;
    this.reconnectAttempt = 0;
    this.reconnectDeadline = 0;
  }

  private connect(timeoutMs: number): Promise<Hello> {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      let socket: WebSocket;
      try {
        socket = new WebSocket(`${scheme}://${location.host}/ws`);
      } catch {
        reject(new Error('无法创建投屏连接'));
        return;
      }
      this.socket = socket;
      let settled = false;
      const timer = window.setTimeout(() => settleError(new Error('连接电脑超时')), timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      };
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(error);
      };
      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'hello') {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(message);
        }
      };
      socket.onerror = () => settleError(new Error('无法连接电脑，请确认电脑端 EasyPush 正在运行'));
      socket.onclose = () => settleError(new Error('与电脑的连接已断开'));
    });
  }

  private bindSocket(generation: number): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => this.handleSocketClose(generation);
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
    }, 20_000);
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'state':
        if (message.sessionId) this.sessionId = message.sessionId;
        this.applyState(message);
        break;
      case 'ready':
        if (message.sessionId) this.sessionId = message.sessionId;
        if (!this.offerCreated) void this.createOffer();
        break;
      case 'answer':
        void this.applyAnswer(message.sdp);
        break;
      case 'ice':
        void this.addRemoteIce(message.candidate);
        break;
      case 'stats':
        this.events.stats(message.stats);
        break;
      case 'notice':
        this.events.notice(message.message);
        break;
      case 'error':
        this.handleServerError(message.code, message.message);
        break;
      case 'ended':
        this.finishFromServer(message.reason);
        break;
      default:
        break;
    }
  }

  private applyState(message: StateMessage): void {
    switch (message.state) {
      case 'awaiting-approval':
        this.setPhase('awaiting-approval');
        break;
      case 'awaiting-takeover':
        this.setPhase('awaiting-takeover');
        break;
      case 'awaiting-offer':
      case 'connecting':
        this.setPhase('connecting');
        break;
      case 'live':
        this.setPhase('live');
        break;
      case 'disconnected':
        this.setPhase('reconnecting');
        break;
      case 'rejected':
        this.finishFromServer(message.reason ?? '接收端拒绝了此次投屏', true);
        break;
      case 'ended':
        this.finishFromServer(message.reason ?? '投屏已结束');
        break;
      case 'failed':
        this.finishFromServer(message.reason ?? '投屏连接失败', true);
        break;
      default:
        break;
    }
  }

  private async createOffer(): Promise<void> {
    const stream = this.streamRef;
    if (!stream || this.offerCreated) return;
    this.offerCreated = true;
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      this.send({
        type: 'ice',
        candidate: candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            }
          : null,
      });
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer || this.intentional) return;
      if (peer.connectionState === 'connected') {
        this.setPhase('live');
      } else if (peer.connectionState === 'failed') {
        this.send({ type: 'end', reason: '视频连接失败' });
        this.fail('视频通道建立失败，请重试');
      }
    };
    for (const track of stream.getTracks()) {
      const sender = peer.addTrack(track, stream);
      if (track.kind === 'video') void this.tuneSender(sender);
    }
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const local = peer.localDescription;
      if (!local) throw new Error('no local description');
      this.send({
        type: 'offer',
        sdp: { type: 'offer', sdp: local.sdp },
        media: this.media,
        audio: this.hasAudio,
      });
      for (const sender of peer.getSenders()) {
        if (sender.track?.kind === 'video') void this.tuneSender(sender);
      }
    } catch {
      this.send({ type: 'end', reason: '无法创建视频连接' });
      this.fail('无法创建视频连接，请重试');
    }
  }

  private async tuneSender(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}];
      const encoding = parameters.encodings[0];
      if (!encoding) return;
      encoding.maxBitrate = this.media === 'screen' ? 8_000_000 : 4_000_000;
      encoding.maxFramerate = 30;
      parameters.degradationPreference = this.media === 'screen' ? 'maintain-resolution' : 'balanced';
      await sender.setParameters(parameters);
    } catch {
      // encoding tuning is best-effort; the call still works without it
    }
  }

  private async applyAnswer(sdp: SdpDescription): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    try {
      await peer.setRemoteDescription({ type: 'answer', sdp: sdp.sdp });
      const pending = [...this.pendingIce];
      this.pendingIce = [];
      for (const candidate of pending) await this.addRemoteIce(candidate, true);
      this.setPhase(this.phase === 'live' ? 'live' : 'connecting');
    } catch {
      this.fail('无法建立视频连接，请重试');
    }
  }

  private async addRemoteIce(candidate: IceCandidatePayload | null, flushing = false): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    if (!peer.remoteDescription) {
      if (!flushing) this.pendingIce.push(candidate);
      return;
    }
    try {
      if (candidate) await peer.addIceCandidate(candidate);
      else await peer.addIceCandidate();
    } catch {
      // a candidate that arrives after teardown is harmless
    }
  }

  private handleServerError(code: string, message: string): void {
    if (code === 'rejected' || code === 'no-session') {
      this.finishFromServer(message, true);
      return;
    }
    this.fail(message);
  }

  private handleSocketClose(generation: number): void {
    if (generation !== this.generation) return;
    this.socket = null;
    if (this.intentional) return;
    if (this.phase === 'ended' || this.phase === 'error') return;
    if (this.phase === 'requesting' || this.phase === 'awaiting-approval' || this.phase === 'awaiting-takeover') {
      this.fail('与电脑的连接已断开，请重新开始投屏');
      return;
    }
    if (!this.sessionId) {
      this.fail('与电脑的连接已断开，请重新开始投屏');
      return;
    }
    this.reconnectDeadline = Date.now() + RESUME_DEADLINE_MS;
    this.reconnectAttempt = 0;
    this.setPhase('reconnecting');
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    if (generation !== this.generation) return;
    if (Date.now() > this.reconnectDeadline || this.reconnectAttempt >= RESUME_DELAYS.length) {
      this.fail('连接中断，投屏已结束');
      return;
    }
    const delay = RESUME_DELAYS[this.reconnectAttempt] ?? 3800;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptResume(generation);
    }, delay);
  }

  private async attemptResume(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const sessionId = this.sessionId;
    if (!sessionId) {
      this.fail('投屏会话已结束');
      return;
    }
    try {
      const hello = await this.connect(1600);
      if (generation !== this.generation) return;
      if (hello.sessionId !== sessionId) {
        this.fail('投屏已在电脑端结束');
        return;
      }
      this.bindSocket(generation);
      this.reconnectAttempt = 0;
      this.send({ type: 'resume', sessionId });
      if (hello.state === 'live') this.setPhase('live');
      else if (hello.state === 'connecting' || hello.state === 'awaiting-offer') this.setPhase('connecting');
    } catch {
      if (generation !== this.generation) return;
      this.scheduleReconnect(generation);
    }
  }

  private finishFromServer(reason: string, isError = false): void {
    this.reset(true);
    this.setPhase(isError ? 'error' : 'ended');
    if (isError) this.events.error(reason);
    else this.events.ended(reason);
  }

  private fail(message: string): void {
    if (this.phase === 'error') return;
    this.reset(true);
    this.setPhase('error');
    this.events.error(message);
  }

  private setPhase(phase: LivePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.events.phase(phase);
  }

  private send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // the close handler will drive reconnection
    }
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}
