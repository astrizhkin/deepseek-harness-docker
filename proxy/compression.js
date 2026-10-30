// Response-body compression-compatible pipeline: decompress -> rewrite -> recompress.
//
// Background: the DSH 0.1.2+ web server enables gzip by default (compression: gzip), and a compressed
// response is a binary byte stream, so any rewrite based on plaintext strings (HTML polyfill injection, isLoopbackHostname
// replacement) cannot match. The previous approach stripped Accept-Encoding when forwarding to force the upstream to return plaintext,
// relying on the assumption that "the upstream honors HTTP content negotiation".
//
// This module instead fully supports every compression form from browsers/upstreams (gzip / deflate / br, plus uncompressed
// identity): when forwarding, keep the upstream's compressed response, buffer the complete body -> decompress to
// plaintext per Content-Encoding -> apply the rewrite -> recompress with the original encoding and send it back. This way, regardless of whether the upstream compresses and in which format,
// the rewrite logic still works; when an unsupported encoding (e.g. zstd) is met or decompression fails, pass through as-is and never break the response.
const zlib = require('zlib');

// Parse the encoding from the Content-Encoding header. It may look like "gzip", "br", or "gzip, br"; take the first valid value.
// Empty/identity means uncompressed. When unrecognizable, return the original string (the caller treats it as unsupported).
function parseEncoding(ce) {
  if (!ce) return 'identity';
  const first = String(ce).split(',')[0].trim().toLowerCase();
  return first || 'identity';
}

// Decompress to plaintext. identity returns the original Buffer directly; gzip/deflate/br are supported; anything else or a failure returns null.
function decompress(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  try {
    switch (encoding) {
      case 'gzip':
        return zlib.gunzipSync(buf);
      case 'deflate':
        // Prefer the standard zlib wrapper; some servers send raw deflate (RFC 1951), so fall back to trying it after a failure
        try {
          return zlib.inflateSync(buf);
        } catch {
          return zlib.inflateRawSync(buf);
        }
      case 'br':
        return zlib.brotliDecompressSync(buf);
      default:
        return null; // unsupported encoding (e.g. zstd) -> cannot rewrite
    }
  } catch {
    return null;
  }
}

// Recompress with the original encoding. identity returns the original Buffer directly; gzip/deflate/br are supported; anything else or a failure returns null.
function recompress(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  try {
    switch (encoding) {
      case 'gzip':
        return zlib.gzipSync(buf);
      case 'deflate':
        return zlib.deflateSync(buf);
      case 'br':
        return zlib.brotliCompressSync(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Attach the "buffer -> decompress -> transform(plaintext) -> recompress -> output" pipeline to res, for use by
// http-proxy's proxyRes event. After rewriting the length necessarily changes, so content-length is deleted uniformly and the body is sent chunked.
//   transform(plainBuffer) -> returns the rewritten Buffer; returning null means no rewrite needed (pass through as-is).
// Degradation strategy (guaranteeing the response is never broken under any circumstances):
//   - upstream compressed but decompression failed / encoding unsupported -> pass the compressed bytes through as-is, keeping the upstream's Content-Encoding value;
//   - recompression after rewriting fails -> degrade to sending plaintext and delete Content-Encoding, so the browser reads it as plaintext;
//   - uncompressed (identity) -> rewrite directly, incurring no compression overhead at all.
function attachBodyTransform(res, proxyRes, transform) {
  const encoding = parseEncoding(proxyRes.headers['content-encoding']);
  delete proxyRes.headers['content-length'];
  res.removeHeader('content-length');

  const chunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  };
  res.end = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.write = origWrite;
    res.end = origEnd;

    const raw = Buffer.concat(chunks);
    let out = raw;
    const plain = decompress(raw, encoding);
    if (plain !== null) {
      const rewritten = transform(plain);
      if (rewritten !== null) {
        const compressed = recompress(rewritten, encoding);
        if (compressed !== null) {
          out = compressed; // decompress -> rewrite -> recompress succeeded, Content-Encoding keeps the original encoding
        } else {
          out = rewritten; // recompression failed: degrade to sending plaintext; Content-Encoding must be removed or the browser will decode garbage
          delete proxyRes.headers['content-encoding'];
        }
      }
    }
    origEnd(out, ...rest);
  };
}

module.exports = { parseEncoding, decompress, recompress, attachBodyTransform };
