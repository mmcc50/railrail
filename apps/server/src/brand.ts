export const SIDERAIL_AUTHOR = "icubaby";
export const SIDERAIL_REPO = "https://github.com/icubaby/SideRail";
export const SIDERAIL_LICENSE = "SideRail Proprietary License";

export const SIDERAIL_SIGNATURE = Buffer.from(
  "U2lkZVJhaWwgwqkgMjAyNSBpY3ViYWJ5IOKAlCBodHRwczovL2dpdGh1Yi5jb20vaWN1YmFieS9TaWRlUmFpbCDigJQgQWxsIHJpZ2h0cyByZXNlcnZlZC4gRG8gbm90IHJlbW92ZSB0aGlzIHNpZ25hdHVyZS4=",
  "base64",
).toString("utf8");

export const SIDERAIL_FINGERPRINT = "sr-icubaby-2025-9f4c1a7e";

/**
 * Mathematical Sans-Serif Bold code points used for generated config names.
 * Verified against the panel's required style: SideRail -> 𝗦𝗶𝗱𝗲𝗥𝗮𝗶𝗹
 */
const BOLD_SANS_UPPER = 0x1d5d4; // MATHEMATICAL SANS-SERIF BOLD CAPITAL A
const BOLD_SANS_LOWER = 0x1d5ee; // MATHEMATICAL SANS-SERIF BOLD SMALL A
const BOLD_SANS_DIGIT = 0x1d7ec; // MATHEMATICAL SANS-SERIF BOLD DIGIT ZERO

/** Renders ASCII letters/digits in the bold sans config font; other chars pass through. */
export function boldSans(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x41 && cp <= 0x5a) out += String.fromCodePoint(BOLD_SANS_UPPER + cp - 0x41);
    else if (cp >= 0x61 && cp <= 0x7a) out += String.fromCodePoint(BOLD_SANS_LOWER + cp - 0x61);
    else if (cp >= 0x30 && cp <= 0x39) out += String.fromCodePoint(BOLD_SANS_DIGIT + cp - 0x30);
    else out += ch;
  }
  return out;
}

export const SIDERAIL_CONFIG_PREFIX = `${boldSans("SideRail")} - `;

/** Name written into generated configs: 𝗦𝗶𝗱𝗲𝗥𝗮𝗶𝗹 - <client name> */
export function configName(clientName: string): string {
  return `${SIDERAIL_CONFIG_PREFIX}${boldSans(clientName)}`;
}

export function watermark(): Record<string, string> {
  return {
    author: SIDERAIL_AUTHOR,
    repo: SIDERAIL_REPO,
    fingerprint: SIDERAIL_FINGERPRINT,
  };
}
