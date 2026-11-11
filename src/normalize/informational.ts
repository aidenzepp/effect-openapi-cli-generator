import { Array as Arr, Effect, Order, Predicate, Schema } from "effect";
import { Informational } from "../model/entities.ts";
import { methodMembers } from "../model/path-item.ts";
import type { Resolution } from "../resolve/index.ts";
import { childPointer } from "../model/pointer.ts";
import type { Json } from "../model/pointer.ts";
import { isSpecificationExtension } from "../model/extension.ts";
import { isObject, isArray } from "../model/json-tree.ts";
import type { JsonObject } from "../model/json-tree.ts";

const reasons = {
  "CBK-01": "A callback describes a request the provider sends; a client never sends it.",
  "DOC-08": "A webhook describes a request the provider sends; a client never sends it.",
  "EXD-01": "External documentation is a link for readers; it is never fetched.",
  "EXM-01": "An example is documentation; it is never sent and never a default.",
  "EXT-01": "A specification extension is read and recorded; it never changes a request.",
  "EXT-02":
    "A reserved x-oai- or x-oas- extension is read and recorded; it never changes a request.",
  "INF-01": "Info is metadata for help and the README; it is never sent.",
  "INF-09": "Contact is metadata; it is never sent.",
  "INF-13": "License is metadata; it is never sent.",
  "LNK-01": "A link is a design-time relation between operations; it is never followed.",
  "TAG-01": "A tag is grouping metadata for help; it never changes a request.",
} as const;

type Row = keyof typeof reasons;

interface Finding {
  readonly pointer: string;
  readonly row: Row;
}

// The Objects that can hold informational elements. An informational Object (example, link,
// callback) is recorded and not walked, because its record accounts for its parts.
type Walked =
  | "encoding"
  | "externalDocs"
  | "flow"
  | "flows"
  | "header"
  | "mediaType"
  | "operation"
  | "parameter"
  | "pathItem"
  | "requestBody"
  | "response"
  | "responses"
  | "securityScheme"
  | "server"
  | "variable";

type Informative = "callback" | "example" | "link";

const informativeRow = {
  callback: "CBK-01",
  example: "EXM-01",
  link: "LNK-01",
} as const satisfies Record<Informative, Row>;

type Edge =
  | readonly ["informative", string, Informative]
  | readonly ["list" | "map" | "one", string, Walked];

interface Holds {
  readonly edges?: readonly Edge[];
  readonly rest?: Walked;
  readonly row?: Row;
}

const methodFields = Arr.sort(methodMembers("3.2"), Order.String);

const holds = {
  encoding: {
    edges: [
      ["map", "headers", "header"],
      ["map", "encoding", "encoding"],
      ["list", "prefixEncoding", "encoding"],
      ["one", "itemEncoding", "encoding"],
    ],
  },
  externalDocs: { row: "EXD-01" },
  flow: {},
  flows: { rest: "flow" },
  header: {
    edges: [
      ["informative", "examples", "example"],
      ["map", "content", "mediaType"],
    ],
  },
  mediaType: {
    edges: [
      ["informative", "examples", "example"],
      ["map", "encoding", "encoding"],
      ["list", "prefixEncoding", "encoding"],
      ["one", "itemEncoding", "encoding"],
    ],
  },
  operation: {
    edges: [
      ["one", "externalDocs", "externalDocs"],
      ["informative", "callbacks", "callback"],
      ["list", "parameters", "parameter"],
      ["one", "requestBody", "requestBody"],
      ["one", "responses", "responses"],
      ["list", "servers", "server"],
    ],
  },
  parameter: {
    edges: [
      ["informative", "examples", "example"],
      ["map", "content", "mediaType"],
    ],
  },
  pathItem: {
    edges: [
      ["list", "servers", "server"],
      ["list", "parameters", "parameter"],
      ...methodFields.map((method): Edge => ["one", method, "operation"]),
      ["map", "additionalOperations", "operation"],
    ],
  },
  requestBody: { edges: [["map", "content", "mediaType"]] },
  response: {
    edges: [
      ["map", "headers", "header"],
      ["map", "content", "mediaType"],
      ["informative", "links", "link"],
    ],
  },
  responses: { rest: "response" },
  securityScheme: { edges: [["one", "flows", "flows"]] },
  server: { edges: [["map", "variables", "variable"]] },
  variable: {},
} as const satisfies Record<Walked, Holds>;

const componentSections = {
  callbacks: "callback",
  examples: "example",
  headers: "header",
  links: "link",
  mediaTypes: "mediaType",
  parameters: "parameter",
  pathItems: "pathItem",
  requestBodies: "requestBody",
  responses: "response",
  securitySchemes: "securityScheme",
} as const satisfies Record<string, Informative | Walked>;

const reservedExtension = /^x-o(?:ai|as)-/u;

const isInformative = (kind: string): kind is Informative => kind in informativeRow;

class Walk {
  readonly found: Finding[] = [];

  add(row: Row, pointer: string): void {
    this.found.push({ pointer, row });
  }

  extensions(node: JsonObject, pointer: string): void {
    for (const key of Object.keys(node).filter(isSpecificationExtension)) {
      this.add(reservedExtension.test(key) ? "EXT-02" : "EXT-01", childPointer(pointer, key));
    }
  }

  // A map of names to elements of one informational kind: one record per entry, or one record at
  // the map when it is empty, so a declared but empty map is still accounted for.
  informativeMap(row: Row, value: Json | undefined, pointer: string): void {
    if (!isObject(value)) {
      return;
    }

    const names = Object.keys(value);
    if (names.length === 0) {
      this.add(row, pointer);
    }

    for (const name of names) {
      this.add(row, childPointer(pointer, name));
    }
  }

  follow(edge: Edge, node: JsonObject, pointer: string): void {
    const [how, name, target] = edge;
    const value = node[name];
    const site = childPointer(pointer, name);
    if (how === "informative") {
      this.informativeMap(informativeRow[target], value, site);
    } else if (how === "one") {
      this.visit(target, value, site);
    } else if (how === "list" && isArray(value)) {
      for (const [index, item] of value.entries()) {
        this.visit(target, item, childPointer(site, String(index)));
      }
    } else if (how === "map" && isObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        this.visit(target, entry, childPointer(site, key));
      }
    }
  }

  // A Reference Object's other members are ignored (REF rows), so nothing below it is read here.
  visit(kind: Walked, value: Json | undefined, pointer: string): void {
    if (!isObject(value) || Predicate.isString(value.$ref)) {
      return;
    }

    const held: Holds = holds[kind];
    if (held.row !== undefined) {
      this.add(held.row, pointer);
    }

    this.extensions(value, pointer);
    for (const edge of held.edges ?? []) {
      this.follow(edge, value, pointer);
    }

    const { rest } = held;
    for (const [key, entry] of Object.entries(value)) {
      if (rest !== undefined && !isSpecificationExtension(key)) {
        this.visit(rest, entry, childPointer(pointer, key));
      }
    }
  }

  info(value: Json | undefined): void {
    if (!isObject(value)) {
      return;
    }

    this.add("INF-01", "/info");
    this.extensions(value, "/info");
    for (const [name, row] of [
      ["contact", "INF-09"],
      ["license", "INF-13"],
    ] as const) {
      const part = value[name];
      if (isObject(part)) {
        this.add(row, childPointer("/info", name));
        this.extensions(part, childPointer("/info", name));
      }
    }
  }

  tags(value: Json | undefined): void {
    for (const [index, tag] of (isArray(value) ? value : []).entries()) {
      if (isObject(tag)) {
        const pointer = childPointer("/tags", String(index));
        this.add("TAG-01", pointer);
        this.extensions(tag, pointer);
        this.visit("externalDocs", tag.externalDocs, childPointer(pointer, "externalDocs"));
      }
    }
  }

  paths(value: Json | undefined): void {
    if (!isObject(value)) {
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (!isSpecificationExtension(key)) {
        this.visit("pathItem", item, childPointer("/paths", key));
      }
    }

    this.extensions(value, "/paths");
  }

  components(value: Json | undefined): void {
    if (!isObject(value)) {
      return;
    }

    this.extensions(value, "/components");
    for (const [section, kind] of Object.entries(componentSections)) {
      const map = value[section];
      const pointer = childPointer("/components", section);
      if (!isObject(map)) {
        continue;
      }

      if (isInformative(kind)) {
        this.informativeMap(informativeRow[kind], map, pointer);
      } else {
        for (const [name, entry] of Object.entries(map)) {
          this.visit(kind, entry, childPointer(pointer, name));
        }
      }
    }
  }
}

const findings = (root: JsonObject): readonly Finding[] => {
  const walk = new Walk();
  walk.info(root.info);
  walk.extensions(root, "");
  walk.visit("externalDocs", root.externalDocs, "/externalDocs");
  walk.tags(root.tags);
  for (const [index, server] of (isArray(root.servers) ? root.servers : []).entries()) {
    walk.visit("server", server, childPointer("/servers", String(index)));
  }

  walk.informativeMap("DOC-08", root.webhooks, "/webhooks");
  walk.paths(root.paths);
  walk.components(root.components);

  return walk.found;
};

const decode = Schema.decodeUnknownEffect(Informational);

/**
 * The elements the generator reads and counts but never sends (design 2.4, D-OQ2, D-CUS2): info,
 * contact and license; external documentation; tags; webhooks, callbacks, links and examples; and
 * specification extensions. Each is one record with its row, its use-site pointer in the entry
 * document, and a fixed reason. The walk follows the Objects that can hold them, in the fixed
 * order info, extensions, external docs, tags, servers, webhooks, paths, components, and within
 * a map in document order. An informational element is recorded and not walked further, a
 * Reference Object is recorded or skipped at its use site and never followed, and schemas are not
 * walked here (their annotations belong to the schema stage).
 */
export const collectInformational = (
  resolution: Resolution,
): Effect.Effect<readonly Informational[]> =>
  isObject(resolution.value)
    ? Effect.forEach(findings(resolution.value), (finding) =>
        decode({
          origin: { document: resolution.document, pointer: finding.pointer },
          reason: reasons[finding.row],
          row: finding.row,
        }),
      ).pipe(Effect.orDie)
    : Effect.succeed([]);
