# QRCartoon self-hosted redirects

Serve your QRCartoon dynamic QR codes from **your own Cloudflare account**.

- **Scans never reach QRCartoon.** Phones talk only to this Worker, so QRCartoon never sees who scans, when or where.
- **Keeps working if QRCartoon is down.** Your redirect list is stored in your own KV store.
- **You stay in control.** Destinations are only ever sent to domains you list in `ALLOWED_HOSTS`, even if QRCartoon itself asked for something else.

You keep editing your QR codes in the QRCartoon dashboard as usual. Changes reach this Worker within a few seconds of saving. If something ever looks out of date, press **Sync Worker** in the QRCartoon dashboard.

## Setup

1. In QRCartoon, open **Settings → Self-hosted redirects** and click **Set up**. Copy the **setup key**.
2. Click **Deploy to Cloudflare** there. Cloudflare copies this code into your account and creates the KV store. When it asks:
   - `SETUP_KEY`: paste the setup key.
   - `ALLOWED_HOSTS`: the websites your QR codes open, for example `brand.com, instagram.com` (add `google.com` for location codes).
3. When the deploy finishes, click **Visit** to open your Worker, then **Connect to QRCartoon**. QRCartoon checks everything and reads your allowed websites from the Worker, so you never type them twice.

   (You can also paste the Worker's address into QRCartoon and click **Connect**.)

If the deploy screen doesn't ask for them, set them afterwards in Cloudflare: **Workers → qrcartoon-redirects → Settings → Variables and Secrets**. Add `SETUP_KEY` as a **Secret**, and `ALLOWED_HOSTS` as plain text.

**Optional: your own domain.** In Cloudflare go to **Workers → qrcartoon-redirects → Settings → Domains & Routes** and add one, e.g. `qr.brand.com`. Your domain must use Cloudflare DNS. Then connect that address in QRCartoon (**Move to a different address**) *before* creating QR codes, because the address is printed into each QR.

<!-- Updates through GitHub are switched off for now.

## Updating

When a new version is out, QRCartoon shows **Update available** in Settings. To update:

1. Open your copy of this repository on GitHub (the one Cloudflare created when you deployed).
2. Go to **Actions → Update Worker → Run workflow**.
3. Cloudflare redeploys automatically, usually within a minute or two.

The action replaces only the `src/` folder with the latest code from this repository. Your `wrangler.jsonc`, secrets and KV store are never touched.

**First time only: add the update button.** Cloudflare's deploy copies everything except the `.github/` folder, so your repository starts without the **Update Worker** action. In QRCartoon, enter your repository under **Settings → Self-hosted redirects → Turn on one-click updates** and click **Add the update button on GitHub**: GitHub opens with the file filled in, and you click **Commit changes**. (Or copy [`.github/workflows/update.yml`](.github/workflows/update.yml) into your repository at the same path yourself.)
-->

## How it stays safe

| Protection | What it stops |
|---|---|
| Every redirect list is **signed by QRCartoon** (Ed25519). The public keys are in [`src/config.js`](src/config.js) and can't be changed from settings. | Someone who gets into your KV store, or intercepts traffic, can't add or change redirects. |
| A list only works on the Worker it was made for. | Another account's list can't be replayed on your Worker. |
| An older list is never accepted over a newer one. | Rolling back to an old destination. |
| **`ALLOWED_HOSTS`** is checked on every scan. | Even a compromised QRCartoon can't send your visitors to a domain you didn't approve. |
| Only `https:`, `http:`, `mailto:`, `tel:`, `sms:` and crypto wallet (`bitcoin:`, `ethereum:`, `litecoin:`, `bitcoincash:`) destinations are allowed. | `javascript:`, `data:` and other dangerous links. |
| Text and Wi-Fi pages show content as plain text, and only the page's own script can run. Pages load nothing from anywhere else. | A list can't inject code into your pages, and opening a page tells nobody but your Worker. |
| `SETUP_KEY` is stored as a Cloudflare **secret**. QRCartoon keeps only a hash of it. | A leaked key only lets someone *read* your redirect list, never change it. Rotate it in QRCartoon if it leaks. |
| Your copy of the code only changes when **you** change it. | Nobody, including QRCartoon, can change what runs on your account. |

## Endpoints

| Path | Purpose |
|---|---|
| `/<code>` | Scan: redirect (307) to the destination |
| `/__qrc/status` | Used by "Check connection": Worker version, target id, allowed hosts, last update time |
| `/__qrc/refresh` (POST) | "Fetch the latest list now". Carries no data, and anything fetched is still signature-checked |

## Limits

- Supported QR types: URL, YouTube, email, phone, SMS, location and crypto (redirects); text and Wi-Fi (shown on this Worker's own page); contact (vCard) and event (handed to the phone as a file). Menus, coupons, files and other rich pages, and password-protected QR codes, need QRCartoon's own pages.
- There are no scan analytics, by design.
- Cloudflare free plan: 100,000 scans per day.
