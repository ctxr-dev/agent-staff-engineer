// lib/wrapper.mjs
// Marker-aware merge used to build and refresh wrapper files. Extracted from
// install.mjs so it is unit-testable and so install_memory_seeds.mjs can
// eventually share the implementation.

/**
 * Merge above-marker content with an existing wrapper while preserving any
 * user-authored text below the marker byte-for-byte.
 *
 * Rules:
 *  - Above-marker content is normalised to end with a single newline.
 *  - The marker is followed by exactly one newline.
 *  - Split on the FIRST occurrence of the marker in the existing content.
 *    The first marker is always the installer-owned one; anything after
 *    (including any marker the user pasted as prose inside their overrides)
 *    is treated as below-marker content and preserved. Splitting on the
 *    last occurrence would silently drop any user content that precedes a
 *    user-pasted marker.
 *  - Missing marker in existing content: inject the refreshed above-section
 *    and preserve the entirety of the existing content after a warning
 *    comment, so user edits made in the above-marker zone are not silently
 *    lost.
 *  - No existing content: return `above + marker + \n\n`.
 *
 * @param {string | null} existing  current wrapper content, or null for a fresh install
 * @param {string} above            the regenerated above-marker content (frontmatter, notice, include instruction)
 * @param {string} marker           the exact marker string from ops.config.json -> paths.wrappers.marker
 * @returns {string} the merged wrapper content
 */
export function mergeWrapper(existing, above, marker) {
  const aboveNorm = above.replace(/\n*$/, "\n");
  const aboveWithMarker = `${aboveNorm}${marker}\n`;
  if (existing == null) {
    return `${aboveWithMarker}\n`;
  }
  const idx = existing.indexOf(marker);
  if (idx < 0) {
    return (
      aboveWithMarker +
      `\n<!-- existing wrapper had no marker; previous content preserved below. Move your edits under the marker so they survive the next update. -->\n` +
      existing
    );
  }
  const after = existing.slice(idx + marker.length);
  return aboveWithMarker + after.replace(/^\n+/, "\n");
}

/** Split a wrapper at its marker. Returns { above, below } where below includes no leading marker. */
export function splitAtMarker(content, marker) {
  const idx = content.indexOf(marker);
  if (idx < 0) return { above: null, below: null };
  return {
    above: content.slice(0, idx),
    below: content.slice(idx + marker.length),
  };
}
