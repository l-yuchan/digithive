import { describe, expect, test } from "bun:test";
import { APP_VERSION, appVersion, buildVersion } from "../web/src/version";

describe("visible build version", () => {
  test("joins the app version and the short commit", () => {
    expect(buildVersion("0.0.1", "9c009f6")).toBe("0.0.1-9c009f6");
  });

  test("trims the inputs and names an unknown commit", () => {
    expect(buildVersion(" 0.0.1 ", " 9c009f6 ")).toBe("0.0.1-9c009f6");
    expect(buildVersion("0.0.1", "")).toBe("0.0.1-unknown");
    expect(buildVersion("0.0.1", "  ")).toBe("0.0.1-unknown");
    expect(buildVersion("", "9c009f6")).toBe("0.0.0-9c009f6");
  });

  test("reads the value injected by the build", () => {
    expect(appVersion("0.0.1-9c009f6")).toBe("0.0.1-9c009f6");
    expect(appVersion(" 0.0.1-9c009f6 ")).toBe("0.0.1-9c009f6");
  });

  test("outside a bundle reports the base version without inventing a commit", () => {
    expect(appVersion(undefined)).toBe(buildVersion(APP_VERSION, ""));
    expect(appVersion("")).toBe(buildVersion(APP_VERSION, ""));
    expect(appVersion("   ")).toBe(buildVersion(APP_VERSION, ""));
  });
});
