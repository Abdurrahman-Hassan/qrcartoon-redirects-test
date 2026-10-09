export const BUNDLE_VERSION: 1;
export const SLUG_PATTERN: RegExp;
export const MAX_BUNDLE_BYTES: number;
export const MAX_ALLOWED_HOSTS: number;
export const MAX_CONTENT_CHARS: number;
export const CONTENT_KINDS: ContentKind[];

export type ContentKind = "text" | "wifi" | "vcard" | "event";

export interface WifiDetails {
	ssid: string;
	password: string;
	/** "WPA", "WEP"…, or "" for an open network */
	security: string;
	hidden: boolean;
}

export interface BundleEntry {
	/** Destination (redirect entries) */
	u?: string;
	/** Content kind (content entries) */
	k?: ContentKind;
	/** Content: text, a WIFI: string, a vCard or a full calendar file */
	c?: string;
	/** Turned off by the owner */
	off?: 1;
	/** Expiry cutoff, ms since epoch */
	exp?: number;
}

export interface Bundle {
	v: 1;
	target: string;
	issuedAt: number;
	entries: Record<string, BundleEntry>;
}

export const CHALLENGE_PATTERN: RegExp;
export function secretFingerprint(secret: string): Promise<string>;
export function connectProof(fingerprintHex: string, challenge: string, origin: string): Promise<string>;
export function parseSetupKey(key: unknown): { targetId: string; secret: string } | null;
export function parseHosts(input: unknown): string[] | null;
export function isAllowedDestination(url: string, allowedHosts: string[]): boolean;
export function parseWifi(content: unknown): WifiDetails | null;
export function isValidContent(kind: unknown, content: unknown): boolean;
export function verifyBundle(
	signed: unknown,
	options: { publicKeys: string[]; targetId: string; minIssuedAt?: number; now?: number },
): Promise<{ ok: true; bundle: Bundle } | { ok: false; reason: string }>;
export function resolveScan(
	bundle: Bundle,
	slug: string,
	allowedHosts: string[],
	now?: number,
):
	| { status: 307; location: string }
	| { status: 200; kind: "text" | "vcard" | "event"; content: string }
	| { status: 200; kind: "wifi"; wifi: WifiDetails }
	| { status: number; message: string };
