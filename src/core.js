// Pure logic shared by the Worker and the QRCartoon server (which imports this
// file to apply the exact same rules before signing). No platform APIs beyond
// WebCrypto, so it runs in Cloudflare Workers, Node, Bun and browsers.

export const BUNDLE_VERSION = 1;

/** Same rule as dynamic QR short codes in the dashboard. */
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** Signed bundles larger than this are refused (thousands of QRs fit easily). */
export const MAX_BUNDLE_BYTES = 2_000_000;

/** Longest text, Wi-Fi, contact or event an entry may carry. */
export const MAX_CONTENT_CHARS = 8000;

/**
 * Entries that carry content instead of a destination. The Worker shows text
 * and Wi-Fi details on its own page, and hands contacts and events over as
 * files. None of them can send the visitor anywhere.
 */
export const CONTENT_KINDS = ["text", "wifi", "vcard", "event"];

const CRYPTO_PROTOCOLS = ["bitcoin:", "ethereum:", "litecoin:", "bitcoincash:"];

/** A bundle "from the future" is refused, so a bad clock can't freeze updates. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const SETUP_KEY_PATTERN = /^qrc_sk_([a-f0-9]{20})_([A-Za-z0-9_-]{43})$/;
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const MAX_ALLOWED_HOSTS = 50;

/**
 * "qrc_sk_<targetId>_<secret>" → its parts, or null. The target id tells the
 * Worker which bundle is its own; the secret authenticates the pull.
 */
export function parseSetupKey(key) {
	const match = typeof key === "string" ? SETUP_KEY_PATTERN.exec(key.trim()) : null;
	return match ? { targetId: match[1], secret: match[2] } : null;
}

/**
 * Parse an allowlist ("brand.com, shop.brand.com" or one per line) into
 * lowercase hostnames. Returns null if any entry is invalid, so a typo is
 * reported instead of silently dropped.
 */
export function parseHosts(input) {
	if (typeof input !== "string") return null;
	const hosts = [];
	for (const raw of input.split(/[\s,]+/)) {
		if (!raw) continue;
		const host = raw.toLowerCase().replace(/\.$/, "");
		if (!HOST_PATTERN.test(host)) return null;
		if (!hosts.includes(host)) hosts.push(host);
	}
	return hosts.length <= MAX_ALLOWED_HOSTS ? hosts : null;
}

/**
 * Whether a redirect destination is allowed. Web links must be on an allowed
 * host or one of its subdomains ("brand.com" also allows "shop.brand.com").
 * mailto:, tel: and sms: have no host and are allowed as they are.
 */
export function isAllowedDestination(url, allowedHosts) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:" || parsed.protocol === "http:") {
		if (parsed.username || parsed.password) return false;
		const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
		return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
	}
	return (
		parsed.protocol === "mailto:" ||
		parsed.protocol === "tel:" ||
		parsed.protocol === "sms:" ||
		CRYPTO_PROTOCOLS.includes(parsed.protocol)
	);
}

/** "WIFI:T:WPA;S:<name>;P:<password>;H:true;;" → its parts, or null. */
export function parseWifi(content) {
	if (typeof content !== "string" || !/^WIFI:/i.test(content)) return null;
	const fields = {};
	// Values may contain escaped \; \, \: \\ characters.
	for (const match of content.slice(5).matchAll(/([TSPH]):((?:\\.|[^;])*)/gi)) {
		fields[match[1].toUpperCase()] = match[2].replace(/\\(.)/g, "$1");
	}
	if (!fields.S) return null;
	return {
		ssid: fields.S,
		password: fields.P || "",
		security: fields.T && fields.T.toLowerCase() !== "nopass" ? fields.T : "",
		hidden: fields.H?.toLowerCase() === "true",
	};
}

/** Whether a content entry is well-formed for its kind. */
export function isValidContent(kind, content) {
	if (!CONTENT_KINDS.includes(kind) || typeof content !== "string") return false;
	if (!content.trim() || content.length > MAX_CONTENT_CHARS) return false;
	if (kind === "wifi") return parseWifi(content) !== null;
	if (kind === "vcard") return /^BEGIN:VCARD\r?\n/i.test(content);
	if (kind === "event") return /^BEGIN:VCALENDAR\r?\n/i.test(content);
	return true;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of a setup key's secret, hex: the fingerprint QRCartoon stores. */
export async function secretFingerprint(secret) {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

export const CHALLENGE_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Answer to QRCartoon's connect challenge: HMAC-SHA256 of the challenge and
 * the address it was asked at, keyed by the secret's fingerprint. Only a
 * Worker holding the setup key can make it, and it names its own address, so
 * a look-alike server can't relay the challenge to the real Worker and pass.
 */
export async function connectProof(fingerprintHex, challenge, origin) {
	const keyBytes = new Uint8Array(fingerprintHex.match(/../g).map((h) => parseInt(h, 16)));
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${challenge}\n${origin}`));
	return toHex(new Uint8Array(mac));
}

function base64ToBytes(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Check a signed bundle `{ payload, sig }`. It must be signed by one of the
 * QRCartoon public keys, be meant for this Worker's target, and not be older
 * than `minIssuedAt` (stops replaying an old bundle).
 *
 * @returns {Promise<{ ok: true, bundle: any } | { ok: false, reason: string }>}
 */
export async function verifyBundle(signed, { publicKeys, targetId, minIssuedAt = 0, now = Date.now() }) {
	if (!signed || typeof signed.payload !== "string" || typeof signed.sig !== "string") {
		return { ok: false, reason: "malformed" };
	}
	if (signed.payload.length > MAX_BUNDLE_BYTES) return { ok: false, reason: "too-large" };

	let signature;
	try {
		signature = base64ToBytes(signed.sig);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	const data = new TextEncoder().encode(signed.payload);

	let verified = false;
	for (const publicKey of publicKeys) {
		try {
			const key = await crypto.subtle.importKey("raw", base64ToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
			if (await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data)) {
				verified = true;
				break;
			}
		} catch {
			// A malformed key or signature simply doesn't verify.
		}
	}
	if (!verified) return { ok: false, reason: "bad-signature" };

	let bundle;
	try {
		bundle = JSON.parse(signed.payload);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (bundle?.v !== BUNDLE_VERSION) return { ok: false, reason: "unsupported-version" };
	if (bundle.target !== targetId) return { ok: false, reason: "wrong-target" };
	if (!Number.isFinite(bundle.issuedAt) || bundle.issuedAt > now + MAX_CLOCK_SKEW_MS) {
		return { ok: false, reason: "bad-timestamp" };
	}
	if (bundle.issuedAt < minIssuedAt) return { ok: false, reason: "older-than-current" };
	if (!bundle.entries || typeof bundle.entries !== "object" || Array.isArray(bundle.entries)) {
		return { ok: false, reason: "malformed" };
	}
	return { ok: true, bundle };
}

/**
 * What a scan of `slug` should do. Rules are applied again here even though the
 * server already applied them: the Worker never trusts its inputs.
 *
 * @returns {{ status: 307, location: string }
 *   | { status: 200, kind: "text" | "vcard" | "event", content: string }
 *   | { status: 200, kind: "wifi", wifi: NonNullable<ReturnType<typeof parseWifi>> }
 *   | { status: number, message: string }}
 */
export function resolveScan(bundle, slug, allowedHosts, now = Date.now()) {
	const entry = SLUG_PATTERN.test(slug) && Object.hasOwn(bundle.entries, slug) ? bundle.entries[slug] : null;
	const isRedirect = typeof entry?.u === "string";
	if (!entry || (!isRedirect && !isValidContent(entry.k, entry.c))) {
		return { status: 404, message: "This QR code doesn't exist." };
	}
	if (entry.off) return { status: 410, message: "This QR code has been turned off by its owner." };
	if (Number.isFinite(entry.exp) && now >= entry.exp) return { status: 410, message: "This QR code has expired." };
	if (!isRedirect) {
		return entry.k === "wifi"
			? { status: 200, kind: "wifi", wifi: parseWifi(entry.c) }
			: { status: 200, kind: entry.k, content: entry.c };
	}
	if (!isAllowedDestination(entry.u, allowedHosts)) {
		return { status: 403, message: "This QR code points somewhere its owner hasn't allowed." };
	}
	return { status: 307, location: entry.u };
}
