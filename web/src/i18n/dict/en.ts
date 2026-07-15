import type { MessageTree } from "../types";

export const en: MessageTree = {
  app: {
    name: "CaYa Bot Panel",
    roadmap: "Roadmap: TODO.md",
    principleI1: "System messages are never written to game chat (I1)."
  },
  nav: {
    panel: "Dashboard",
    automations: "Automations",
    schematics: "Schematics",
    servers: "Servers",
    settings: "Settings"
  },
  connection: {
    connected: "Connected",
    disconnected: "Disconnected",
    apiConnected: "API connection",
    online: "Online",
    offline: "Offline",
    none: "None"
  },
  common: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    add: "Add",
    refresh: "Refresh",
    start: "Start",
    stop: "Stop",
    yes: "Yes",
    no: "No",
    loading: "Loading…",
    error: "Error",
    success: "Success",
    confirm: "Confirm",
    back: "Back",
    search: "Search",
    apply: "Apply",
    reset: "Reset",
    close: "Close",
    enabled: "On",
    disabled: "Off",
    open: "Open",
    closed: "Closed",
    optional: "optional",
    unknown: "unknown",
    all: "All",
    none: "None"
  },
  language: {
    title: "Language",
    label: "Interface language",
    auto: "System default",
    autoHint: "Use OS/browser language (Turkish if tr*, otherwise English)",
    en: "English",
    tr: "Turkish",
    current: "Active language",
    systemDetected: "Detected system language",
    fallbackNote: "If the system language is missing or unsupported, English is used."
  },
  status: {
    stopped: "Stopped",
    connecting: "Connecting",
    online: "Online",
    reconnecting: "Reconnecting",
    kicked: "Kicked",
    error: "Error"
  },
  dashboard: {
    title: "Bots",
    onlineCount: "{online}/{total} online",
    startAll: "▶ Start all",
    stopAll: "■ Stop all",
    addBot: "+ Add bot",
    empty: 'No bots yet. Create your first bot with "+ Add bot".',
    startingAll: "Starting bots gradually…",
    stoppingAll: "Stopping all bots",
    systemLogs: "System logs",
    allChat: "All chat"
  },
  settings: {
    title: "Settings",
    botsOnline: "{online}/{total} bots online",
    system: "System",
    botCount: "Bot count",
    serverProfiles: "Server profiles",
    listening: "Listening",
    listeningValue: "127.0.0.1 (localhost)",
    roles: "Roles (presets)",
    rolesHint: "One-click rule packs — added from Automations templates, then editable.",
    roleLogger: "Lumberjack",
    roleMiner: "Miner",
    roleGuard: "Guard",
    roleGatherer: "Gatherer",
    roleCourier: "Courier",
    backlogNote: "Anti-AFK, 3D viewer, Discord webhook → Backlog. Critical events: Log panel + toasts.",
    principles: "Core principles",
    p1: "System messages are never written to game chat (panel Log only).",
    p2: "Combat RealismLayer cannot be disabled; range / LOS / tempo are enforced.",
    p3: "Chat automations default to authorized player list.",
    p6: "Task priority: survive > defend > user > automation."
  },
  servers: {
    title: "Servers",
    add: "+ Add server",
    empty: "No server profiles yet.",
    host: "Host",
    port: "Port",
    version: "Version",
    name: "Name",
    note: "Note",
    save: "Save profile",
    deleteConfirm: "Delete server profile {name}?"
  },
  schematics: {
    title: "Schematics",
    upload: "Upload",
    empty: "No schematics yet.",
    materials: "Materials",
    blocks: "blocks",
    deleteConfirm: "Delete schematic {name}?"
  },
  automations: {
    title: "Automations",
    add: "+ New rule",
    empty: "No rules yet.",
    enabled: "Enabled",
    disabled: "Disabled"
  },
  botDetail: {
    notFound: "Bot not found.",
    backToPanel: "← Back to dashboard",
    autostart: "Autostart",
    start: "▶ Start",
    stop: "■ Stop",
    delete: "Delete",
    deleteConfirm: "{name} will be deleted. This cannot be undone.",
    deleted: "{name} deleted",
    resetWork: "↺ Reset work",
    resetWorkTitle: "Drop tasks, movement, combat and build — bot stays connected",
    resetWorkConfirm:
      "{name} — reset all work?\n\nTask queue, movement, follow/attack/protect, build and pathfinder will stop.\nBot stays connected to the Minecraft server (no restart needed).",
    resetWorkDone: "All work reset — bot ready",
    health: "Health",
    food: "Hunger",
    level: "Level {n}",
    tabs: {
      chat: "💬 Chat",
      logs: "📋 Logs",
      inventory: "🎒 Inventory",
      tasks: "📌 Tasks",
      combat: "⚔️ Combat",
      survival: "🍖 Survival",
      work: "🪓 Work",
      build: "🏗️ Build"
    }
  },
  tasks: {
    run: "Run",
    stop: "■ Stop",
    reset: "↺ Reset",
    resetConfirm:
      "Reset all work?\nTasks, movement, follow/attack and build will stop — bot stays connected.",
    resetDone: "All work reset",
    stopped: "Movement stopped",
    cmdHelp: "Command: goto 100 64 -200",
    cmdPlaceholder: "Command: goto 100 64 -200",
    quickMove: "Quick move",
    go: "Go",
    playerPlaceholder: "Player name",
    goToPlayer: "Go to player"
  },
  combat: {
    title: "Combat",
    offlineHint: "Bot offline — settings still save; combat tasks run when online.",
    status: "Status",
    leaveCombat: "■ Leave combat",
    flee: "Flee",
    modes: {
      idle: "Idle",
      attacking: "Attacking",
      defending: "Defending",
      fleeing: "Fleeing",
      protecting: "Protecting"
    },
    target: "Target",
    noTarget: "No active target",
    selfDefense: "Self-defense · idle",
    selfDefenseHint:
      "When idle or following, fight zombies etc. in range; flee if health is low. Applied instantly.",
    defendOff: "Off",
    defendMob: "Mob",
    defendPlayer: "Player",
    defendAll: "All",
    scanRange: "Scan range (blocks)",
    fleeHealth: "Flee health threshold",
    chaseDistance: "Chase distance",
    cleaveTitle: "Cleave · while locked on",
    cleaveOn: "on",
    cleaveOff: "off",
    cleaveHint:
      "While locked on a target (attack/defend), nearby mobs or players that damaged you also take hits. Main target stays. Toggle here.",
    cleaveToggleOn: "Cleave on",
    cleaveToggleOff: "Cleave off",
    cleaveMobs: "Mobs",
    cleavePlayers: "Damaging players",
    cleaveRange: "Cleave range (blocks)",
    escort: "Escort protect",
    escortNone: "nobody → Nearby players · Protect",
    combatLeft: "Combat stopped"
  },
  build: {
    title: "Build",
    start: "▶ Build",
    stop: "■ Stop",
    collectMissing: "Collect missing",
    materials: "Materials",
    live: "live",
    now: "Now",
    missing: "{n} missing",
    phases: {
      idle: "Idle",
      preparing: "Preparing",
      acquiring: "Gathering materials",
      building: "Building",
      cleanup: "Scaffold cleanup",
      done: "Done",
      failed: "Error",
      cancelled: "Cancelled"
    },
    stopped: "Build stopped"
  },
  survival: {
    title: "Survival",
    autoEat: "Auto eat",
    fallGuard: "Fall recovery (MLG)"
  },
  work: {
    title: "Gather & craft",
    collectWood: "Collect wood",
    mine: "Mine",
    craft: "Craft"
  },
  inventory: {
    title: "Inventory",
    empty: "Empty inventory",
    equip: "Equip",
    drop: "Drop"
  },
  chat: {
    placeholder: "Message…",
    send: "Send",
    empty: "No messages yet"
  },
  logs: {
    title: "Logs",
    empty: "No logs yet",
    clear: "Clear view"
  },
  nearby: {
    title: "Nearby players",
    follow: "Follow",
    attack: "Attack",
    protect: "Protect",
    empty: "No nearby players"
  },
  addBot: {
    title: "Add bot",
    username: "Username",
    server: "Server",
    create: "Create"
  },
  toast: {
    saved: "Saved",
    failed: "Failed"
  }
};
