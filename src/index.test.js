// End-to-end Worker test: fake KV + fake QRCartoon server, real signatures.
// Run from the repo root with `bun test`.
import { describe, expect, mock, test, beforeEach, setSystemTime } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

const pair = generateKeyPairSync("ed25519");
const PUBLIC = Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
mock.module("./config.js", () => ({ QRC_API: "https://qrc.test", PUBLIC_KEYS: [PUBLIC], WORKER_VERSION: 3 }));
const { default: worker } = await import("./index.js");

const TARGET = "0123456789abcdef0123";
const SETUP_KEY = `qrc_sk_${TARGET}_${"a".repeat(43)}`;

function signed(entries, issuedAt, target = TARGET) {
	const payload = JSON.stringify({ v: 1, target, issuedAt, entries });
	return { payload, sig: sign(null, Buffer.from(payload), pair.privateKey).toString("base64") };
}

function makeEnv(overrides = {}) {
	const store = new Map();
	return {
		store,
		SETUP_KEY,
		ALLOWED_HOSTS: "brand.com",
		QR: {
			// Mirrors KV: get(key, "json") / get(key, { type: "json" }) parses.
			get: async (key, opts) => {
				const value = store.get(key) ?? null;
				const type = typeof opts === "string" ? opts : opts?.type;
				return value !== null && type === "json" ? JSON.parse(value) : value;
			},
			put: async (key, value) => void store.set(key, value),
		},
		...overrides,
	};
}

// Runs waitUntil work to completion so tests can assert on its effects.
function makeCtx() {
	const pending = [];
	return { waitUntil: (p) => pending.push(p), done: () => Promise.all(pending) };
}

let serverResponse;
beforeEach(() => {
	globalThis.fetch = mock(async (url, init) => {
		expect(url).toBe("https://qrc.test/api/selfhost/bundle");
		expect(init.headers.Authorization).toBe(`Bearer ${SETUP_KEY}`);
		expect(init.headers["X-QRC-Worker-Version"]).toMatch(/^\d+$/);
		return new Response(JSON.stringify(serverResponse));
	});
});

async function scan(env, path) {
	const ctx = makeCtx();
	const res = await worker.fetch(new Request(`https://w.test${path}`), env, ctx);
	await ctx.done();
	return res;
}

// Pulls happen on "refresh", throttled to one per 10 s, so each test pull moves the clock on.
let clock = Date.now();
async function pullNow(env) {
	clock += 11_000;
	setSystemTime(new Date(clock));
	const res = await worker.fetch(new Request("https://w.test/__qrc/refresh", { method: "POST" }), env, makeCtx());
	return (await res.json()).result;
}

describe("worker", () => {
	test("has no timer: pulls only when asked", () => {
		expect(worker.scheduled).toBeUndefined();
	});

	test("refuses to serve until fully configured", async () => {
		expect((await scan(makeEnv({ ALLOWED_HOSTS: "" }), "/menu1")).status).toBe(503);
		expect((await scan(makeEnv({ SETUP_KEY: "nope" }), "/menu1")).status).toBe(503);
	});

	test("pulls a signed list, then redirects without contacting the server", async () => {
		const env = makeEnv();
		serverResponse = signed({ menu1: { u: "https://brand.com/menu" } }, 1_000);
		await pullNow(env);

		globalThis.fetch.mockClear();
		const res = await scan(env, "/menu1");
		expect(res.status).toBe(307);
		expect(res.headers.get("Location")).toBe("https://brand.com/menu");
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect((await scan(env, "/other1")).status).toBe(404);
	});

	test("ignores a tampered KV value and a forged or replayed list", async () => {
		const env = makeEnv();
		serverResponse = signed({ menu1: { u: "https://brand.com/v2" } }, 2_000);
		await pullNow(env);

		// Someone edits KV directly: the signature no longer matches, nothing is served.
		const stored = JSON.parse(env.store.get("bundle"));
		env.store.set("bundle", JSON.stringify({ ...stored, payload: stored.payload.replace("brand.com/v2", "evil.com/x") }));
		expect((await scan(env, "/menu1")).status).toBe(503);

		// Restore, then try an older list (replay) and one for another target.
		env.store.set("bundle", JSON.stringify(stored));
		serverResponse = signed({ menu1: { u: "https://brand.com/v1" } }, 1_500);
		await pullNow(env);
		serverResponse = signed({ menu1: { u: "https://brand.com/x" } }, 3_000, "ffffffffffffffffffff");
		await pullNow(env);
		expect((await scan(env, "/menu1")).headers.get("Location")).toBe("https://brand.com/v2");
	});

	test("ALLOWED_HOSTS overrides a validly signed list", async () => {
		const env = makeEnv();
		serverResponse = signed({ evil1: { u: "https://evil.com/phish" } }, 1_000);
		await pullNow(env);
		expect((await scan(env, "/evil1")).status).toBe(403);
	});

	test("shows text and Wi-Fi safely, hands over contacts and events as files", async () => {
		const env = makeEnv();
		serverResponse = signed(
			{
				note1: { k: "text", c: "<script>alert(1)</script> hi" },
				wifi1: { k: "wifi", c: "WIFI:T:WPA;S:Cafe\\;Guest;P:p<w>d;;" },
				card1: { k: "vcard", c: "BEGIN:VCARD\nVERSION:3.0\nFN:Ann\nEND:VCARD" },
				cal01: { k: "event", c: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n" },
				bad01: { k: "vcard", c: "<html>not a card</html>" },
			},
			1_000,
		);
		await pullNow(env);

		const note = await scan(env, "/note1");
		const html = await note.text();
		expect(note.status).toBe(200);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; hi");
		expect(html).not.toContain("<script>alert(1)");
		// Only the page's own nonce'd script may run.
		const nonce = /script-src 'nonce-([\w-]+)'/.exec(note.headers.get("Content-Security-Policy"))[1];
		expect(html.match(/<script/g).length).toBe(1);
		expect(html).toContain(`<script nonce="${nonce}">`);

		const wifi = await (await scan(env, "/wifi1")).text();
		expect(wifi).toContain("Cafe;Guest");
		expect(wifi).toContain('data-value="p&lt;w&gt;d"');

		const card = await scan(env, "/card1");
		expect(card.headers.get("Content-Type")).toContain("text/vcard");
		const cal = await scan(env, "/cal01");
		expect(cal.headers.get("Content-Disposition")).toContain("event.ics");
		expect((await scan(env, "/bad01")).status).toBe(404);
	});

	test("home page hands off to QRCartoon until connected, then just explains", async () => {
		const env = makeEnv();
		const setupPage = await (await scan(env, "/")).text();
		expect(setupPage).toContain(`href="https://qrc.test/dashboard/settings?worker=${encodeURIComponent("https://w.test")}#selfhost"`);

		serverResponse = signed({}, 1_000);
		await pullNow(env);
		const home = await (await scan(env, "/")).text();
		expect(home).not.toContain("/dashboard/settings");
		expect(home).toContain("qrcartoon.com");
		// No external resources: scanning tells nobody but this Worker.
		expect(home).not.toMatch(/(src|href)="https?:\/\/(?!www\.qrcartoon\.com\/\?)/);
		expect((await scan(env, "/missing1")).status).toBe(404);
	});

	test("answers the connect challenge for its own address only", async () => {
		const { connectProof, secretFingerprint } = await import("./core.js");
		const challenge = "0123456789abcdef0123456789abcdef";
		const env = makeEnv();
		const { proof } = await (await scan(env, `/__qrc/status?challenge=${challenge}`)).json();
		const fingerprint = await secretFingerprint("a".repeat(43));
		expect(proof).toBe(await connectProof(fingerprint, challenge, "https://w.test"));
		// A look-alike server relaying the challenge gets a proof for *this* address, not its own.
		expect(proof).not.toBe(await connectProof(fingerprint, challenge, "https://evil.test"));
		// Another key, or a malformed challenge, gets nothing useful.
		const other = await (await scan(makeEnv({ SETUP_KEY: `qrc_sk_${TARGET}_${"b".repeat(43)}` }), `/__qrc/status?challenge=${challenge}`)).json();
		expect(other.proof).not.toBe(proof);
		expect((await (await scan(env, "/__qrc/status?challenge=nothex")).json()).proof).toBeNull();
	});

	test("status endpoint reports setup without exposing redirects", async () => {
		const env = makeEnv();
		const body = await (await scan(env, "/__qrc/status")).json();
		expect(body).toEqual({ version: 3, proof: null, target: TARGET, allowedHosts: ["brand.com"], configured: true, issuedAt: null, lastPull: null });
	});

	test("refresh reports why a list didn't arrive, and status remembers it", async () => {
		const env = makeEnv();
		setSystemTime(new Date(Date.now() + 60_000)); // past the refresh throttle from earlier tests
		globalThis.fetch = mock(async () => new Response('{"error":"Invalid setup key"}', { status: 401 }));
		const refresh = await worker.fetch(new Request("https://w.test/__qrc/refresh", { method: "POST" }), env, makeCtx());
		expect(await refresh.json()).toEqual({ result: "http-401" });
		const status = await (await scan(env, "/__qrc/status")).json();
		expect(status.lastPull.result).toBe("http-401");
		setSystemTime();
	});
});
