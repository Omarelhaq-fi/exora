import { createFileRoute } from "@tanstack/react-router";
import { getServiceAccount, getGoogleAccessToken, verifyFirebaseIdToken } from "@/lib/firebase.server";
import { getCorsHeaders } from "@/lib/cors";
import { routeRequest } from "@/lib/ai-router.server";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit.server";
import { ensureQIndex, qindexLookup, normRef } from "@/lib/qindex.server";
import { gunzipSync } from "node:zlib";

let cachedQbanksList: any = null;
let cachedQbanksListTime = 0;
let cachedAllBanks: any = null;
let cachedAllBanksTime = 0;

import { dbStats } from "@/lib/firebase.server";

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
  let binary = '';
  for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  const store = dbStats.getStore();
  return new Response(JSON.stringify(body), {
    status,
    headers: { 
      "content-type": "application/json", 
      "x-firestore-reads": store ? String(store.reads) : "0",
      "x-firestore-writes": store ? String(store.writes) : "0",
      ...cors 
    },
  });
}

export const Route = createFileRoute("/api/qbank")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        return dbStats.run({reads: 0, writes: 0}, async () => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        
        const ip = getClientIp(request);
        const ipLimit = rateLimit(`qbank:ip:${ip}`, 60_000, 100);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        const urlObj = new URL(request.url);
        const action = urlObj.searchParams.get("action");
        
        const sa = getServiceAccount();
        const token = await getGoogleAccessToken();

        // Public endpoints - no auth required
        if (action === "get_peer_stats_threshold") {
          try {
            const { loadPeerStatsSettings } = await import("@/lib/peer-stats-settings.server");
            const settings = await loadPeerStatsSettings();
            console.log("[peer-public] returning threshold:", settings.threshold);
            return json({ threshold: settings.threshold }, 200, cors);
          } catch (e) {
            console.error("[peer-public] error:", e);
            return json({ threshold: 50 }, 200, cors);
          }
        }

        if (action === "debug_peer_stats_doc") {
          try {
            const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/admin/peer_stats_settings`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            const data = await r.json();
            return json({ raw: data }, 200, cors);
          } catch (e) {
            return json({ error: e.message }, 500, cors);
          }
        }

        // Auth required for everything below
        try {
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) return json({ error: "Unauthorized" }, 401, cors);
          const user = await verifyFirebaseIdToken(m[1]);
          const uid = String(user.sub || user.user_id || "");
          if (!uid) return json({ error: "Unauthorized" }, 401, cors);

          const userLimit = rateLimit(`qbank:uid:${uid}`, 60_000, 60);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          if (action === "list_categories") {
            if (cachedQbanksList && Date.now() - cachedQbanksListTime < 10 * 60_000) {
              return json({ qbanks: cachedQbanksList }, 200, cors);
            }

            const qbanks: any[] = [];
            let pageToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (pageToken) params.set("pageToken", pageToken);
              const listRes = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${params}`,
                {
                  method: "GET",
                  headers: { Authorization: `Bearer ${token}` }
                }
              );
              
              if (!listRes.ok && listRes.status !== 404) return json({ error: "Failed to load qbanks" }, 500, cors);
              if (listRes.status === 404) break;
              
              const data = await listRes.json();
              if (data && Array.isArray(data.documents)) {
                for (const doc of data.documents) {
                  const id = doc.name.split("/").pop();
                  const name = doc.fields?.name?.stringValue || id;
                  const country = doc.fields?.country?.stringValue || "global";
                  const updatedAtStr = doc.fields?.updatedAt?.integerValue || doc.fields?.updatedAt?.doubleValue;
                  const updatedAt = updatedAtStr ? parseInt(String(updatedAtStr), 10) : 0;
                  const isLocked = doc.fields?.isLocked?.booleanValue || doc.fields?.isLocked?.stringValue === "true" || false;
                  const isPartyLocked = doc.fields?.isPartyLocked?.booleanValue || doc.fields?.isPartyLocked?.stringValue === "true" || false;
                  let resources = [];
                  try { resources = JSON.parse(doc.fields?.resources?.stringValue || "[]"); } catch(e) {}
                  const kind = doc.fields?.kind?.stringValue || "main";
                  const college = doc.fields?.college?.stringValue || "";
                  const year = doc.fields?.year?.stringValue || "";
                  qbanks.push({ id, name, country, updatedAt, isLocked, isPartyLocked, resources, kind, college, year });
                }
              }
              pageToken = data.nextPageToken || "";
              if (!pageToken) break;
            }
            
            cachedQbanksList = qbanks;
            cachedQbanksListTime = Date.now();

            return json({ qbanks }, 200, cors);
          }

          if (action === "list_exam_prep") {
            const items: any[] = [];
            let epToken = "";
            while (true) {
              const params = new URLSearchParams({ pageSize: "300" });
              if (epToken) params.set("pageToken", epToken);
              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/exam_prep?${params}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!r.ok && r.status !== 404) return json({ error: "Failed to load exam prep entries" }, 500, cors);
              if (r.status === 404) break;
              const d = await r.json();
              for (const doc of (d.documents || [])) {
                const id = doc.name.split("/").pop();
                let qbankIds = [];
                try {
                  qbankIds = (doc.fields?.qbankIds?.arrayValue?.values || []).map((v: any) => v.stringValue || "").filter(Boolean);
                } catch {}
                items.push({
                  id,
                  title: doc.fields?.title?.stringValue || "(untitled)",
                  description: doc.fields?.description?.stringValue || "",
                  url: doc.fields?.url?.stringValue || "",
                  type: doc.fields?.type?.stringValue || "link",
                  country: doc.fields?.country?.stringValue || "global",
                  college: doc.fields?.college?.stringValue || "",
                  year: doc.fields?.year?.stringValue || "",
                  qbankIds
                });
              }
              epToken = d.nextPageToken || "";
              if (!epToken) break;
            }
            return json({ items }, 200, cors);
          }

          // ---------- Country-based qbank access ----------
          if (action === "bootstrap_access") {
            // Returns the caller's profile country, the main qbanks of that
            // country, the exam-prep sub-banks of that country, plus any
            // individually granted banks (admin-approved requests).
            const uRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`;
            const uRes = await fetch(uRef, { headers: { Authorization: `Bearer ${token}` } });
            let country = "";
            let grants: string[] = [];
            if (uRes.ok) {
              const ud = await uRes.json();
              country = String(ud.fields?.country?.stringValue || "").toLowerCase();
              const gv = ud.fields?.qbankGrants?.arrayValue?.values || [];
              grants = gv.map((v: any) => String(v.stringValue || "")).filter(Boolean);
            }

            // Load all banks (metadata)
            let allBanks: { id: string; country: string; kind: string }[] = [];
            
            if (cachedAllBanks && Date.now() - cachedAllBanksTime < 10 * 60_000) {
              allBanks = cachedAllBanks;
            } else {
              let bpt = "";
              while (true) {
                const bp = new URLSearchParams({ pageSize: "300" });
                if (bpt) bp.set("pageToken", bpt);
                const br = await fetch(
                  `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks?${bp}`,
                  { headers: { Authorization: `Bearer ${token}` } }
                );
                if (!br.ok || br.status === 404) break;
                const bd = await br.json();
                for (const d of bd.documents || []) {
                  allBanks.push({
                    id: d.name.split("/").pop(),
                    country: String(d.fields?.country?.stringValue || "global").toLowerCase(),
                    kind: String(d.fields?.kind?.stringValue || "main"),
                  });
                }
                bpt = bd.nextPageToken || "";
                if (!bpt) break;
              }
              cachedAllBanks = allBanks;
              cachedAllBanksTime = Date.now();
            }

            // Legacy/admin accounts have no country on file -> full access
            // (gating only applies to accounts created AFTER country selection)
            const legacy = !country;
            const mainIds = legacy
              ? allBanks.filter(b => b.kind !== "exam_prep").map(b => b.id)
              : allBanks.filter(b => b.kind !== "exam_prep" && b.country === country).map(b => b.id);
            const prepIds = legacy
              ? allBanks.filter(b => b.kind === "exam_prep").map(b => b.id)
              : allBanks.filter(b => b.kind === "exam_prep" && (b.country === country || grants.includes(b.id))).map(b => b.id);

            return json({ profileCountry: country, mainIds, prepIds, grants, legacy }, 200, cors);
          }


          if (action === "get_question") {
            // Live lookup by human code / doc id / doc-id prefix against the
            // shared in-memory index. Index is surgically updated on every
            // admin edit/import/delete, so results are always fresh. The
            // document itself is fetched live from Firestore.
            const rawRef = urlObj.searchParams.get("ref") || "";
            const hintBank = urlObj.searchParams.get("qbankId") || "";
            const wantRefresh = urlObj.searchParams.get("refresh") === "1";
            if (!rawRef || !/^[A-Za-z0-9_-]{3,64}$/.test(rawRef)) return json({ error: "Invalid ref" }, 400, cors);

            await ensureQIndex(wantRefresh);
            const candidates = qindexLookup(rawRef);
            if (candidates.length === 0) return json({ question: null, matches: 0 }, 404, cors);

            // Access Check Initialization
            let userCountry = "";
            let userGrants: string[] = [];
            let isLegacy = false;
            
            const uRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`;
            const uRes = await fetch(uRef, { headers: { Authorization: `Bearer ${token}` } });
            if (uRes.ok) {
              const ud = await uRes.json();
              userCountry = String(ud.fields?.country?.stringValue || "").toLowerCase();
              const gv = ud.fields?.qbankGrants?.arrayValue?.values || [];
              userGrants = gv.map((v: any) => String(v.stringValue || "")).filter(Boolean);
            }
            isLegacy = !userCountry;

            const validId = (x: string) => /^[a-zA-Z0-9_-]+$/.test(x);
            const fetchDoc = async (bid: string, qid: string) => {
              if (!validId(bid) || !validId(qid)) return null;

              // Access Verification Check
              const bRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${bid}`;
              const bRes = await fetch(bRef, { headers: { Authorization: `Bearer ${token}` } });
              if (!bRes.ok) return null;
              const bd = await bRes.json();
              const bCountry = String(bd.fields?.country?.stringValue || "global").toLowerCase();
              const bKind = String(bd.fields?.kind?.stringValue || "main");

              let hasAccess = isLegacy;
              if (!hasAccess) {
                if (bKind !== "exam_prep") {
                  hasAccess = (bCountry === userCountry);
                } else {
                  hasAccess = (bCountry === userCountry) || userGrants.includes(bid);
                }
              }
              if (!hasAccess) return null;

              const r = await fetch(
                `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${bid}/questions/${qid}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!r.ok) return null;
              const doc = await r.json();
              let parsed: any = {};
              try { parsed = JSON.parse(doc.fields?.data?.stringValue || "{}"); } catch {}
              return { id: qid, text: doc.fields?.questionText?.stringValue || "", data: parsed, qbankId: bid };
            };

            // Rank: hinted bank first
            const rank = (e: any) => (validId(hintBank) && e.qbankId === hintBank ? 0 : 1);
            candidates.sort((a: any, b: any) => rank(a) - rank(b));

            const alive: any[] = [];
            for (const c of candidates.slice(0, 5)) {
              const doc = await fetchDoc(c.qbankId, c.questionId);
              if (doc) alive.push(doc);
            }
            if (alive.length === 0) {
              // stale index entries — force rebuild next time
              await ensureQIndex(true).catch(() => {});
              return json({ question: null, matches: candidates.length }, 404, cors);
            }
            const [best, ...rest] = alive;
            return json({
              question: best,
              matches: candidates.length,
              alternatives: rest.map(r => ({ qbankId: r.qbankId, id: r.id })),
            }, 200, cors);
          }

          if (action === "get_questions") {
            const qbankId = urlObj.searchParams.get("qbankId");
            const onlyProgress = urlObj.searchParams.get("onlyProgress") === "true";
            if (!qbankId) return json({ error: "Missing qbankId" }, 400, cors);
            
            // Validate alphanumeric to prevent basic injection, though it's just a path param
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Invalid qbankId" }, 400, cors);

            // Security: Verify user has access to this QBank
            const uRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`;
            const uRes = await fetch(uRef, { headers: { Authorization: `Bearer ${token}` } });
            let userCountry = "";
            let userGrants: string[] = [];
            if (uRes.ok) {
              const ud = await uRes.json();
              userCountry = String(ud.fields?.country?.stringValue || "").toLowerCase();
              const gv = ud.fields?.qbankGrants?.arrayValue?.values || [];
              userGrants = gv.map((v: any) => String(v.stringValue || "")).filter(Boolean);
            }
            const isLegacy = !userCountry;

            const bRef = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}`;
            const bRes = await fetch(bRef, { headers: { Authorization: `Bearer ${token}` } });
            if (!bRes.ok) return json({ error: "QBank not found" }, 404, cors);
            const bd = await bRes.json();
            const bCountry = String(bd.fields?.country?.stringValue || "global").toLowerCase();
            const bKind = String(bd.fields?.kind?.stringValue || "main");

            let hasAccess = isLegacy;
            if (!hasAccess) {
              if (bKind !== "exam_prep") {
                hasAccess = (bCountry === userCountry);
              } else {
                hasAccess = (bCountry === userCountry) || userGrants.includes(qbankId);
              }
            }

            if (!hasAccess) {
              return json({ error: "Forbidden: You do not have access to this QBank." }, 403, cors);
            }

            const questions: any[] = [];
            
            if (!onlyProgress) {
              // 1. Try fetching from chunks
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
                          let parsedChunk;
                          if (dataStr.trim().startsWith("[")) {
                            parsedChunk = JSON.parse(dataStr);
                          } else {
                            const buf = Buffer.from(dataStr, 'base64');
                            const rawJson = gunzipSync(buf).toString('utf-8');
                            parsedChunk = JSON.parse(rawJson);
                          }
                          questions.push(...parsedChunk);
                        } catch (e) {
                          console.error("Failed to parse chunk", doc.name, e);
                        }
                     }
                  }
              }

              // 2. Fallback to fetching individual questions if no chunks exist
              if (!fetchedFromChunks) {
                let pageTokenQ = "";
                while (true) {
                  const params = new URLSearchParams({ pageSize: "300" });
                  if (pageTokenQ) params.set("pageToken", pageTokenQ);
                  const qRes = await fetch(
                    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions?${params}`,
                    {
                      method: "GET",
                      headers: { Authorization: `Bearer ${token}` }
                    }
                  );
                  
                  if (!qRes.ok && qRes.status !== 404) return json({ error: "Failed to load questions" }, 500, cors);
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
                        } catch (e) {
                          console.error("Failed to parse qbank question", id, e);
                        }
                      }
                    }
                  }
                  pageTokenQ = qData.nextPageToken || "";
                  if (!pageTokenQ) break;
                }
              }
            }
            
            const progressMap: Record<string, any> = {};
            const pRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            
            if (pRes.ok) {
              try {
                const doc = await pRes.json();
                const fields = doc.fields?.progress?.mapValue?.fields || {};
                for (const [qId, val] of Object.entries(fields)) {
                  const data: any = (val as any).mapValue?.fields || {};
                  progressMap[qId] = {
                    correct: data.correct?.booleanValue,
                    timeTakenMs: parseInt(data.timeTakenMs?.integerValue || "0", 10),
                    marked: data.marked?.booleanValue || false,
                    note: data.note?.stringValue || ""
                  };
                }
              } catch (e) {
                console.error("Failed to parse progress blob", e);
              }
            }

            if (!onlyProgress && questions.length > 0) {
              const questionsJson = JSON.stringify(questions);
              const encryptedQuestions = await encryptDRM(questionsJson);
              return json({ encryptedQuestions, progress: progressMap }, 200, cors);
            }

            return json({ questions, progress: progressMap }, 200, cors);
          }

          if (action === "get_study_concept") {
            const qbankId = urlObj.searchParams.get("qbankId");
            const questionId = urlObj.searchParams.get("questionId");
            if (!qbankId || !questionId) return json({ error: "Missing ids" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) return json({ error: "Invalid ids" }, 400, cors);

            const r = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            
            if (!r.ok) return json({ studyConcept: null }, 200, cors);
            const doc = await r.json();
            const studyConcept = doc.fields?.studyConcept?.stringValue || null;
            return json({ studyConcept }, 200, cors);
          }

          return json({ error: "Invalid action" }, 400, cors);
        } catch (e) {
          console.error("[qbank GET]", (e as Error).message);
          return json({ error: "Server error" }, 500, cors);
        }
        });
      },
      POST: async ({ request }) => {
        return dbStats.run({reads: 0, writes: 0}, async () => {
        const cors = getCorsHeaders(request, { methods: "POST, GET, OPTIONS" });
        
        const ip = getClientIp(request);
        const ipLimit = rateLimit(`qbank:ip:${ip}`, 60_000, 100);
        if (!ipLimit.ok) return rateLimitResponse(ipLimit.retryAfter, cors);

        try {
          const auth = request.headers.get("authorization") || "";
          const m = auth.match(/^Bearer\s+(.+)$/i);
          if (!m) return json({ error: "Unauthorized" }, 401, cors);
          const user = await verifyFirebaseIdToken(m[1]);
          const uid = String(user.sub || user.user_id || "");
          if (!uid) return json({ error: "Unauthorized" }, 401, cors);

          const userLimit = rateLimit(`qbank:uid:${uid}`, 60_000, 60);
          if (!userLimit.ok) return rateLimitResponse(userLimit.retryAfter, cors);

          const body = (await request.json()) as any;
          const sa = getServiceAccount();
          const token = await getGoogleAccessToken();
          if (body.action === "batch_sync_progress") {
            const { updates } = body;
            if (!Array.isArray(updates) || updates.length === 0) return json({ ok: true }, 200, cors);
            if (updates.length > 100) return json({ error: "Too many updates in batch" }, 400, cors);
            
            let incrementAnswerCount = 0;
            const qbankUpdates: Record<string, { paths: Set<string>, progressFields: any }> = {};
            
            for (const u of updates) {
               if (!/^[a-zA-Z0-9_-]+$/.test(u.qbankId) || !/^[a-zA-Z0-9_-]+$/.test(u.questionId)) {
                  throw new Error("Invalid identifiers");
               }
               if (!qbankUpdates[u.qbankId]) {
                   qbankUpdates[u.qbankId] = { paths: new Set<string>(), progressFields: {} };
               }
               
               let qField: any = {};
               if (qbankUpdates[u.qbankId].progressFields[u.questionId]) {
                   qField = qbankUpdates[u.qbankId].progressFields[u.questionId].mapValue.fields;
               }
               
               if (u.correct !== undefined) { 
                   qField.correct = { booleanValue: !!u.correct }; 
                   incrementAnswerCount++;
               }
               if (u.timeTakenMs !== undefined) { qField.timeTakenMs = { integerValue: String(u.timeTakenMs) }; }
               if (u.marked !== undefined) { qField.marked = { booleanValue: !!u.marked }; }
               if (u.note !== undefined) { qField.note = { stringValue: String(u.note) }; }
               qField.timestamp = { timestampValue: new Date().toISOString() };
               
               qbankUpdates[u.qbankId].progressFields[u.questionId] = { mapValue: { fields: qField } };
               
               if (u.correct !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.correct`);
               if (u.timeTakenMs !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.timeTakenMs`);
               if (u.marked !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.marked`);
               if (u.note !== undefined) qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.note`);
               qbankUpdates[u.qbankId].paths.add(`progress.\`${u.questionId}\`.timestamp`);
            }

            const writes = Object.keys(qbankUpdates).map(qbankId => {
               const data = qbankUpdates[qbankId];
               return {
                 update: {
                   name: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}`,
                   fields: {
                     progress: {
                       mapValue: {
                         fields: data.progressFields
                       }
                     }
                   }
                 },
                 updateMask: { fieldPaths: Array.from(data.paths) }
               };
            });

            if (incrementAnswerCount > 0) {
               writes.push({
                 transform: {
                   document: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`,
                   fieldTransforms: [{
                     fieldPath: "qbankAnswerCount",
                     increment: { integerValue: String(incrementAnswerCount) }
                   }]
                 }
               });
            }
            
            const commitUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            const commitRes = await fetch(commitUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ writes })
            });
            
            if (!commitRes.ok) {
              const errTxt = await commitRes.text();
              console.error("Batch sync failed", errTxt);
              return json({ error: "Failed to sync progress: " + errTxt }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "save_progress") {
            const { qbankId, questionId, correct, timeTakenMs } = body;
            
            if (!qbankId || !questionId || typeof correct !== "boolean" || typeof timeTakenMs !== "number") {
              return json({ error: "Invalid payload" }, 400, cors);
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) {
               return json({ error: "Invalid identifiers" }, 400, cors);
            }

            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}?updateMask.fieldPaths=progress.${questionId}.correct&updateMask.fieldPaths=progress.${questionId}.timeTakenMs&updateMask.fieldPaths=progress.${questionId}.timestamp`;
            
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  progress: {
                    mapValue: {
                      fields: {
                        [questionId]: {
                          mapValue: {
                            fields: {
                              correct: { booleanValue: correct },
                              timeTakenMs: { integerValue: String(timeTakenMs) },
                              timestamp: { timestampValue: new Date().toISOString() }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Save progress failed", errTxt);
              return json({ error: "Failed to save progress" }, 500, cors);
            }

            // Increment the overall qbankAnswerCount in users_index
            const incUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            fetch(incUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                writes: [{
                  transform: {
                    document: `projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}`,
                    fieldTransforms: [{ fieldPath: "qbankAnswerCount", increment: { integerValue: "1" } }]
                  }
                }]
              })
            }).catch(e => console.error("Failed to increment answer count", e));
            
            return json({ ok: true }, 200, cors);
          }
          
          if (body.action === "update_question_meta") {
            const { qbankId, questionId, marked, note } = body;
            
            if (!qbankId || !questionId) {
              return json({ error: "Invalid payload" }, 400, cors);
            }
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) {
               return json({ error: "Invalid identifiers" }, 400, cors);
            }

            const qField: any = {
              timestamp: { timestampValue: new Date().toISOString() }
            };
            const paths = [`progress.${questionId}.timestamp`];
            
            if (marked !== undefined) {
              qField.marked = { booleanValue: !!marked };
              paths.push(`progress.${questionId}.marked`);
            }
            if (note !== undefined) {
              qField.note = { stringValue: String(note) };
              paths.push(`progress.${questionId}.note`);
            }

            const maskStr = paths.map(m => `updateMask.fieldPaths=${m}`).join("&");
            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_progress_blobs/${qbankId}?${maskStr}`;
            
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  progress: {
                    mapValue: {
                      fields: {
                        [questionId]: {
                          mapValue: {
                            fields: qField
                          }
                        }
                      }
                    }
                  }
                }
              })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Update meta failed", errTxt);
              return json({ error: "Failed to update metadata" }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }
          if (body.action === "report_question") {
            const { qbankId, questionId, reason } = body;
            if (!qbankId || !questionId || !reason) return json({ error: "Missing fields" }, 400, cors);
            
            const sa = getServiceAccount();
            const token = await getGoogleAccessToken();
            const commitUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`;
            
            const writes = [
              {
                update: {
                  name: `projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
                  fields: {
                    reported: { booleanValue: true }
                  }
                },
                updateMask: { fieldPaths: ["reported"] }
              },
              {
                transform: {
                  document: `projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}`,
                  fieldTransforms: [
                    {
                      fieldPath: "reports",
                      appendMissingElements: {
                        values: [
                          {
                            mapValue: {
                              fields: {
                                uid: { stringValue: uid },
                                reason: { stringValue: String(reason) },
                                timestamp: { timestampValue: new Date().toISOString() }
                              }
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            ];
            
            const commitRes = await fetch(commitUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ writes })
            });
            
            if (!commitRes.ok) {
              const errTxt = await commitRes.text();
              console.error("Report question failed", errTxt);
              return json({ error: "Failed to report question" }, 500, cors);
            }
            
            return json({ ok: true }, 200, cors);
          }
          
          if (body.action === "chat_question") {
             if (!body.questionContext || !body.userMessage) {
                return json({ error: "Missing context or message" }, 400, cors);
             }

             const messages = [
               {
                 role: "system",
                 content: "You are an expert medical AI tutor. The user is asking a follow-up question about a specific exam question they just reviewed. Be helpful, concise, and explain concepts clearly. Use markdown formatting.\n\nIMPORTANT: Do NOT output your internal thinking process or any <think> tags. Just output the final response.\n\nHere is the question context:\n" + body.questionContext
               },
               {
                 role: "user",
                 content: body.userMessage
               }
             ];

             const r = await routeRequest({ messages, requireJson: false });
             
             let finalRes = r.text || "";
             // Strip out <think> tags if the model still includes them
             finalRes = finalRes.replace(/<think>[\s\S]*?<\/think>/gi, "");
             
             // In some cases OpenRouter or deepseek injects "Here's a thinking process:" 
             // We can strip anything before a horizontal rule if it's explicitly a thinking process,
             // or simply strip the specific string.
             if (finalRes.includes("Here's a thinking process:")) {
                const parts = finalRes.split("---\n");
                if (parts.length > 1) {
                    finalRes = parts.slice(1).join("---\n");
                } else {
                    // fallback if no horizontal rule
                    finalRes = finalRes.replace(/Here's a thinking process:[\s\S]*?(\n\n|$)/gi, "");
                }
             }

             return json({ response: finalRes.trim() }, 200, cors);
          }
          
          if (body.action === "save_flashcard") {
             const { questionId, qbankId, front, back, concepts } = body;
             if (!questionId || !front) return json({ error: "Missing fields" }, 400, cors);
             
             // Ensure reasonable limits
             const cardId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
             const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users_index/${uid}/qbank_flashcards/${cardId}`;
             
             const createRes = await fetch(docUrl, {
               method: "PATCH",
               headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
               body: JSON.stringify({
                 fields: {
                   questionId: { stringValue: String(questionId) },
                   qbankId: { stringValue: String(qbankId || "") },
                   front: { stringValue: String(front) },
                   back: { stringValue: String(back || "") },
                   concepts: { stringValue: String(concepts || "") },
                   timestamp: { timestampValue: new Date().toISOString() },
                   nextReviewAt: { timestampValue: new Date().toISOString() },
                   interval: { integerValue: "0" },
                   repetition: { integerValue: "0" },
                   ease: { doubleValue: 2.5 }
                 }
               })
             });
             
             if (!createRes.ok) {
               const errTxt = await createRes.text();
               console.error("Save flashcard failed", errTxt);
               return json({ error: "Failed to save flashcard" }, 500, cors);
             }
             
             return json({ ok: true, cardId }, 200, cors);
          }
          
          if (body.action === "request_access") {
            // Student asks for permission to open another country's bank.
            const qbankId = String(body?.qbankId || "");
            const reason = String(body?.reason || "").trim().slice(0, 600);
            if (!qbankId || !/^[a-zA-Z0-9_-]+$/.test(qbankId)) return json({ error: "Missing qbankId" }, 400, cors);
            if (!reason || reason.length < 5) return json({ error: "Please provide a short reason" }, 400, cors);

            // Basic rate limit: max 10 open requests per user
            const q = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:runQuery`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  structuredQuery: {
                    from: [{ collectionId: "access_requests" }],
                    where: {
                      compositeFilter: { op: "AND", filters: [
                        { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
                        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
                      ] },
                    },
                    limit: 10,
                  },
                }),
              }
            );
            if (q.ok) {
              const qd = await q.json();
              const pending = (qd || []).filter((x: any) => x.document).length;
              if (pending >= 10) return json({ error: "You already have many pending requests. Please wait." }, 429, cors);
            }

            const now = new Date();
            const reqId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
            const fields: Record<string, any> = {
              uid: { stringValue: uid },
              email: { stringValue: String((user as any).email || "") },
              qbankId: { stringValue: qbankId },
              reason: { stringValue: reason },
              status: { stringValue: "pending" },
              createdAt: { timestampValue: now.toISOString() },
            };
            const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${f}`).join("&");
            const wr = await fetch(
              `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/access_requests/${reqId}?${mask}`,
              {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ fields }),
              }
            );
            if (!wr.ok) {
              console.error("[request_access] write failed", wr.status, await wr.text().catch(() => ""));
              return json({ error: "Could not file request" }, 500, cors);
            }
            return json({ ok: true }, 200, cors);
          }

          if (body.action === "save_study_concept") {
            const { qbankId, questionId, studyConcept } = body;
            if (!qbankId || !questionId || !studyConcept) return json({ error: "Missing fields" }, 400, cors);
            if (!/^[a-zA-Z0-9_-]+$/.test(qbankId) || !/^[a-zA-Z0-9_-]+$/.test(questionId)) return json({ error: "Invalid ids" }, 400, cors);

            const docUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/qbanks/${qbankId}/questions/${questionId}?updateMask.fieldPaths=studyConcept`;
            
            const patchRes = await fetch(docUrl, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  studyConcept: { stringValue: String(studyConcept) }
                }
              })
            });
            
            if (!patchRes.ok) {
              const errTxt = await patchRes.text();
              console.error("Save study concept failed", errTxt);
              return json({ error: "Failed to save study concept" }, 500, cors);
            }
            return json({ ok: true }, 200, cors);
          }
          
          return json({ error: "Invalid POST action" }, 400, cors);
        } catch (e) {
          console.error("[qbank POST]", (e as Error).message);
          return json({ error: "Server Error" }, 500, cors);
        }
        });
      },
    },
  },
});
