import { describe, expect, it } from "vitest";
import {
  fieldErrors,
  validateLoginInput,
  validateRegistrationInput,
} from "./validation";

describe("validateRegistrationInput", () => {
  const valid = {
    fullName: "Jane Farmer",
    email: "jane@example.com",
    password: "long-enough-pass",
    confirmPassword: "long-enough-pass",
  };

  it("accepts a complete, valid submission", () => {
    expect(validateRegistrationInput(valid)).toEqual([]);
  });

  it("requires a non-empty name within bounds", () => {
    const errors = validateRegistrationInput({ ...valid, fullName: "   " });
    expect(errors.some((error) => error.field === "fullName")).toBe(true);

    const tooLong = validateRegistrationInput({
      ...valid,
      fullName: "x".repeat(201),
    });
    expect(tooLong.some((error) => error.field === "fullName")).toBe(true);
  });

  it("rejects malformed emails", () => {
    const cases = ["", "not-an-email", "missing@tld", "two@@example.com"];
    for (const email of cases) {
      const errors = validateRegistrationInput({ ...valid, email });
      expect(errors.some((error) => error.field === "email")).toBe(true);
    }
  });

  it("enforces the password policy", () => {
    const tooShort = validateRegistrationInput({
      ...valid,
      password: "short",
      confirmPassword: "short",
    });
    expect(tooShort.some((error) => error.field === "password")).toBe(true);

    const tooLong = validateRegistrationInput({
      ...valid,
      password: "x".repeat(201),
      confirmPassword: "x".repeat(201),
    });
    expect(tooLong.some((error) => error.field === "password")).toBe(true);
  });

  it("requires the confirmation to match", () => {
    const errors = validateRegistrationInput({
      ...valid,
      confirmPassword: "different-pass",
    });
    const confirmErrors = errors.filter(
      (error) => error.field === "confirmPassword",
    );
    expect(confirmErrors).toHaveLength(1);
    expect(confirmErrors[0].message).toContain("do not match");
  });

  it("deduplicates errors per field", () => {
    const map = fieldErrors([
      { field: "email", message: "Enter a valid email address." },
      { field: "email", message: "Second message must be dropped." },
    ]);
    expect(Object.keys(map)).toEqual(["email"]);
  });
});

describe("validateLoginInput", () => {
  it("requires both fields before a request is sent", () => {
    expect(validateLoginInput({ email: "", password: "" }).length).toBe(2);
    expect(
      validateLoginInput({ email: "a@b.co", password: "secret-long-pass" }),
    ).toEqual([]);
  });
});
