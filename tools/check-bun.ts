import { Schema } from "effect";
import process from "node:process";

const Manifest = Schema.Struct({ packageManager: Schema.optional(Schema.String) });

const path = Bun.argv[2] ?? "./package.json";

const manifest = Schema.decodeUnknownSync(Manifest)(await Bun.file(path).json());

const pinned = manifest.packageManager?.replace(/^bun@/u, "");

if (pinned !== Bun.version) {
  console.error(`Bun version mismatch: package.json pins ${pinned}, running ${Bun.version}`);
  process.exit(1);
}
