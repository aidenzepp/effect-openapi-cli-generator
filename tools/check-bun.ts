const path = Bun.argv[2] ?? "./package.json";
const manifest: { packageManager?: string } = await Bun.file(path).json();
const pinned = manifest.packageManager?.replace(/^bun@/, "");

if (pinned !== Bun.version) {
  console.error(`Bun version mismatch: package.json pins ${pinned}, running ${Bun.version}`);
  process.exit(1);
}
