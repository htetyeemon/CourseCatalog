function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

export function makeRequestId(): string {
  return makeId("req");
}
