"use client";

import { useState, type FormEvent } from "react";
import { safeInternalPath } from "@/lib/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Email hoặc mật khẩu không đúng.",
  email_taken: "Email này đã được đăng ký. Hãy đăng nhập thay vì tạo tài khoản mới.",
  weak_password: "Mật khẩu cần từ 8 đến 128 ký tự.",
  invalid_email: "Email không hợp lệ. Kiểm tra lại địa chỉ và thử lại.",
  rate_limited: "Bạn thử quá nhiều lần. Đợi một lúc rồi thử lại."
};
const FALLBACK_ERROR = "Không thể kết nối. Thử lại sau ít phút.";

export function AuthForm({ mode, returnTo = "" }: { mode: "login" | "signup"; returnTo?: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const signup = mode === "signup";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const res = await fetch(signup ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email") || "").trim(), password: String(form.get("password") || "") })
      });
      if (res.ok) {
        // Re-sanitize on the client: returnTo is user-controlled input.
        window.location.assign(safeInternalPath(returnTo) || "/");
        return;
      }
      const body = await res.json().catch(() => null);
      setError(ERROR_MESSAGES[body?.error] || FALLBACK_ERROR);
    } catch {
      setError(FALLBACK_ERROR);
    }
    setPending(false);
  }

  const field = "mt-2 block h-12 w-full rounded border border-white/15 bg-graphite px-4 text-body text-chalk-white placeholder:text-ash focus:border-chalk-white focus:outline-none focus-visible:ring-2 focus-visible:ring-netflix-red";

  return (
    <form onSubmit={onSubmit} className="mt-8 grid gap-5" noValidate>
      <div>
        <label htmlFor="auth-email" className="text-control font-medium text-silver">Email</label>
        <input id="auth-email" name="email" type="email" autoComplete="email" required inputMode="email" className={field} />
      </div>
      <div>
        <label htmlFor="auth-password" className="text-control font-medium text-silver">Mật khẩu</label>
        <input
          id="auth-password"
          name="password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          required
          minLength={signup ? 8 : undefined}
          maxLength={128}
          aria-describedby={signup ? "auth-password-hint" : undefined}
          className={field}
        />
        {signup ? <p id="auth-password-hint" className="mt-2 text-caption text-ash">Từ 8 đến 128 ký tự.</p> : null}
      </div>
      <p role="alert" className={error ? "rounded border border-netflix-red/60 bg-netflix-red/10 px-4 py-3 text-control text-chalk-white" : "sr-only"}>{error}</p>
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded bg-netflix-red text-body font-bold text-chalk-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chalk-white disabled:opacity-60"
      >
        {pending ? "Đang xử lý..." : signup ? "Tạo tài khoản" : "Đăng nhập"}
      </button>
    </form>
  );
}
