// The pages people see when they scan. Everything is inline (styles, icons,
// script): a page never loads anything from QRCartoon or anywhere else, so
// opening one tells nobody but this Worker that a code was scanned.

const SITE = "https://www.qrcartoon.com/?utm_source=selfhosted&utm_medium=scan-page";

const SECURITY_HEADERS = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

// Lucide icons (ISC license), drawn with the current text color.
const ICONS = {
	qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
	notFound: '<path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	gone: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
	blocked: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
	wait: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
	wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
	text: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
};

const svg = (name, size = 28) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(svg("qr").replace("currentColor", "#403d39"))}`;

const CSS = `
:root{--bg:#fdf6ee;--card:#fff;--text:#3b2a20;--muted:#6f5a4c;--line:#403d39;--shadow:#ffb6b9;--btn:#111;--btn-text:#fff;--soft:#f6ebdf;--icon-bg:#ffe3e4}
@media (prefers-color-scheme:dark){:root{--bg:#1d1916;--card:#26211d;--text:#f5ebe1;--muted:#c9b8a8;--line:#e8d9c8;--shadow:#d9777d;--btn:#f5ebe1;--btn-text:#1d1916;--soft:#322b26;--icon-bg:#4a2f31}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:440px;background:var(--card);border:2px solid var(--line);border-radius:24px;box-shadow:6px 6px 0 var(--shadow);padding:32px 24px;text-align:center}
.icon{width:64px;height:64px;margin:0 auto 16px;display:grid;place-items:center;border-radius:50%;background:var(--icon-bg);border:2px solid var(--line)}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 8px;overflow-wrap:anywhere}
p{margin:0 0 12px;color:var(--muted)}
.box{text-align:left;background:var(--soft);border-radius:14px;padding:14px 16px;margin:16px 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;background:var(--soft);border-radius:14px;padding:12px 14px;margin:10px 0}
.row small{display:block;color:var(--muted);font-size:.8rem}
.row strong{display:block;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}
.actions{display:flex;gap:6px;flex-shrink:0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:999px;border:2px solid var(--line);background:var(--btn);color:var(--btn-text);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--text);min-height:36px;padding:0 12px;font-size:.875rem}
.btn:focus-visible{outline:3px solid var(--shadow);outline-offset:2px}
.badge{display:inline-block;font-size:.8rem;border:1.5px solid var(--line);border-radius:999px;padding:2px 10px;margin:4px 2px}
.hint{font-size:.9rem;margin-top:16px}
footer{font-size:.85rem;color:var(--muted);text-align:center}
footer a{color:inherit;font-weight:600}
`;

// Copy and show/hide buttons on the text and Wi-Fi pages.
const SCRIPT = `
for (const b of document.querySelectorAll("[data-copy]")) b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).dataset.value); }
  catch { return; }
  const label = b.textContent; b.textContent = "Copied!"; setTimeout(() => (b.textContent = label), 1500);
});
for (const b of document.querySelectorAll("[data-reveal]")) b.addEventListener("click", () => {
  const el = document.getElementById(b.dataset.reveal), shown = b.getAttribute("aria-pressed") === "true";
  el.textContent = shown ? "••••••••" : el.dataset.value;
  b.setAttribute("aria-pressed", String(!shown)); b.textContent = shown ? "Show" : "Hide";
});
`;

export function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function render(status, { title, icon, body, interactive = false }) {
	const nonce = interactive ? crypto.randomUUID() : "";
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<main class="card">
<div class="icon">${svg(icon)}</div>
${body}
</main>
<footer>QR code powered by <a href="${SITE}" target="_blank" rel="noopener">QRCartoon</a></footer>
${interactive ? `<script nonce="${nonce}">${SCRIPT}</script>` : ""}
</body>
</html>`;
	const csp = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src data:",
		interactive ? `script-src 'nonce-${nonce}'` : "",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].filter(Boolean);
	return new Response(html, {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp.join("; ") },
	});
}

const NOTICES = {
	403: { icon: "blocked", heading: "Link blocked" },
	404: { icon: "notFound", heading: "QR code not found" },
	405: { icon: "blocked", heading: "Not allowed" },
	410: { icon: "gone", heading: "No longer available" },
	503: { icon: "wait", heading: "Almost ready" },
};

/** An error or status page: "QR code not found", "No longer available"… */
export function noticePage(status, message) {
	const { icon, heading } = NOTICES[status] ?? NOTICES[404];
	const hint =
		status === 503
			? "Try again in a minute."
			: "If you think this is a mistake, contact whoever shared this QR code.";
	return render(status, {
		title: heading,
		icon,
		body: `<h1>${heading}</h1><p>${escapeHtml(message)}</p><p class="hint">${hint}</p>`,
	});
}

/**
 * What someone sees when they open the Worker's address itself. Until the
 * Worker is connected, its owner (who lands here from Cloudflare's "Visit"
 * button) gets a one-click hand-off back to QRCartoon.
 */
export function homePage(connectUrl = null) {
	if (connectUrl) {
		return render(200, {
			title: "Connect your Worker",
			icon: "qr",
			body: `<h1>Your Worker is installed 🎉</h1>
<p>One last step: connect it to your QRCartoon account. We'll check everything for you.</p>
<p style="margin-top:24px"><a class="btn" href="${escapeHtml(connectUrl)}">Connect to QRCartoon</a></p>
<p class="hint">You'll be asked to sign in if you aren't already.</p>`,
		});
	}
	return render(200, {
		title: "QR code service",
		icon: "qr",
		body: `<h1>Private QR code service</h1>
<p>This address answers QR code scans for its owner. Scans stay here: they're never sent to QRCartoon or anyone else.</p>
<p class="hint">Scanned a code and ended up here? The code may be incomplete. Try scanning it again.</p>
<p style="margin-top:24px"><a class="btn" href="${SITE}" target="_blank" rel="noopener">Make your own QR codes</a></p>`,
	});
}

/** A text QR: the message, with a copy button. */
export function textPage(content) {
	return render(200, {
		title: "Message",
		icon: "text",
		interactive: true,
		body: `<h1>Message</h1>
<div class="box" id="text" data-value="${escapeHtml(content)}">${escapeHtml(content)}</div>
<button class="btn" type="button" data-copy="text">Copy text</button>`,
	});
}

/** A Wi-Fi QR: network name and password, ready to copy. */
export function wifiPage({ ssid, password, security, hidden }) {
	const passwordRow = password
		? `<div class="row"><div><small>Password</small><strong id="pw" data-value="${escapeHtml(password)}">••••••••</strong></div>
<div class="actions"><button class="btn ghost" type="button" data-reveal="pw" aria-pressed="false">Show</button><button class="btn ghost" type="button" data-copy="pw">Copy</button></div></div>`
		: `<div class="row"><div><small>Password</small><strong>None needed</strong></div></div>`;
	return render(200, {
		title: `Wi-Fi: ${ssid}`,
		icon: "wifi",
		interactive: true,
		body: `<h1>Join “${escapeHtml(ssid)}”</h1>
<p>${security ? `${escapeHtml(security)} secured` : "Open network"}${hidden ? ' <span class="badge">Hidden network</span>' : ""}</p>
<div class="row"><div><small>Network name</small><strong id="ssid" data-value="${escapeHtml(ssid)}">${escapeHtml(ssid)}</strong></div>
<div class="actions"><button class="btn ghost" type="button" data-copy="ssid">Copy</button></div></div>
${passwordRow}
<p class="hint">Open your phone's Wi-Fi settings, choose ${hidden ? "“Other network” and enter this name" : "this network"}, then paste the password.</p>`,
	});
}

/** A contact (vCard) or calendar event, handed to the phone as a file. */
export function filePage(kind, content) {
	const headers = { ...SECURITY_HEADERS, "Content-Security-Policy": "default-src 'none'; sandbox" };
	if (kind === "vcard") {
		return new Response(content, { headers: { ...headers, "Content-Type": "text/vcard; charset=utf-8" } });
	}
	return new Response(content, {
		headers: {
			...headers,
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": 'attachment; filename="event.ics"',
		},
	});
}

export function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" },
	});
}

export function redirect(location) {
	return new Response(null, { status: 307, headers: { ...SECURITY_HEADERS, Location: location } });
}
