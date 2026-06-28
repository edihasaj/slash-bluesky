#!/usr/bin/env node
// slash-bluesky — Edi's local Bluesky CLI. Post / reply / read via AT Protocol.
// No dependencies. Uses browser session tokens first, then app-password fallback.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PDS = process.env.BLUESKY_PDS || "https://bsky.social";

const HELP = `slash-bluesky — post and reply on Bluesky from the command line

Usage:
  slash-bluesky post <text>              Publish a new post
  slash-bluesky post --file f            Publish from a file
  slash-bluesky reply <post> <text>      Reply to a post (URL or at:// uri)
  slash-bluesky whoami                   Show the logged-in account
  slash-bluesky check                    Verify credentials / login

Auth (https://bsky.app/settings/app-passwords):
  Browser session auto-detected from Chrome/Brave/Edge storage when present.
  BLUESKY_IDENTIFIER=you.bsky.social   BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
  (or pass --identifier / --password)

Options:
  --file <path>             Read body text from a file
  --browser-profile <path>  Browser profile dir or Local Storage/leveldb dir
  --no-browser              Skip browser session lookup
  --json                    Machine-readable JSON output

Examples:
  slash-bluesky post "shipping slash-bluesky 🦋"
  slash-bluesky reply https://bsky.app/profile/someone.bsky.social/post/3kabc "nice!"
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "json") out.flags.json = true; else out.flags[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function cfg(flags) {
  return {
    identifier: flags.identifier || process.env.BLUESKY_IDENTIFIER || "",
    password: flags.password || process.env.BLUESKY_APP_PASSWORD || "",
    jwt: process.env.BLUESKY_ACCESS_JWT || "",
    did: process.env.BLUESKY_DID || "",
    handle: process.env.BLUESKY_HANDLE || "",
    authSource: process.env.BLUESKY_ACCESS_JWT ? "env BLUESKY_ACCESS_JWT" : "",
  };
}

async function xrpc(method, nsid, { c, query, body } = {}) {
  const headers = { "user-agent": "slash-bluesky/0.1" };
  if (c?.jwt) headers.authorization = `Bearer ${c.jwt}`;
  let url = `${PDS}/xrpc/${nsid}`;
  if (query) url += `?${new URLSearchParams(query)}`;
  const init = { method, headers };
  if (body) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(url, init);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = undefined; }
  if (!res.ok) throw new Error(`${res.status}: ${(j && (j.message || j.error)) || text.slice(0, 200)}`);
  return j ?? {};
}

async function login(c) {
  if (c.jwt) {
    const session = await xrpc("GET", "com.atproto.server.getSession", { c });
    c.did = session.did || c.did;
    c.handle = session.handle || c.handle;
    return c;
  }
  if (!c.identifier || !c.password) throw new Error("Missing credentials: login to bsky.app in Chrome/Brave/Edge, or set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD (an app password, not your main one).");
  const r = await xrpc("POST", "com.atproto.server.createSession", { body: { identifier: c.identifier, password: c.password } });
  c.jwt = r.accessJwt; c.did = r.did; c.handle = r.handle; c.authSource = "app password";
  return c;
}

function expandHome(input) {
  if (!input) return input;
  return input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

function existingStorageDirs(profileFlag) {
  const home = os.homedir();
  const browserRoots = [
    path.join(home, "Library/Application Support/Google/Chrome"),
    path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
    path.join(home, "Library/Application Support/Microsoft Edge"),
  ];
  const candidates = [];
  if (profileFlag) {
    const expanded = expandHome(profileFlag);
    candidates.push(expanded);
    if (!expanded.includes("/")) {
      for (const root of browserRoots) candidates.push(path.join(root, expanded));
    }
  }
  candidates.push(...browserRoots);

  const dirs = [];
  const addStorageDirs = (profileDir) => {
    const localStorage = path.join(profileDir, "Local Storage", "leveldb");
    if (fs.existsSync(localStorage)) dirs.push(localStorage);
    const indexedDb = path.join(profileDir, "IndexedDB");
    if (!fs.existsSync(indexedDb)) return;
    for (const entry of fs.readdirSync(indexedDb, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.includes("bsky.app") && entry.name.endsWith(".leveldb")) {
        dirs.push(path.join(indexedDb, entry.name));
      }
    }
  };

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) continue;
    if (candidate.endsWith(path.join("Local Storage", "leveldb"))
      || candidate.endsWith(".indexeddb.leveldb")) {
      dirs.push(candidate);
      continue;
    }
    addStorageDirs(candidate);
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addStorageDirs(path.join(candidate, entry.name));
    }
  }
  return [...new Set(dirs)];
}

function maybeParseJson(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function walkSessions(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    const parsed = value.includes("Jwt") || value.includes("did:") ? maybeParseJson(value) : null;
    if (parsed) walkSessions(parsed, out);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSessions(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  const accessJwt = typeof value.accessJwt === "string" ? value.accessJwt : "";
  if (accessJwt) {
    out.push({
      jwt: accessJwt,
      did: typeof value.did === "string" ? value.did : "",
      handle: typeof value.handle === "string" ? value.handle : "",
    });
  }
  for (const item of Object.values(value)) walkSessions(item, out);
  return out;
}

function jsonObjectsNear(haystack, needle) {
  const out = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const startLimit = Math.max(0, idx - 50_000);
    const start = haystack.lastIndexOf("{", idx);
    if (start >= startLimit) {
      let depth = 0, inString = false, escape = false;
      for (let i = start; i < Math.min(haystack.length, start + 250_000); i++) {
        const ch = haystack[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === "\"") { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) {
            out.push(haystack.slice(start, i + 1));
            break;
          }
        }
      }
    }
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

function browserSessions(flags) {
  const sessions = [];
  for (const dir of existingStorageDirs(flags["browser-profile"])) {
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(ldb|log)$/i.test(f))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch {
      continue;
    }
    for (const file of files) {
      let buf;
      try { buf = fs.readFileSync(file); } catch { continue; }
      for (const text of [buf.toString("utf8"), buf.toString("utf16le")]) {
        if (!text.includes("accessJwt")) continue;
        for (const raw of jsonObjectsNear(text, "accessJwt")) {
          const parsed = maybeParseJson(raw);
          if (!parsed) continue;
          for (const session of walkSessions(parsed)) {
            if (!session.jwt) continue;
            sessions.push({ ...session, source: `browser ${dir.replace(os.homedir(), "~")}` });
          }
        }
      }
    }
  }
  return sessions;
}

async function resolveAuth(c, flags) {
  if (c.jwt || c.identifier || c.password || flags["no-browser"]) return c;
  const [session] = browserSessions(flags);
  if (session) {
    c.jwt = session.jwt;
    c.did = session.did;
    c.handle = session.handle;
    c.authSource = session.source;
  }
  return c;
}

// Resolve a bsky.app URL or at:// uri to an at-uri.
async function toAtUri(c, ref) {
  ref = String(ref).trim();
  if (ref.startsWith("at://")) return ref;
  const m = /profile\/([^/]+)\/post\/([a-z0-9]+)/i.exec(ref);
  if (!m) throw new Error(`not a Bluesky post URL or at:// uri: "${ref}"`);
  let did = m[1];
  if (!did.startsWith("did:")) {
    const r = await xrpc("GET", "com.atproto.identity.resolveHandle", { c, query: { handle: did } });
    did = r.did;
  }
  return `at://${did}/app.bsky.feed.post/${m[2]}`;
}

function record(text, reply) {
  const rec = { $type: "app.bsky.feed.post", text: text.slice(0, 300), createdAt: new Date().toISOString() };
  if (reply) rec.reply = reply;
  return rec;
}

async function createRecord(c, rec) {
  const r = await xrpc("POST", "com.atproto.repo.createRecord", {
    c, body: { repo: c.did, collection: "app.bsky.feed.post", record: rec },
  });
  const rkey = (r.uri || "").split("/").pop();
  return { uri: r.uri, url: `https://bsky.app/profile/${c.handle || c.identifier}/post/${rkey}` };
}

async function readBody(parsed, idx) {
  if (parsed.flags.file) return fs.readFileSync(parsed.flags.file, "utf8").trim();
  return (parsed._[idx] || "").trim();
}

function done(parsed, obj) {
  if (parsed.flags.json) console.log(JSON.stringify(obj, null, 2));
  else if (obj.success) console.log(`✅ ${obj.message || "done"}${obj.url ? `\n🔗 ${obj.url}` : ""}`);
  else console.error(`❌ ${obj.error}`);
  process.exit(obj.success ? 0 : 1);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const cmd = parsed._[0];
  if (!cmd || cmd === "help" || parsed.flags.help) { console.log(HELP); process.exit(0); }
  const c = await resolveAuth(cfg(parsed.flags), parsed.flags);
  try {
    if (cmd === "whoami" || cmd === "check") {
      await login(c);
      return done(parsed, { success: true, message: `logged in as @${c.handle}`, did: c.did, source: c.authSource || "credentials" });
    }
    if (cmd === "post") {
      const text = await readBody(parsed, 1);
      if (!text) throw new Error("empty post (pass <text> or --file)");
      await login(c);
      const r = await createRecord(c, record(text));
      return done(parsed, { success: true, message: "posted", ...r });
    }
    if (cmd === "reply") {
      const ref = parsed._[1];
      if (!ref) throw new Error("usage: slash-bluesky reply <post> <text>");
      const text = await readBody(parsed, 2);
      if (!text) throw new Error("empty reply (pass <text> or --file)");
      await login(c);
      const uri = await toAtUri(c, ref);
      const g = await xrpc("GET", "app.bsky.feed.getPosts", { c, query: { uris: uri } });
      const p = g.posts?.[0];
      if (!p) throw new Error("parent post not found");
      const parent = { uri, cid: p.cid };
      const root = p.record?.reply?.root || parent;
      const r = await createRecord(c, record(text, { root, parent }));
      return done(parsed, { success: true, message: "reply posted", ...r });
    }
    throw new Error(`unknown command "${cmd}" (try: slash-bluesky help)`);
  } catch (e) {
    return done(parsed, { success: false, error: String(e.message || e) });
  }
}

main();
