// Minimal stand-in for supabase-js that runs every call against PGlite with the real migrations + RLS.
import crypto from "crypto";
const PARSERS = {1082: v => v, 1114: v => v, 1184: v => v, 1700: v => Number(v)};
const ident = s => '"' + String(s).replace(/"/g, '""') + '"';

export function makeClient(db, users) {
  let current = null; // {id, email, phone}
  const listeners = [];
  async function run(sql, params = []) {
    const claims = current ? {sub: current.id, email: current.email || undefined, phone: current.phone || undefined, role: "authenticated"} : {role: "anon"};
    await db.exec(`reset role; select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, false); set role ${current ? "authenticated" : "anon"};`);
    try { return await db.query(sql, params, {parsers: PARSERS}); }
    finally { await db.exec("reset role"); }
  }
  const lit = s => "'" + String(s).replace(/'/g, "''") + "'";
  const wrap = async fn => { try { return {data: await fn(), error: null}; } catch (e) { return {data: null, error: {message: e.message}}; } };

  class QB {
    constructor(table) { this.t = table; this.op = "select"; this.cols = "*"; this.filters = []; this.ord = null; this.rng = null; this.single = false; }
    select(c = "*") { if (this.op === "select") this.cols = c; else this.returning = true; return this; }
    eq(c, v) { this.filters.push([c, v]); return this; }
    order(c) { this.ord = c; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.single = true; return this; }
    insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, o = {}) { this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.o = o; return this; }
    update(row) { this.op = "update"; this.row = row; return this; }
    delete() { this.op = "delete"; return this; }
    where(params) { if (!this.filters.length) return ""; return " where " + this.filters.map(([c, v]) => { params.push(v); return `${ident(c)} = $${params.length}`; }).join(" and "); }
    val(v) { return v !== null && typeof v === "object" ? JSON.stringify(v) : v; }
    async exec() {
      const p = [], T = "public." + ident(this.t);
      if (this.op === "select") {
        let sql = `select ${this.cols === "*" ? "*" : this.cols.split(",").map(ident).join(",")} from ${T}` + this.where(p);
        if (this.ord) sql += ` order by ${ident(this.ord)}`;
        if (this.rng) sql += ` limit ${this.rng[1] - this.rng[0] + 1} offset ${this.rng[0]}`;
        const r = await run(sql, p);
        return this.single ? (r.rows[0] || null) : r.rows;
      }
      if (this.op === "insert" || this.op === "upsert") {
        const cols = [...new Set(this.rows.flatMap(r => Object.keys(r)))];
        const values = this.rows.map(r => "(" + cols.map(c => { if (!(c in r)) return "default"; p.push(this.val(r[c])); return "$" + p.length; }).join(",") + ")").join(",");
        let sql = `insert into ${T} (${cols.map(ident).join(",")}) values ${values}`;
        if (this.op === "upsert") {
          const conf = (this.o.onConflict || "id").split(",").map(s => ident(s.trim()));
          const upd = cols.filter(c => !conf.includes(ident(c)));
          sql += this.o.ignoreDuplicates || !upd.length ? ` on conflict (${conf}) do nothing` : ` on conflict (${conf}) do update set ${upd.map(c => `${ident(c)} = excluded.${ident(c)}`).join(",")}`;
        }
        const r = await run(sql + " returning *", p); return r.rows;
      }
      if (this.op === "update") {
        const set = Object.entries(this.row).map(([c, v]) => { p.push(this.val(v)); return `${ident(c)} = $${p.length}`; }).join(",");
        const r = await run(`update ${T} set ${set}` + this.where(p) + " returning *", p); return r.rows;
      }
      if (this.op === "delete") { const r = await run(`delete from ${T}` + this.where(p) + " returning *", p); return r.rows; }
    }
    then(res, rej) { return wrap(() => this.exec()).then(res, rej); }
  }
  async function rpc(name, args = {}) {
    const keys = Object.keys(args), p = keys.map(k => { const v = args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
    const r = await run(`select * from public.${ident(name)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")})`, p);
    if (r.fields.length === 1 && r.fields[0].name === name) return r.rows.length === 1 ? r.rows[0][name] : r.rows.map(x => x[name]);
    return r.rows;
  }
  const session = () => current ? {user: {id: current.id, email: current.email, phone: current.phone}} : null;
  const files = {};
  return {
    _run: run,
    from: t => new QB(t),
    rpc: (n, a) => ({then: (res, rej) => wrap(() => rpc(n, a)).then(res, rej)}),
    auth: {
      getSession: async () => ({data: {session: session()}}),
      onAuthStateChange: cb => { listeners.push(cb); return {data: {subscription: {unsubscribe() {}}}}; },
      signOut: async () => { current = null; return {error: null}; },
      signInWithPassword: async ({email, password}) => {
        const u = users[email.toLowerCase()]; if (!u || u.password !== password) return {data: {}, error: {message: "Invalid login credentials"}};
        current = {id: u.id, email}; return {data: {session: session()}, error: null};
      },
      signUp: async ({email, password}) => {
        email = email.toLowerCase(); if (users[email]) return {data: {}, error: {message: "User already registered"}};
        const id = crypto.randomUUID(); users[email] = {id, password};
        await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
        current = {id, email}; return {data: {session: session(), user: {id}}, error: null};
      },
      signInWithOtp: async () => ({error: {message: "SMS provider not configured"}}),
      verifyOtp: async () => ({error: {message: "not configured"}})
    },
    storage: {from: () => ({
      upload: async (path, blob) => { if (!current || path.split("/")[1] !== current.id) return {error: {message: "new row violates row-level security policy"}}; files[path] = blob; await db.query("insert into storage.objects (bucket_id,name) values ('docs',$1)", [path]); return {data: {path}, error: null}; },
      createSignedUrl: async (path) => { const r = await run("select 1 from storage.objects where bucket_id='docs' and name=$1", [path]); return r.rows.length ? {data: {signedUrl: "blob:signed/" + path}, error: null} : {data: null, error: {message: "Object not found"}}; }
    })},
    functions: {invoke: async (name, {body}) => ({data: {ok: true, name, body}, error: null})}
  };
}
