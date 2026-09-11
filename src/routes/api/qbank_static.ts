// Public CDN-cached endpoint for QBank question payloads.
// This endpoint is intentionally PUBLIC (no Authorization header required)
// so that Vercel's Edge CDN can cache the response globally.
//
// Security model:
//   - The questions are encrypted with AES-GCM (DRM) before being sent.
//   - The client must have a valid Firebase session to call the private
//     /api/qbank?action=bootstrap_access endpoint first, which validates
//     access and returns the `updatedAt` version stamp used as the `v` param.
//   - Without the DRM key (server-only env var), the payload is useless.
//
// Cache strategy:
//   - Cache-Control: public, s-maxage=31536000, stale-while-revalidate=60
//   - The `v` query param is the qbank's `updatedAt` timestamp.
//   - When admin publishes new chunks, the `updatedAt` changes, the URL
//     changes, and Vercel's CDN fetches a fresh copy automatically.
//   - Old cached versions are harmlessly ignored by the client.

import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, dbStats } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { gunzipSync } from "node:zlib";

const DRM_KEY_STR = process.env.DRM_KEY || "8f7e6d5c4b3a29108f7e6d5c4b3a2910";

async function encryptDRM(text: string) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(DRM_KEY_STR);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  let binary = "";
  for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

export const Route = createFileRoute("/api/qbank_static")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        return dbStats.run({ reads: 0, writes: 0 }, async () => {
        const cors = getCorsHeaders(request, { methods: "GET, OPTIONS" });
        const ip = getClientIp(request);
        // Generous rate limit since most requests will be served from CDN cache
        const rl = rateLimit(`qbank-static:${ip}`, 60_000, 30);
        if (!rl.ok) return rateLimitResponse(rl.retryAfter, cors);

        const urlObj = new URL(request.url);
        const qbankId = urlObj.searchParams.get("qbankId");
        const v = urlObj.searchParams.get("v"); // version/updatedAt stamp

        if (!qbankId || !/^[a-zA-Z0-9_-]+$/.test(qbankId)) {
          return new Response(JSON.stringify({ error: "Missing or invalid qbankId" }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }

        try {
          const sa = getServiceAccount();
          const token = await getGoogleAccessToken();

          const questions: any[] = [];

          // 1. Try fetching from compressed chunks
          let fetchedFromChunks = false;
          let chunkToken = "";
          const allChunks: any[] = [];

          while (true) {
            const params = new URLSearchParams({ pageSize: "100" });
            if (chunkToken) params.set("pageToken", chunkToken);
            const chunkUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/chunks?${params}`;
            const chunkRes = await fetch(chunkUrl, { headers: { Authorization: `Bearer ${token}` } });
            if (!chunkRes.ok || chunkRes.status === 404) break;
            const chunkData = await chunkRes.json();
            if (chunkData.documents && chunkData.documents.length > 0) {
              fetchedFromChunks = true;
              allChunks.push(...chunkData.documents);
            }
            chunkToken = chunkData.nextPageToken || "";
            if (!chunkToken) break;
          }

          if (fetchedFromChunks) {
            allChunks.sort((a, b) => {
              const aIdx = parseInt(a.fields?.index?.integerValue || "0", 10);
              const bIdx = parseInt(b.fields?.index?.integerValue || "0", 10);
              return aIdx - bIdx;
            });
            for (const doc of allChunks) {
              const dataStr = doc.fields?.data?.stringValue;
              if (dataStr) {
                try {
                  let parsedChunk: any[];
                  if (dataStr.trim().startsWith("[")) {
                    // Legacy uncompressed JSON array
                    parsedChunk = JSON.parse(dataStr);
                  } else {
                    // New gzip+base64 format
                    const buf = Buffer.from(dataStr, "base64");
                    const rawJson = gunzipSync(buf).toString("utf-8");
                    parsedChunk = JSON.parse(rawJson);
                  }
                  questions.push(...parsedChunk);
                } catch (e) {
                  console.error("[qbank_static] Failed to parse chunk", doc.name, e);
                }
              }
            }
          }

          // 2. Fallback: fetch individual question documents (pre-chunk QBanks)
          if (!fetchedFromChunks) {
            let pageTokenQ = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageTokenQ) params.set("pageToken", pageTokenQ);
              const qRes = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions?${params}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!qRes.ok && qRes.status !== 404) break;
              if (qRes.status === 404) break;
              const qData = await qRes.json();
              if (qData && Array.isArray(qData.documents)) {
                for (const doc of qData.documents) {
                  const id = doc.name.split("/").pop();
                  const text = doc.fields?.questionText?.stringValue || "";
                  const dataStr = doc.fields?.data?.stringValue;
                  if (dataStr) {
                    try {
                      const parsed = JSON.parse(dataStr);
                      questions.push({ id, text, data: parsed });
                    } catch {}
                  }
                }
              }
              pageTokenQ = qData.nextPageToken || "";
              if (!pageTokenQ) break;
            }
          }

          if (questions.length === 0) {
            return new Response(JSON.stringify({ error: "No questions found" }), {
              status: 404,
              headers: { "content-type": "application/json", ...cors },
            });
          }

          // Encrypt with DRM before sending to client
          const encryptedQuestions = await encryptDRM(JSON.stringify(questions));

          // Build response with aggressive CDN caching.
          // Vercel's Edge will cache this at their global edge nodes.
          // The `v` param ensures cache busting when the QBank is updated.
          const store = dbStats.getStore();
          const cacheHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-questions-count": String(questions.length),
            "x-firestore-reads": store ? String(store.reads) : "0",
            "x-cache-status": "ORIGIN",
            ...cors,
          };

          if (v) {
            // Versioned URL → cache for 1 year on Vercel's CDN
            cacheHeaders["Cache-Control"] = "public, s-maxage=31536000, stale-while-revalidate=60";
            cacheHeaders["CDN-Cache-Control"] = "public, max-age=31536000";
            cacheHeaders["Vercel-CDN-Cache-Control"] = "public, max-age=31536000";
          } else {
            // Unversioned URL → short cache (1 minute) to still help under load
            cacheHeaders["Cache-Control"] = "public, s-maxage=60, stale-while-revalidate=30";
          }

          return new Response(JSON.stringify({ encryptedQuestions }), {
            status: 200,
            headers: cacheHeaders,
          });
        } catch (e: any) {
          console.error("[qbank_static] Error:", e?.message);
          return new Response(JSON.stringify({ error: "Server error" }), {
            status: 500,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        }); // end dbStats.run
      },
    },
  },
});
