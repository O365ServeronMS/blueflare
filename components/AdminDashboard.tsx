"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AdminUser = {
  id: string; email: string; createdAt: string; lastActive: string | null;
  sessions: number; favorites: number; history: number; isAdmin: boolean;
};
type Listing = {
  overview: { users: number; new7d: number; activeSessions: number };
  total: number; page: number; pageSize: number; items: AdminUser[];
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN") : "—");

export function AdminDashboard() {
  const [data, setData] = useState<Listing | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/me/admin/users?${params}`, { credentials: "include", cache: "no-store" });
      if (res.status === 401 || res.status === 404) { setStatus("forbidden"); return; }
      if (!res.ok) { setStatus("error"); return; }
      setData(await res.json());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [page, query]);

  useEffect(() => { load(); }, [load]);

  async function act(user: AdminUser, kind: "sessions" | "delete") {
    const text = kind === "delete"
      ? `Xoá vĩnh viễn tài khoản ${user.email} cùng yêu thích và lịch sử? Không thể hoàn tác.`
      : `Đăng xuất mọi thiết bị của ${user.email}?`;
    if (!window.confirm(text)) return;
    setBusy(user.id);
    setNotice("");
    try {
      const res = await fetch(`/api/me/admin/users/${user.id}${kind === "sessions" ? "/sessions" : ""}`, {
        method: "DELETE", credentials: "include", cache: "no-store"
      });
      setNotice(res.ok ? (kind === "delete" ? "Đã xoá tài khoản." : "Đã thu hồi phiên đăng nhập.") : "Thao tác không thành công.");
      await load();
    } catch {
      setNotice("Không thể kết nối.");
    }
    setBusy("");
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(q.trim());
  }

  if (status === "loading") return <p className="mt-8 text-body text-silver">Đang tải…</p>;
  if (status === "forbidden") return <p className="mt-8 text-body text-silver">Bạn không có quyền truy cập trang này.</p>;
  if (status === "error" || !data) return <p className="mt-8 text-body text-silver">Không tải được dữ liệu. Thử lại sau.</p>;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const btn = "h-9 rounded border border-white/15 px-3 text-control text-silver hover:bg-graphite hover:text-chalk-white disabled:opacity-40";

  return (
    <div className="mt-8 grid gap-6">
      <div className="grid grid-cols-3 gap-3">
        {[["Tài khoản", data.overview.users], ["Mới 7 ngày", data.overview.new7d], ["Phiên đang hoạt động", data.overview.activeSessions]].map(([label, value]) => (
          <div key={label} className="rounded border border-white/10 bg-graphite px-4 py-3">
            <p className="text-caption text-ash">{label}</p>
            <p className="text-[24px] font-black text-white">{value}</p>
          </div>
        ))}
      </div>

      <form onSubmit={onSearch} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} placeholder="Tìm theo email" aria-label="Tìm theo email"
          className="h-10 min-w-0 flex-1 rounded border border-white/15 bg-graphite px-3 text-body text-chalk-white placeholder:text-ash focus:border-chalk-white focus:outline-none" />
        <button type="submit" className={btn}>Tìm</button>
      </form>

      <p role="status" className={notice ? "text-control text-chalk-white" : "sr-only"}>{notice}</p>

      <div className="overflow-x-auto rounded border border-white/10">
        <table className="w-full min-w-[720px] text-left text-control">
          <thead className="bg-graphite text-caption uppercase tracking-wide text-ash">
            <tr>
              <th className="px-3 py-2">Email</th><th className="px-3 py-2">Tạo lúc</th><th className="px-3 py-2">Hoạt động gần nhất</th>
              <th className="px-3 py-2">Phiên</th><th className="px-3 py-2">Yêu thích</th><th className="px-3 py-2">Lịch sử</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.items.map((user) => (
              <tr key={user.id} className="border-t border-white/10 text-silver">
                <td className="px-3 py-2 text-chalk-white">{user.email}{user.isAdmin ? <span className="ml-2 rounded bg-netflix-red px-1.5 py-0.5 text-micro font-bold text-white">ADMIN</span> : null}</td>
                <td className="px-3 py-2">{fmt(user.createdAt)}</td>
                <td className="px-3 py-2">{fmt(user.lastActive)}</td>
                <td className="px-3 py-2">{user.sessions}</td>
                <td className="px-3 py-2">{user.favorites}</td>
                <td className="px-3 py-2">{user.history}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button type="button" disabled={busy === user.id || user.sessions === 0} onClick={() => act(user, "sessions")} className={btn}>Đăng xuất thiết bị</button>
                  {user.isAdmin ? null : (
                    <button type="button" disabled={busy === user.id} onClick={() => act(user, "delete")} className={`${btn} ml-2 hover:border-netflix-red`}>Xoá</button>
                  )}
                </td>
              </tr>
            ))}
            {data.items.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-ash">Không có tài khoản nào.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-control text-silver">
        <span>{data.total} tài khoản · trang {data.page}/{pages}</span>
        <span className="flex gap-2">
          <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Trước</button>
          <button type="button" className={btn} disabled={page >= pages} onClick={() => setPage((n) => n + 1)}>Sau</button>
        </span>
      </div>
    </div>
  );
}
