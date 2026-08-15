export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Đang tải Blueflare" className="min-h-screen bg-deep-space pt-20">
      <div className="h-[54vh] min-h-[420px] animate-pulse bg-graphite" />
      <div className="bf-page-gutter mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 12 }, (_, index) => <div key={index} className="aspect-[2/3] animate-pulse rounded bg-graphite" />)}
      </div>
    </div>
  );
}
