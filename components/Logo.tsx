interface LogoProps {
  size?: number;
  className?: string;
}

export default function Logo({ size = 40, className = '' }: LogoProps) {
  const id = `sat-logo-grad-${size}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="SAT Exam OS"
      role="img"
    >
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#84CC16" />
        </linearGradient>
      </defs>

      {/* Rounded square frame */}
      <rect
        x="4"
        y="4"
        width="92"
        height="92"
        rx="20"
        stroke={`url(#${id})`}
        strokeWidth="4"
        fill="none"
      />

      {/* SAT wordmark */}
      <text
        x="50"
        y="62"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="32"
        fontWeight="800"
        fill={`url(#${id})`}
        textAnchor="middle"
        letterSpacing="-1"
      >
        SAT
      </text>
    </svg>
  );
}
