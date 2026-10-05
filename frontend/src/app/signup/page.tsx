import type { Metadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { hrefWithReturnTo, safeInternalPath } from "@/lib/navigation";

export const metadata: Metadata = {
  title: "Đăng ký — Blueflare",
  robots: { index: false, follow: false }
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignupPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const raw = Array.isArray(query.returnTo) ? query.returnTo[0] : query.returnTo;
  const returnTo = safeInternalPath(raw);
  const otherHref = hrefWithReturnTo("/login", returnTo);

  return (
    <div className="bf-content-width bf-page-gutter pb-16 pt-28 md:pt-36">
      <div className="mx-auto max-w-sm">
        <h1 className="text-[32px] font-black tracking-tight text-white">Đăng ký</h1>
        <p className="mt-3 text-body leading-6 text-silver">Tạo tài khoản để lưu yêu thích và xem tiếp phim đang xem dở.</p>
        <AuthForm mode="signup" returnTo={returnTo} turnstileSiteKey={process.env.TURNSTILE_SITE_KEY || ""} />
        <p className="mt-8 text-control text-silver">
          Đã có tài khoản?{" "}
          <a href={otherHref} className="font-medium text-chalk-white underline underline-offset-4 hover:text-silver">Đăng nhập</a>
        </p>
      </div>
    </div>
  );
}
