import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgv, boolFlag, requireStringFlag } from "../scripts/lib/argv.mjs";

describe("argv.parseArgv", () => {
  it("parses bare --flag as true", () => {
    const { flags, positionals } = parseArgv(["--dry-run"], {
      booleans: new Set(["dry-run"]),
    });
    assert.equal(flags["dry-run"], true);
    assert.deepEqual(positionals, []);
  });

  it("parses --flag=value form", () => {
    const { flags } = parseArgv(["--target=./somewhere"]);
    assert.equal(flags.target, "./somewhere");
  });

  it("parses --flag value form when next token is not a flag", () => {
    const { flags } = parseArgv(["--target", "/tmp/x"]);
    assert.equal(flags.target, "/tmp/x");
  });

  it("does not consume the next flag as a value for booleans", () => {
    const { flags } = parseArgv(["--dry-run", "--apply"], {
      booleans: new Set(["dry-run", "apply"]),
    });
    assert.equal(flags["dry-run"], true);
    assert.equal(flags.apply, true);
  });

  it("collects positional arguments", () => {
    const { positionals } = parseArgv(["a.txt", "b.txt"]);
    assert.deepEqual(positionals, ["a.txt", "b.txt"]);
  });

  it("throws on empty --flag= value", () => {
    assert.throws(() => parseArgv(["--foo="]), /empty value/);
  });
});

describe("argv.boolFlag", () => {
  it("returns default when flag is absent", () => {
    assert.equal(boolFlag({}, "missing", false), false);
    assert.equal(boolFlag({}, "missing", true), true);
  });

  it("treats explicit true as true", () => {
    assert.equal(boolFlag({ x: true }, "x"), true);
  });

  it("coerces yes / 1 / true strings to true", () => {
    for (const v of ["yes", "1", "true", "YES"]) {
      assert.equal(boolFlag({ x: v }, "x"), true, `string "${v}"`);
    }
  });

  it("coerces no / 0 / false strings to false", () => {
    for (const v of ["no", "0", "false", "NO"]) {
      assert.equal(boolFlag({ x: v }, "x"), false, `string "${v}"`);
    }
  });
});

describe("argv.requireStringFlag", () => {
  it("returns the value when present", () => {
    assert.equal(requireStringFlag({ target: "/x" }, "target"), "/x");
  });

  it("throws when missing", () => {
    assert.throws(() => requireStringFlag({}, "target"), /Missing/);
  });

  it("throws when value is true (boolean flag used where string expected)", () => {
    assert.throws(() => requireStringFlag({ target: true }, "target"), /Missing/);
  });
});
