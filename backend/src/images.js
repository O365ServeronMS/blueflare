import {
  createHash,
  createHmac,
  timingSafeEqual
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import sharp from 'sharp';
import { config } from './config.js';
import { createLocalImageStore } from './imageStore.js';
import { observeCache } from './observability.js';
import { pool } from './db.js';

const variants = Object.freeze({
  m: { width: 480, height: 720, quality: 75 },
  d: { width: 1280, height: 720, quality: 75 }
});

function normalizedUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS image sources are allowed');
  }
  parsed.hash = '';
  return parsed.toString();
}

function allowedImageHost(hostname) {
  return config.imageAllowedHosts.some((allowed) => (
    hostname === allowed || hostname.endsWith('.' + allowed)
  ));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(value) {
  return createHmac('sha256', config.imageSigningSecret)
    .update(value)
    .digest('hex');
}

function signature(variant, upstreamUrl) {
  return 'v2.' + hmac('v2\n' + variant + '\n' + upstreamUrl);
}

function legacySignature(variant, upstreamUrl) {
  return 'v1.' + hmac(variant + '\n' + upstreamUrl);
}

export function signedImageUrl(upstreamUrl, variant) {
  if (!upstreamUrl) return '';
  const normalized = normalizedUrl(upstreamUrl);
  const hash = digest(normalized);
  const sig = signature(variant, normalized);
  return config.publicBaseUrl + '/i/' + variant + '/' + hash +
    '.webp?url=' + encodeURIComponent(normalized) +
    '&sig=' + encodeURIComponent(sig);
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

const imageStore = createLocalImageStore(config.imageCacheDir);
const imageInFlight = new Map();
const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fetchSource(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !allowedImageHost(parsed.hostname)) {
    throw new Error('Image source host is not allowed');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'BlueflareImageCache/1.0' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error('Image source returned HTTP ' + response.status);
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 20 * 1024 * 1024) {
      throw new Error('Image source is larger than 20 MiB');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) {
      throw new Error('Image source is larger than 20 MiB');
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function serveSignedImage(request, response, pathname, searchParams) {
  const assetMatch = pathname.match(/^\/i\/([md])\/([0-9a-f-]{36})\.webp$/i);
  if (assetMatch && assetIdPattern.test(assetMatch[2])) {
    const variant = assetMatch[1];
    const assetId = assetMatch[2].toLowerCase();
    const assetResult = await pool.query(
      'SELECT source_url FROM image_assets WHERE id=$1', [assetId]
    );
    if (!assetResult.rowCount) {
      response.writeHead(404).end();
      return true;
    }
    let filename = await imageStore.find(variant, assetId);
    let cacheStatus = filename ? 'IMAGE-DISK-HIT' : 'IMAGE-DISK-MISS';
    if (!filename) {
      const key = variant + ':' + assetId;
      let pending = imageInFlight.get(key);
      if (!pending) {
        pending = (async () => {
          const target = await imageStore.prepareWrite(variant, assetId);
          try {
            const source = await fetchSource(assetResult.rows[0].source_url);
            const variantConfig = variants[variant];
            await sharp(source)
              .rotate()
              .resize(variantConfig.width, variantConfig.height, { fit: 'cover', position: 'attention' })
              .webp({ quality: variantConfig.quality })
              .toFile(target.temporary);
            await rename(target.temporary, target.filename);
            return target.filename;
          } catch (error) {
            await unlink(target.temporary).catch(() => {});
            throw error;
          }
        })();
        imageInFlight.set(key, pending);
        pending.finally(() => imageInFlight.delete(key)).catch(() => {});
      }
      filename = await pending;
      cacheStatus = 'IMAGE-BUILD';
    }
    observeCache(cacheStatus);
    const metadata = await stat(filename);
    const etag = '"v3-' + variant + '-' + assetId + '"';
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return true;
    }
    response.writeHead(200, {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': metadata.size,
      'content-type': 'image/webp', etag
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filename).pipe(response);
    return true;
  }

  const match = pathname.match(/^\/i\/([md])\/([a-f0-9]{64})\.webp$/);
  if (!match) return false;

  const variant = match[1];
  const expectedHash = match[2];
  const upstreamUrl = normalizedUrl(searchParams.get('url') || '');
  const parsed = new URL(upstreamUrl);
  if (!allowedImageHost(parsed.hostname)) {
    response.writeHead(403).end();
    return true;
  }
  const providedSignature = searchParams.get('sig');
  if (
    digest(upstreamUrl) !== expectedHash ||
    (
      !secureEqual(providedSignature, signature(variant, upstreamUrl)) &&
      !secureEqual(providedSignature, legacySignature(variant, upstreamUrl))
    )
  ) {
    response.writeHead(403).end();
    return true;
  }

  let filename = await imageStore.find(variant, expectedHash);
  let cacheStatus = filename ? 'IMAGE-DISK-HIT' : 'IMAGE-DISK-MISS';
  if (!filename) {
    const key = variant + ':' + expectedHash;
    let pending = imageInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const target = await imageStore.prepareWrite(variant, expectedHash);
        try {
          const source = await fetchSource(upstreamUrl);
          const variantConfig = variants[variant];
          await sharp(source)
            .rotate()
            .resize(variantConfig.width, variantConfig.height, {
              fit: 'cover',
              position: 'attention'
            })
            .webp({ quality: variantConfig.quality })
            .toFile(target.temporary);
          await rename(target.temporary, target.filename);
          return target.filename;
        } catch (error) {
          await unlink(target.temporary).catch(() => {});
          throw error;
        }
      })();
      imageInFlight.set(key, pending);
      pending.finally(() => imageInFlight.delete(key)).catch(() => {});
    }
    filename = await pending;
    cacheStatus = 'IMAGE-BUILD';
  }
  observeCache(cacheStatus);

  const metadata = await stat(filename);
  const etag = '"v2-' + variant + '-' + expectedHash + '"';
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag });
    response.end();
    return true;
  }

  response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': metadata.size,
    'content-type': 'image/webp',
    etag
  });
  createReadStream(filename).pipe(response);
  return true;
}
