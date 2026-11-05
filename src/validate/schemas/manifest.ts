/**
 * One vendored official schema file. `sha256` covers the stored bytes (checked at load).
 * `upstreamSha256` covers the published file before `vp fmt` rewrote its JSON layout (C9);
 * the parsed JSON values are equal.
 */
export interface ManifestEntry {
  readonly file: string;
  readonly sha256: string;
  readonly upstreamSha256: string;
}

/**
 * Vendored schemas in registration order: dependencies before dependents.
 */
export const manifest: readonly ManifestEntry[] = [
  {
    file: "schema-3.0-2024-10-18.json",
    sha256: "058a2ac8e2225dc22aeb263aba7aac0f8f1c2f62bbc6f4999c0a52be9b5de50c",
    upstreamSha256: "2385f5bbb8c37878daae73baeabe7f34b2f022a4a8c049329ee61f71796f039c",
  },
  {
    file: "meta-3.1-2024-11-10.json",
    sha256: "db5afc0638b128ba64fbb7d0fb4999e92b6680a91603290c9f17ae3e7dbf9246",
    upstreamSha256: "80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd",
  },
  {
    file: "dialect-3.1-2024-11-10.json",
    sha256: "647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460",
    upstreamSha256: "647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460",
  },
  {
    file: "schema-3.1-2026-08-03.json",
    sha256: "29956016a8e4e316226660adf56b869336fc6df69abe4eafa435d4663ceb3b23",
    upstreamSha256: "59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6",
  },
  {
    file: "schema-base-3.1-2026-08-03.json",
    sha256: "ffdd07e28417bfa89de635d23a7476f7625497b8edd279f18c1424e613966d9a",
    upstreamSha256: "ffdd07e28417bfa89de635d23a7476f7625497b8edd279f18c1424e613966d9a",
  },
  {
    file: "meta-3.2-2026-02-26.json",
    sha256: "1db7a267b91691474aa03e4ec811e5c4da6869b9b1c2eae21c8056a4ff03b14a",
    upstreamSha256: "f444d02ef7d36f30293983fad8118c823a3c70a49a8e5aa6f1afe21215e35417",
  },
  {
    file: "dialect-3.2-2026-02-26.json",
    sha256: "9375b7042aa0b01848403f0a9ebf12a3425e01a9e24337ce12624f10fea73833",
    upstreamSha256: "9375b7042aa0b01848403f0a9ebf12a3425e01a9e24337ce12624f10fea73833",
  },
  {
    file: "schema-3.2-2026-08-30.json",
    sha256: "6c0d188f9d5b4e8590960df75a9a07d16ad078b2bcf776375cc0818d9702adaa",
    upstreamSha256: "ec53db6e114b768ff2d273b232bda210f51b70c5e57d57ac8daf7e8496a6e073",
  },
  {
    file: "schema-base-3.2-2026-08-30.json",
    sha256: "9df52b98a92075a917125364d23a5f70825d6c292c7aeb15c31b822e95f031e9",
    upstreamSha256: "9df52b98a92075a917125364d23a5f70825d6c292c7aeb15c31b822e95f031e9",
  },
];
