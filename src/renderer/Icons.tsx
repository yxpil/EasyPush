import type { SVGProps } from 'react';

const PATHS: Record<string, string> = {
  cast: 'M3 18v3M3 14a7 7 0 0 1 7 7M3 9a12 12 0 0 1 12 12M3 5V4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.89a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4.6H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z',
  logs: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  minimize: 'M5 12h14',
  maximize: 'M5 5h14v14H5z',
  restore: 'M8 8V5h11v11h-3M5 8h11v11H5z',
  close: 'M6 6l12 12M18 6 6 18',
  phone: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 0v1h4V3M10 18h4',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm8 9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9.5h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  next: 'M6 5.5v13l9-6.5zM18 5v14',
  previous: 'M18 5.5v13L9 12zM6 5v14',
  volume: 'M4 9v6h4l5 4V5L8 9H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9H4ZM16 9l5 6M21 9l-5 6',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  copy: 'M9 9h10v12H9zM5 15H3V3h12v2',
  check: 'M4 12l5 5L20 6',
  warning: 'M12 3 2 21h20L12 3Zm0 6v6m0 3h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  folder: 'M3 5h6l2 2h10v12H3z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Zm-3 9 2 2 4-4',
  wifi: 'M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v3M17 20h3M14 18v3',
  expand: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
  chevron: 'M8 10l4 4 4-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  speaker: 'M5 9v6h3l4 4V5L8 9H5Zm11-1a5 5 0 0 1 0 8',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  laptop: 'M5 5h14v10H5zM3 19h18l-2-4H5l-2 4Z',
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: keyof typeof PATHS | string;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  const path = PATHS[name] ?? PATHS['cast'];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={path} />
    </svg>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
