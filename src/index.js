// QRCartoon self-hosted redirects.
//
// Scans are answered here, on your own Cloudflare account: the QRCartoon
// server is never contacted during a scan and never sees who scans.
// Editing still happens in the QRCartoon dashboard; this Worker fetches the
// resulting redirect list, checks QRCartoon's signature on it, and keeps it
// in your KV store, so scans keep working even if QRCartoon is offline.

import { PUBLIC_KEYS, QRC_API, WORKER_VERSION } from "./config.js";
import {
	CHALLENGE_PATTERN,
	MAX_BUNDLE_BYTES,
	connectProof,
	parseHosts,
	parseSetupKey,
	resolveScan,
	secretFingerprint,
	verifyBundle,
} from "./core.js";
import { filePage, homePage, json, noticePage, redirect, textPage, wifiPage } from "./pages.js";

const BUNDLE_KEY = "bundle";
const LAST_PULL_KEY = "last_pull";
const REFRESH_INTERVAL_MS = 10_000;

// Per-isolate cache: the stored bundle text and its verified contents, so the
// signature is checked once per change instead of on every scan.
let cache = null; // { raw: string, bundle: object }
let lastRefresh = 0;

/** The stored bundle, verified. A tampered KV value is ignored, not served. */
async function loadBundle(env, targetId) {
	const raw = await env.QR.get(BUNDLE_KEY, { type: "text", cacheTtl: 30 });
	if (!raw) return null;
	if (cache?.raw === raw) return cache.bundle;

	let signed;
	try {
		signed = JSON.parse(raw);
	} catch {
		return null;
	}
	const result = await verifyBundle(signed, { publicKeys: PUBLIC_KEYS, targetId });
	if (!result.ok) return null;
	cache = { raw, bundle: result.bundle };
	return result.bundle;
}

/**
 * Fetch, then remember the outcome ("updated", "http-401", "bad-signature", …)
 * so "Check connection" and /__qrc/status can say why a list isn't arriving.
 * Written only when the outcome changes, to spare KV writes.
 */
async function pull(env) {
	const result = await fetchBundle(env);
	console.log(`[qrcartoon] pull: ${result}`); // visible in Cloudflare → Workers → Logs
	const outcome = result === "unchanged" ? "updated" : result;
	// Not recorded: refresh spam would flip it with "updated" and burn KV writes.
	if (outcome === "http-429") return result;
	const previous = await env.QR.get(LAST_PULL_KEY, "json").catch(() => null);
	if (previous?.result !== outcome) {
		await env.QR.put(LAST_PULL_KEY, JSON.stringify({ result: outcome, at: Date.now() }));
	}
	return result;
}

/** Fetch the latest signed bundle and store it if it is valid and newer. */
async function fetchBundle(env) {
	const setup = parseSetupKey(env.SETUP_KEY);
	if (!setup) return "missing-setup-key";

	let response;
	try {
		response = await fetch(`${QRC_API}/api/selfhost/bundle`, {
			headers: {
				Authorization: `Bearer ${env.SETUP_KEY.trim()}`,
				// Lets QRCartoon tell you when a newer Worker is out. Nothing else.
				"X-QRC-Worker-Version": String(WORKER_VERSION),
			},
			// Never follow redirects. ("error" isn't supported by Workers; with
			// "manual" a redirect arrives as a 3xx and is refused just below.)
			redirect: "manual",
		});
	} catch (error) {
		console.log(`[qrcartoon] fetch failed: ${error?.message ?? error}`);
		return "unreachable"; // QRCartoon offline: keep serving what we have.
	}
	if (!response.ok) {
		// Blocked by the hosting firewall in front of QRCartoon, not by QRCartoon itself.
		const mitigated = response.headers.get("x-vercel-mitigated");
		console.log(`[qrcartoon] HTTP ${response.status}${mitigated ? ` (firewall: ${mitigated})` : ""}`);
		return mitigated ? `firewall-${mitigated}` : `http-${response.status}`;
	}

	const text = await response.text();
	if (text.length > MAX_BUNDLE_BYTES + 1024) return "too-large";

	let signed;
	try {
		signed = JSON.parse(text);
	} catch {
		return "malformed";
	}

	const current = await loadBundle(env, setup.targetId);
	const result = await verifyBundle(signed, {
		publicKeys: PUBLIC_KEYS,
		targetId: setup.targetId,
		minIssuedAt: current?.issuedAt ?? 0,
	});
	if (!result.ok) return result.reason;

	// Unchanged redirects: skip the write (KV free plan allows 1,000 writes/day).
	if (current && JSON.stringify(current.entries) === JSON.stringify(result.bundle.entries)) {
		return "unchanged";
	}
	await env.QR.put(BUNDLE_KEY, JSON.stringify(signed));
	cache = null;
	return "updated";
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const setup = parseSetupKey(env.SETUP_KEY);
		const allowedHosts = parseHosts(env.ALLOWED_HOSTS ?? "") ?? [];

		// Setup check used by the dashboard's "Check connection". Public on
		// purpose; it reveals nothing that scanning wouldn't.
		if (url.pathname === "/__qrc/status") {
			const bundle = setup ? await loadBundle(env, setup.targetId) : null;
			// "Connect" asks with a random challenge; the answer proves this Worker,
			// at this address, holds the setup key (without revealing it).
			const challenge = url.searchParams.get("challenge");
			const proof =
				setup && challenge && CHALLENGE_PATTERN.test(challenge)
					? await connectProof(await secretFingerprint(setup.secret), challenge, url.origin)
					: null;
			return json({
				version: WORKER_VERSION,
				proof,
				target: setup?.targetId ?? null,
				allowedHosts,
				configured: Boolean(setup) && allowedHosts.length > 0,
				issuedAt: bundle?.issuedAt ?? null,
				lastPull: await env.QR.get(LAST_PULL_KEY, "json").catch(() => null),
			});
		}

		// "Something changed, fetch now." Carries no data: whatever is fetched
		// must still pass the signature checks, so anyone may send it. Answers
		// with the outcome (no secrets in it) so the dashboard can explain failures.
		if (url.pathname === "/__qrc/refresh" && request.method === "POST") {
			const now = Date.now();
			if (now - lastRefresh < REFRESH_INTERVAL_MS) return json({ result: "rate-limited" }, 202);
			lastRefresh = now;
			return json({ result: await pull(env) }, 202);
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return noticePage(405, "This address only answers QR code scans.");
		}
		if (url.pathname === "/") {
			// No list yet means not connected: offer the hand-off, with this address
			// filled in. Safe to show anyone: QRCartoon only connects a Worker that
			// proves it holds that account's setup key.
			const connected = setup && (await loadBundle(env, setup.targetId));
			const connectUrl = `${QRC_API}/dashboard/settings?worker=${encodeURIComponent(url.origin)}#selfhost`;
			return homePage(connected ? null : connectUrl);
		}

		if (!setup || allowedHosts.length === 0) {
			return noticePage(503, "This QR service is still being set up. Its owner needs to finish setup in QRCartoon.");
		}

		const bundle = await loadBundle(env, setup.targetId);
		if (!bundle) {
			// First scans after deploy: fetch for next time (throttled, like refresh).
			if (Date.now() - lastRefresh >= REFRESH_INTERVAL_MS) {
				lastRefresh = Date.now();
				ctx.waitUntil(pull(env));
			}
			return noticePage(503, "This QR code isn't available yet.");
		}

		const result = resolveScan(bundle, url.pathname.slice(1), allowedHosts);
		if (result.status === 307) return redirect(result.location);
		if (result.status !== 200) return noticePage(result.status, result.message);
		if (result.kind === "wifi") return wifiPage(result.wifi);
		if (result.kind === "text") return textPage(result.content);
		return filePage(result.kind, result.content);
	},

	// No timer: QRCartoon asks for a pull after every create, edit or delete, and
	// its dashboard has a "Sync now" button. Expiry needs no pull at all: it's
	// checked on every scan.
};
