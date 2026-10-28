// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage";
import { ResetPasswordPage } from "../pages/ResetPasswordPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = "#/"; });

describe("password recovery", () => {
  it("sends the email and shows a generic confirmation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ message: "If an account exists for that email address, reset instructions may be sent." }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "USER@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect((await screen.findByRole("status")).textContent).toContain("If an account exists");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ email: "user@example.com" });
  });

  it("strips the token from the URL, submits it once, and reports success", async () => {
    window.location.hash = "#/reset-password?token=secret-token-value-123456";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ message: "Password updated." }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResetPasswordPage />);
    expect(window.location.hash).toBe("#/reset-password");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "my-very-long-new-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "my-very-long-new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect((await screen.findByRole("status")).textContent).toContain("password was updated");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ token: "secret-token-value-123456", password: "my-very-long-new-password" });
  });

  it("rejects mismatched passwords without making a request", () => {
    window.location.hash = "#/reset-password?token=secret-token-value-123456";
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "my-very-long-new-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password-long" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert").textContent).toContain("Passwords do not match");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
