import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(root, "openapi.yaml"), "utf8");
const document = YAML.parse(source);

await writeFile(
  resolve(root, "src/openapi.json"),
  `${JSON.stringify(document, null, 2)}\n`,
  "utf8",
);
