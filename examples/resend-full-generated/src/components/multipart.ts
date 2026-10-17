import { Flag } from "effect/cli";

export const CreateContactImportOptions = {
  column_map: Flag.String("column-map").pipe(
    Flag.withDescription(
      "JSON-encoded object mapping contact fields and custom property keys to CSV column names. Supports `email`, `first_name`, `last_name`, `unsubscribed`, and `properties`. Custom property mappings can include `type` as `string`, `number`, or `boolean`; defaults to `string`.",
    ),
    Flag.optional,
  ),
  file: Flag.File("file", { mustExist: true }).pipe(
    Flag.withDescription("CSV file to import. Maximum size is 50MB."),
  ),
  on_conflict: Flag.Literals("on-conflict", ["upsert", "skip"]).pipe(
    Flag.withDescription(
      'Strategy to use when an imported contact already exists. Server default when omitted: "skip".',
    ),
    Flag.optional,
  ),
  segments: Flag.String("segments").pipe(
    Flag.withDescription("JSON-encoded array of segments to add imported contacts to."),
    Flag.optional,
  ),
  topics: Flag.String("topics").pipe(
    Flag.withDescription(
      "JSON-encoded array of topic subscriptions to apply to imported contacts. Each `subscription` must be `opt_in` or `opt_out`.",
    ),
    Flag.optional,
  ),
};
