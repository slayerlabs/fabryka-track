const paths = {
  flask: [
    "M9 3h6M10 3v6l-6 10a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2L14 9V3",
    "M7 15h10",
  ],
  play: ["M9 7l8 5-8 5V7", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"],
  layers: ["m12 3 10 5-10 5L2 8l10-5", "m2 12 10 5 10-5M2 16l10 5 10-5"],
  chart: ["M5 20v-7M12 20V4M19 20V9"],
  trophy: [
    "M8 3h8v6a4 4 0 0 1-8 0V3",
    "M8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 13v7m-5 1h10",
  ],
  clock: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", "M12 6v6l4 2"],
  trend: ["m3 17 6-6 4 4 8-10", "M15 5h6v6"],
  database: [
    "M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3",
    "M4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3",
  ],
  book: [
    "M12 5v16M12 5C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-2-1-6-2-10 1",
  ],
  target: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    "M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0M12 12h.01",
  ],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-4",
    "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0m4-4a4 4 0 0 1 0 8",
  ],
  search: ["M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0"],
  user: ["M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2"],
} as const;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`ui-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name].map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
}
