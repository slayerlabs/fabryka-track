import json
from pathlib import Path

schema = json.loads(Path("frontend/src/pipeline/contracts/upload-v1.schema.json").read_text(encoding="utf-8"))


def ts(node: dict) -> str:
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[1]
    if "anyOf" in node:
        return " | ".join("(" + ts(item) + ")" for item in node["anyOf"])
    if "const" in node:
        return json.dumps(node["const"])
    if "enum" in node:
        return " | ".join(json.dumps(item) for item in node["enum"])
    kind = node.get("type")
    if kind in ("string", "boolean", "null"):
        return kind
    if kind in ("integer", "number"):
        return "number"
    if kind == "array":
        if "prefixItems" in node:
            return "[" + ", ".join(ts(item) for item in node["prefixItems"]) + "]"
        return "Array<" + ts(node["items"]) + ">"
    if kind == "object":
        required = set(node.get("required", []))
        return (
            "{ "
            + " ".join(
                json.dumps(key) + ("" if key in required else "?") + ": " + ts(value) + ";"
                for key, value in node["properties"].items()
            )
            + " }"
        )
    raise ValueError("unsupported_schema_type")


output = "\n".join("export type " + name + " = " + ts(body) + ";" for name, body in schema["$defs"].items())
Path("frontend/src/pipeline/types.ts").write_text(output + "\nexport type ErrorBody = Error;\n", encoding="utf-8")
