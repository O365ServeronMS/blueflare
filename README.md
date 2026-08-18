# 🎬 FilmBluesia

Vietnamese movie streaming, done fast 🚀 — browse, search, and watch at [phim.bluesia.net](https://phim.bluesia.net).

## ✨ What it does

- 🔍 Browse & search a canonical VN catalog merged by the Blueflare backend
- 📱 Stream via device-aware embeds or native HLS — mobile-first, always
- ⭐ Remember favorites & watch history right in `localStorage`
- ⚡ Server-rendered on our own VPS, Cloudflare just does TLS/CDN duty

## 🏗️ Architecture

Next.js 16 App Router, self-hosted — no Astro, no Workers, no edge magic. Runs in the `frontend` Docker service on `127.0.0.1:3100`, Caddy proxies it to the world.

Same repo, same house: `backend/` owns provider sync, PostgreSQL, Valkey caching, and signed images at `img.bluesia.net`. Server Components talk to the API over the Docker network; browsers own playback + local state.

## 🧰 Stack

| What | How |
|---|---|
| 🖥️ Pages | Next.js 16 App Router + React Server Components |
| ⚛️ Interactivity | React 19, client components only where needed |
| 🎨 Styling | Tailwind CSS 4 |
| 🐳 Runtime | Node 24 standalone container |
| 🌐 Edge | Caddy + Cloudflare (plain proxy/CDN, no Worker) |
| 🎞️ Catalog/images | Blueflare API + `img.bluesia.net` |
| 📡 Providers | NguonC primary, KKPhim fills the gaps |
| 🗄️ Data/cache | PostgreSQL + Valkey + Next render cache |
| 🖼️ Images | Pre-signed `m`/`d` variants only |
| ▶️ Video | hls.js light (lazy) + provider embeds |

## 🏃 Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run build      # production build
npm run start      # serve the standalone build
```

Want the full stack? 🐳

```bash
cp backend/.env.example /opt/docker/stacks/blueflare/.env   # rồi điền secret
cd /opt/docker/stacks/blueflare && docker compose up -d --build
```

## 🚢 Deploy on the VPS

Codebase và runtime nằm ở hai chỗ (xem [ADR-001](docs/adr/ADR-001-tach-stack-runtime-khoi-codebase.md)):

| | Đường dẫn | Nội dung |
|---|---|---|
| Codebase | `/home/ubuntu/blueflare` | repo này — nguồn duy nhất của mọi thứ trong git |
| Runtime | `/opt/docker/stacks/blueflare` | `compose.yml`, `.env`, `deploy/`, `data/images/` |

Compose build thẳng từ codebase qua `BLUEFLARE_SRC` (mặc định `/home/ubuntu/blueflare`),
nên deploy code mới là hai bước:

```bash
git pull
cd /opt/docker/stacks/blueflare && docker compose up -d --build frontend
curl -fsS http://127.0.0.1:3100/healthz
```

Nếu sửa `compose.yml` hay script trong `deploy/`, bản chuẩn nằm trong repo — đồng bộ sang
stack rồi mới áp dụng:

```bash
/home/ubuntu/blueflare/deploy/sync-stack.sh --dry-run   # xem trước
/home/ubuntu/blueflare/deploy/sync-stack.sh
```

Đổi cấu hình mà không rebuild: `cd /opt/docker/stacks/blueflare && ./deploy/apply-env.sh`
(script validate `.env` theo `.env.example` rồi tạo lại container từ image sẵn có).

⚠️ Đừng bao giờ chạy `docker compose down -v` — cờ `-v` xóa named volume, tức là mất
toàn bộ Postgres. Backup: `./deploy/backup-postgres.sh`.

Then reload Caddy per [`backend/README.md`](backend/README.md). ✅

## 🗂️ Project layout

```
src/app/           # App Router pages, routes, loading/error states
components/        # Shared UI — cards, nav, pagination, playback
lib/               # Catalog helpers (browser + cached server-side)
public/            # Favicon, manifest, robots, sitemaps
backend/           # VPS origin: API, worker, PostgreSQL, Valkey, images
Dockerfile.frontend# Production standalone image
docs/              # Architecture, cache, pagination, migration notes
```

🧭 Category context rides in `returnTo=<encoded path+search>` — page 2/3/etc. stays addressable and reload-safe.

## ✅ The gate

```bash
npm run build
```
