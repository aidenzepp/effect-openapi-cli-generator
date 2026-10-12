"""Rebuild or verify the pinned Resend slice without changing upstream semantics."""

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
OPERATIONS = [
    ("/domains", "get", ["domains"], "list"),
    ("/domains", "post", ["domains"], "create"),
    ("/domains/{domain_id}", "patch", ["domains"], "update"),
    ("/domains/{domain_id}", "delete", ["domains"], "delete"),
    ("/emails", "post", ["emails"], "send"),
    ("/emails/batch", "post", ["emails", "batch"], "send"),
    ("/emails/{email_id}/attachments", "get", ["emails", "attachments"], "list"),
    ("/emails/{email_id}/attachments/{attachment_id}", "get", ["emails", "attachments"], "get"),
]


def load(name):
    return json.loads((ROOT / name).read_text())


def component_key(ref):
    """Resolve a local component pointer, retaining its complete owning component."""
    if not ref.startswith("#/components/"):
        raise ValueError(f"Unsupported upstream reference; review without rewriting: {ref}")
    parts = [part.replace("~1", "/").replace("~0", "~") for part in unquote(ref[2:]).split("/")]
    if len(parts) < 3:
        raise ValueError(f"Incomplete component pointer: {ref}")
    value = upstream
    for part in parts:
        value = value[int(part)] if isinstance(value, list) else value[part]
    return parts[1], parts[2]


def dependencies(value):
    """Find references and named security requirements across all component kinds."""
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$ref":
                found.add(component_key(child))
            elif key == "security" and isinstance(child, list):
                for requirement in child:
                    found.update(("securitySchemes", name) for name in requirement)
            found.update(dependencies(child))
    elif isinstance(value, list):
        for child in value:
            found.update(dependencies(child))
    return found


def build_slice():
    result = {key: value for key, value in upstream.items() if key not in {"paths", "components", "tags", "webhooks"}}
    result["paths"] = {}
    tags = set()
    for path, method, _, _ in OPERATIONS:
        item = upstream["paths"][path]
        if path not in result["paths"]:
            result["paths"][path] = {key: value for key, value in item.items() if key not in METHODS}
        result["paths"][path][method] = item[method]
        tags.update(item[method].get("tags", []))
    if "tags" in upstream:
        result["tags"] = [tag for tag in upstream["tags"] if tag["name"] in tags]
    needed = dependencies(result)
    visited = set()
    while needed - visited:
        key = sorted(needed - visited)[0]
        visited.add(key)
        kind, name = key
        needed.update(dependencies(upstream["components"][kind][name]))
    result["components"] = {
        kind: {name: value for name, value in entries.items() if (kind, name) in visited}
        for kind, entries in upstream["components"].items()
        if any(component_kind == kind for component_kind, _ in visited)
    }
    return result


def build_overlay():
    return {
        "overlay": "1.0.0",
        "info": {"title": "Resend reference CLI naming", "version": "1.0.0"},
        "actions": [
            {
                "target": f'$["paths"][{json.dumps(path)}][{json.dumps(method)}]',
                "update": {"x-fern-sdk-group-name": group, "x-fern-sdk-method-name": action},
            }
            for path, method, group, action in OPERATIONS
        ],
    }


def verify(document, overlay):
    expected = {(path, method) for path, method, _, _ in OPERATIONS}
    actual = {(path, method) for path, item in document["paths"].items() for method in item if method in METHODS}
    assert actual == expected and len(actual) == 8
    for path, method in expected:
        assert document["paths"][path][method] == upstream["paths"][path][method]
    available = {(kind, name) for kind, entries in document["components"].items() for name in entries}
    assert dependencies(document) <= available, "Unresolved component or security reference"
    for kind, name in available:
        assert document["components"][kind][name] == upstream["components"][kind][name]
    assert document["security"] == upstream["security"]
    assert overlay == build_overlay()
    assert len({action["target"] for action in overlay["actions"]}) == 8
    # Each concrete target addresses exactly one selected path/method object.
    for path, method, _, _ in OPERATIONS:
        assert isinstance(document["paths"][path][method], dict)
    print(f"Verified {len(actual)} unchanged operations; " + ", ".join(f"{len(entries)} {kind}" for kind, entries in document["components"].items()) + "; 8 unique overlay targets.")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Verify checked-in artifacts without writing")
args = parser.parse_args()
provenance = load("provenance.json")
for artifact in provenance["files"]:
    digest = hashlib.sha256((ROOT / artifact["path"]).read_bytes()).hexdigest()
    assert digest == artifact["sha256"], f"Pinned artifact checksum changed: {artifact['path']}"
upstream = load("upstream/resend.json.snapshot")
sliced = build_slice()
overlay = build_overlay()
for name, value in [("openapi.json", sliced), ("naming.overlay.json", overlay)]:
    if args.check:
        assert load(name) == value, f"{name} differs from reproducible extraction"
    else:
        (ROOT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
verify(sliced, overlay)
