/** Blocky Minecraft-bot head mark: zinc chassis, emerald "online" eyes, red antenna tip. */
export function BotLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} shapeRendering="crispEdges" aria-hidden="true">
      <rect x="7" y="0" width="2" height="2" fill="#71717a" />
      <rect x="7" y="0" width="2" height="1" fill="#ef4444" />
      <rect x="3" y="3" width="10" height="11" fill="#27272a" />
      <rect x="3" y="3" width="10" height="1" fill="#52525b" />
      <rect x="3" y="3" width="1" height="11" fill="#3f3f46" />
      <rect x="12" y="3" width="1" height="11" fill="#18181b" />
      <rect x="3" y="13" width="10" height="1" fill="#18181b" />
      <rect x="5" y="6" width="2" height="2" fill="#10b981" />
      <rect x="9" y="6" width="2" height="2" fill="#10b981" />
      <rect x="5" y="10" width="6" height="1" fill="#52525b" />
    </svg>
  );
}
