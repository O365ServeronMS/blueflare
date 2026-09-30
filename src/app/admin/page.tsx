import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = {
  title: "Admin — Blueflare",
  robots: { index: false, follow: false }
};

export default function AdminPage() {
  return (
    <div className="bf-content-width bf-page-gutter pb-16 pt-28 md:pt-36">
      <h1 className="text-[32px] font-black tracking-tight text-white">Admin Dashboard</h1>
      <AdminDashboard />
    </div>
  );
}
