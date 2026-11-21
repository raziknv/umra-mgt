// Creates an in-memory Postgres (PGlite) with small stand-ins for Supabase's auth & storage schemas,
// then applies the real migrations and seed.
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const M = new URL("../supabase/migrations/", import.meta.url).pathname;
export async function setupDb(){
const db = new PGlite();
// ---- Supabase stubs: roles, auth schema, storage schema ----
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users (id uuid primary key, email text, phone text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant all on storage.objects to authenticated;
`);
for (const f of fs.readdirSync(M).sort()) { await db.exec(fs.readFileSync(M + f, "utf8"));  }
await db.exec(fs.readFileSync(new URL("../supabase/seed.sql", import.meta.url).pathname, "utf8")); console.log("seed ok");


return db;
}
