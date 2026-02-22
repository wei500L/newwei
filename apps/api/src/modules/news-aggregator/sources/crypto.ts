import { createHash } from "node:crypto"

type Algorithm = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

const algorithmMap: Record<Algorithm, string> = {
  "MD5": "md5",
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
}

export async function md5(s: string) {
  return createHash("md5").update(s).digest("hex")
}

export async function myCrypto(s: string, algorithm: Algorithm) {
  return createHash(algorithmMap[algorithm]).update(s).digest("hex")
}
