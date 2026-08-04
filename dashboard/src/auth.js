import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function constantEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAdminPassword(candidate, expected) {
  return constantEqual(digest(candidate || ""), digest(expected));
}

export function hmacHex(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createSessionCookie(secret, hours) {
  const payload = encode({
    sub: "admin",
    exp: Date.now() + hours * 60 * 60 * 1000,
    nonce: randomBytes(12).toString("base64url"),
  });
  const signature = hmacHex(secret, payload);
  return `${payload}.${signature}`;
}

export function verifySessionCookie(secret, token) {
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".", 2);
  const expected = hmacHex(secret, payload);
  if (!constantEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.sub === "admin" && Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return index < 0
          ? [item, ""]
          : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

export function issueApiKey() {
  const value = `sk-mlx-${randomBytes(32).toString("base64url")}`;
  return {
    id: randomUUID(),
    value,
    prefix: `${value.slice(0, 15)}…`,
  };
}

export function bearerToken(header = "") {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || "";
}
