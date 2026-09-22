import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCompatibilityManifest,
  buildOpenApiDocument,
  ERROR_CODES,
  TEAM_OPERATION_TYPES,
  TEAM_ROUTES,
} from "../src/index.js";
import { fixtures } from "../src/testing/fixtures.js";

const openapiPath = new URL("../openapi.json", import.meta.url);
const manifestPath = new URL("../compatibility.json", import.meta.url);

describe("generated documents", () => {
  it("openapi.json is up to date with the schema-derived document", () => {
    const committed = JSON.parse(fs.readFileSync(openapiPath, "utf8"));
    expect(committed).toEqual(buildOpenApiDocument());
  });

  it("compatibility.json is up to date with the derived manifest", () => {
    const committed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(committed).toEqual(buildCompatibilityManifest());
  });

  it("is an OpenAPI 3.1 document covering every C4 route", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    for (const route of TEAM_ROUTES) {
      const entry = paths[route.path];
      expect(entry, `${route.method} ${route.path}`).toBeDefined();
      expect(
        entry?.[route.method.toLowerCase()],
        `${route.method} ${route.path}`,
      ).toBeDefined();
    }
    expect(Object.keys(paths).length).toBe(new Set(TEAM_ROUTES.map((r) => r.path)).size);
  });

  it("represents every TeamOperation literal and every error code", () => {
    const serialized = JSON.stringify(buildOpenApiDocument());
    for (const type of TEAM_OPERATION_TYPES) {
      expect(serialized, type).toContain(`"${type}"`);
    }
    for (const code of ERROR_CODES) {
      expect(serialized, code).toContain(`"${code}"`);
    }
  });

  it("the manifest pins protocol, features, operations, error codes, routes and limits", () => {
    const manifest = buildCompatibilityManifest();
    expect(manifest.protocol).toBe(1);
    expect(manifest.contractVersion).toBe("1.0.0");
    expect(manifest.features).toEqual([
      "catalog-v1",
      "review-v1",
      "changes-v1",
      "agent-token-v1",
    ]);
    expect(manifest.operations).toEqual([...TEAM_OPERATION_TYPES].sort());
    expect(manifest.errorCodes).toEqual([...ERROR_CODES].sort());
    expect(manifest.routes.length).toBe(TEAM_ROUTES.length);
    expect(manifest.limits.maxContentBytes).toBe(65536);
  });
});

describe("fixture coverage", () => {
  it("covers every error code with a canonical example", () => {
    const covered = new Set(fixtures.errors.errors.map((entry) => entry.code));
    for (const code of ERROR_CODES) expect(covered.has(code), code).toBe(true);
    for (const entry of fixtures.errors.errors) {
      expect(entry.body.error.code, entry.code).toBe(entry.code);
      expect(entry.body.error.retryable, entry.code).toBe(entry.retryable);
    }
  });

  it("reproduces the C10 normative example verbatim", () => {
    expect(fixtures.proposalLifecycle.normativeEnvelope).toEqual({
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      membershipGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      operation: {
        type: "proposal.submit",
        promptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        baseRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        content: "Summarize the issue, evidence, and next action.",
        rationale: "Make the expected response structure explicit.",
        supersedesProposalId: null,
      },
    });
  });

  it("uses the required feature set and stable server identity in the seed", () => {
    expect(fixtures.catalogSeed.server.features).toEqual([
      "catalog-v1",
      "review-v1",
      "changes-v1",
      "agent-token-v1",
    ]);
    expect(fixtures.catalogSeed.server.contractVersion).toBe("1.0.0");
  });
});
