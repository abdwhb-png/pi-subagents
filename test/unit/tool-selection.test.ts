import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    registerSubagentToolSelectionTransformer,
    resolveSubagentToolSelection,
} from "../../src/api/tool-selection.ts";

describe("public child tool-selection contract", () => {
    it("rejects invalid transformer results rather than falling back to the original selectors", () => {
        const dispose = registerSubagentToolSelectionTransformer({
            name: "invalid-fixture",
            resolve: (() => undefined) as () => readonly string[],
        });
        try {
            assert.throws(() => resolveSubagentToolSelection({ tools: ["fixture:inspect"] }), /invalid tool selectors/u);
        } finally {
            dispose();
        }
    });

    it("restores the parent registration when a nested session shuts down", () => {
        const parent = registerSubagentToolSelectionTransformer({ name: "fixture", resolve: () => ["read"] });
        const child = registerSubagentToolSelectionTransformer({ name: "fixture", resolve: () => ["grep"] });
        try {
            assert.deepEqual(resolveSubagentToolSelection({ tools: ["fixture:inspect"] }), ["grep"]);
            child();
            assert.deepEqual(resolveSubagentToolSelection({ tools: ["fixture:inspect"] }), ["read"]);
        } finally {
            child();
            parent();
        }
    });

    it("does not let an older reload disposer remove its replacement", () => {
        const first = registerSubagentToolSelectionTransformer({ name: "fixture", resolve: () => ["read"] });
        const second = registerSubagentToolSelectionTransformer({ name: "fixture", resolve: () => ["grep"] });
        try {
            first();
            assert.deepEqual(resolveSubagentToolSelection({ tools: ["fixture:inspect"] }), ["grep"]);
        } finally {
            second();
        }
        assert.deepEqual(resolveSubagentToolSelection({ tools: ["fixture:inspect"] }), ["fixture:inspect"]);
    });
});
