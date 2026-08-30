import "@testing-library/jest-dom/vitest";
// vitest runs with globals: false, so RTL's auto-cleanup never registers —
// without this, rendered DOM leaks between tests in the same file.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
