/**
 * Fork-owned copy of pi-ai's `utils/hash.ts` (`shortHash` only).
 *
 * Provenance: @earendil-works/pi-ai 1.3.0, `dist/utils/hash.js` (verbatim).
 * Copied because `convertMessages` (src/pi-ai-compat/convert-messages.ts)
 * needs it and pi-ai does not re-export it from its root entry; owning it
 * lets pi-ai live in `peerDependencies` (avoids the host-provided-packages
 * warning). Synced whenever the @earendil-works/pi-ai devDependency pin moves — the procedure lives in the repository's agent docs. Do not edit the logic here
 * except to mirror an upstream change.
 */

/** Fast deterministic hash to shorten long strings */
export function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
