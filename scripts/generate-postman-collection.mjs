import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import YAML from "yaml";

const spec = YAML.parse(readFileSync("openapi.yaml", "utf8"));

const paths = spec.paths || {};
const servers = spec.servers || [];
const baseUrl =
  servers.find((s) => s.description === "Production")?.url ||
  "https://api.course-catalog.dev";

const httpMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

function buildRequestItem(path, method, operation) {
  const summary = operation.summary || `${method.toUpperCase()} ${path}`;
  const description = operation.description || "";

  let urlPath = path.replace(/\{([^}]+)\}/g, (_, paramName) => `:${paramName}`);

  const request = {
    method: method.toUpperCase(),
    header: [
      { key: "Content-Type", value: "application/json" },
      { key: "Authorization", value: "Bearer {{catalog_token}}" },
    ],
    url: {
      raw: baseUrl + urlPath,
      host: [baseUrl.replace(/^https?:\/\//, "")],
      path: urlPath.split("/").filter(Boolean),
      protocol: baseUrl.startsWith("https://") ? "https" : "http",
    },
  };

  const params = operation.parameters || [];
  const queryParams = params.filter((p) => p.in === "query");
  if (queryParams.length > 0) {
    request.url.query = queryParams.map((p) => ({
      key: p.name,
      value: "",
      description: p.description || "",
    }));
  }

  const pathParams = params.filter((p) => p.in === "path");
  if (pathParams.length > 0) {
    request.url.variable = pathParams.map((p) => ({
      key: p.name,
      value: "",
      description: p.description || "",
    }));
  }

  const requestBody = operation.requestBody;
  if (requestBody) {
    const content = requestBody.content || {};
    const jsonContent = content["application/json"];
    if (jsonContent) {
      const example = jsonContent.examples?.default;
      const bodyValue = example?.value ?? jsonContent.schema ?? {};
      request.body = {
        mode: "raw",
        raw: JSON.stringify(bodyValue, null, 2),
        options: { raw: { language: "json" } },
      };
    }
  }

  return {
    name: summary,
    request,
    description,
  };
}

const collection = {
  info: {
    name: "Course Catalog API",
    description:
      "Postman/Bruno collection for the Course Catalog API. Generated from openapi.yaml.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "base_url", value: baseUrl },
    { key: "catalog_token", value: "" },
    { key: "course_id", value: "" },
    { key: "instructor_id", value: "" },
    { key: "subscription_id", value: "" },
    { key: "event_id", value: "" },
  ],
  item: [],
};

const folderByTag = {};

for (const [path, pathItem] of Object.entries(paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!httpMethods.has(method)) continue;

    const op = operation;
    const tags = op.tags || ["General"];
    const tag = tags[0] || "General";

    if (!folderByTag[tag]) {
      folderByTag[tag] = { name: tag, item: [] };
    }

    folderByTag[tag].item.push(buildRequestItem(path, method, op));
  }
}

collection.item = Object.values(folderByTag);

writeFileSync("postman_collection.json", JSON.stringify(collection, null, 2));

console.log("Generated postman_collection.json");
console.log("  Tags: " + Object.keys(folderByTag).join(", "));
console.log(
  "  Total requests: " +
    Object.values(folderByTag).reduce(
      (sum, f) => sum + f.item.length,
      0,
    ),
);
