export function StatBar({
  value,
  max,
  color,
  label,
  icon
}: {
  value: number;
  max: number;
  color: string;
  label: string;
  icon: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2" title={`${label}: ${value}/${max}`}>
      <span className="w-4 text-center text-xs">{icon}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono w-9 text-right text-[10px] text-zinc-500">
        {Number.isInteger(value) ? value : value.toFixed(1)}
      </span>
    </div>
  );
}
