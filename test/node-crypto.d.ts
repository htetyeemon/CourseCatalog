declare module "node:crypto" {
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "base64url"): string;
  }

  export function createHmac(algorithm: string, key: string): Hmac;
}
