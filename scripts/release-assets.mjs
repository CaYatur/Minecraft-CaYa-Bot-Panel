/**
 * Only the installer and its checksum file are published. Build leftovers
 * (win-unpacked, .icon-ico, builder-debug.yml, *.blockmap) stay local; the
 * blockmap is only read by an auto-updater, which this app does not use.
 */
export function isReleaseAsset(name) {
  return /setup.*\.exe$/i.test(name) || name === "SHA256SUMS.txt";
}
