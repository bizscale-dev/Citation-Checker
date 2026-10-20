// Small inline icons (stroke style, inherit currentColor).
const Svg = ({ children, size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
);

export const Logo = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#6366f1" />
        <stop offset="1" stopColor="#a855f7" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="16" fill="url(#lg)" />
    <path d="M32 12c-8.3 0-15 6.5-15 14.6C17 37.5 32 52 32 52s15-14.5 15-25.4C47 18.5 40.3 12 32 12z" fill="#fff" />
    <path d="M25.5 27.5l4.5 4.5 8.5-9" fill="none" stroke="#7c3aed" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconBuilding = (p) => (
  <Svg {...p}>
    <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1" />
  </Svg>
);
export const IconPhone = (p) => (
  <Svg {...p}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
  </Svg>
);
export const IconMail = (p) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 6-10 7L2 6" />
  </Svg>
);
export const IconPin = (p) => (
  <Svg {...p}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
    <circle cx="12" cy="10" r="3" />
  </Svg>
);
export const IconGoogle = (p) => (
  <Svg {...p}>
    <path d="M21 12.2c0-.7-.1-1.3-.2-2H12v3.8h5a4.4 4.4 0 0 1-1.9 2.8v2.4h3.1c1.8-1.7 2.8-4.1 2.8-7z" />
    <path d="M12 21c2.6 0 4.7-.9 6.3-2.3l-3.1-2.4c-.9.6-1.9.9-3.2.9a5.6 5.6 0 0 1-5.2-3.8H3.6v2.4A9.5 9.5 0 0 0 12 21z" />
    <path d="M6.8 13.4a5.6 5.6 0 0 1 0-3.6V7.4H3.6a9.5 9.5 0 0 0 0 8.4z" />
    <path d="M12 6.8c1.4 0 2.6.5 3.6 1.4l2.7-2.7A9.5 9.5 0 0 0 3.6 7.4l3.2 2.4A5.6 5.6 0 0 1 12 6.8z" />
  </Svg>
);
export const IconLink = (p) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);
export const IconCheck = (p) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const IconX = (p) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const IconAlert = (p) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
export const IconMinus = (p) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const IconLock = (p) => (
  <Svg {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Svg>
);
export const IconRefresh = (p) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5" />
  </Svg>
);
export const IconClipboard = (p) => (
  <Svg {...p}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </Svg>
);
export const IconExternal = (p) => (
  <Svg {...p}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
);
export const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
export const IconSparkle = (p) => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
  </Svg>
);
export const IconChrome = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="4" />
    <path d="M21.2 8H12M3.9 6.1 8.5 14M10.9 21.9l4.6-7.9" />
  </Svg>
);
export const IconGlobe = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </Svg>
);
export const IconUser = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);
export const Spinner =({ size = 16 }) => <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
