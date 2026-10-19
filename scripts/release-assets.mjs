/**
 * Only the installer and its checksum file are published. Build leftovers
 * (win-unpacked, .icon-ico, builder-debug.yml, *.blockmap) stay local; the
 * blockmap is only read by an auto-updater, which this app does not use.
 */
export function isReleaseAsset(name) {
  return /setup.*\.exe$/i.test(name) || name === "SHA256SUMS.txt";
}

/**
 * The name GitHub stores for an uploaded asset: every character outside
 * letters, digits, ".", "-", "_" and "+" becomes "." (so spaces become dots).
 * SHA256SUMS.txt must list this name, or `sha256sum -c` fails after download.
 */
export function githubAssetName(name) {
  return String(name).replace(/[^A-Za-z0-9._+-]/g, ".");
}

/** "<hash>  <file>" lines, using the name the asset will have on GitHub. */
export function checksumLine(hash, fileName) {
  return `${hash}  ${githubAssetName(fileName)}`;
}
