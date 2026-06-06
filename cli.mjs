#!/usr/bin/env node
// slash-bluesky — Edi's local Bluesky CLI. Post / reply / read via AT Protocol.
// No dependencies. Uses an app password (Settings -> App passwords on bsky.app).

const PDS = process.env.BLUESKY_PDS || "https://bsky.social";

const HELP = `slash-bluesky — post and reply on Bluesky from the command line

Usage:
  slash-bluesky post <text>              Publish a new post
  slash-bluesky post --file f            Publish from a file
  slash-bluesky reply <post> <text>      Reply to a post (URL or at:// uri)
  slash-bluesky whoami                   Show the logged-in account
  slash-bluesky check                    Verify credentials / login

Auth (https://bsky.app/settings/app-passwords):
  BLUESKY_IDENTIFIER=you.bsky.social   BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
  (or pass --identifier / --password)

Options:
  --file <path>   Read body text from a file
  --json          Machine-readable JSON output

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
    jwt: "", did: "",
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
  if (!c.identifier || !c.password) throw new Error("Missing credentials: set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD (an app password, not your main one).");
  const r = await xrpc("POST", "com.atproto.server.createSession", { body: { identifier: c.identifier, password: c.password } });
  c.jwt = r.accessJwt; c.did = r.did; c.handle = r.handle;
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
  if (parsed.flags.file) { const { readFile } = await import("node:fs/promises"); return (await readFile(parsed.flags.file, "utf8")).trim(); }
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
  const c = cfg(parsed.flags);
  try {
    if (cmd === "whoami" || cmd === "check") {
      await login(c);
      return done(parsed, { success: true, message: `logged in as @${c.handle}`, did: c.did });
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
