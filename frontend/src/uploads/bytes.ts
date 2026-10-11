const UNITS = ["KiB", "MiB", "GiB"];

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n.toLocaleString("en-US")} B`;
  let unit = 0;
  let value = n / 1024;
  while (unit < UNITS.length - 1 && (value >= 1024 || value.toFixed(1) === "1024.0")) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
