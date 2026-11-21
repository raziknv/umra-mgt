// Database rule tests: privacy between families, status rules, fares, payments, storage.
import {setupDb} from "./setupdb.mjs";
const db = await setupDb();
const ok = (m) => console.log("  ✓", m), bad = (m) => { console.log("  ✗", m); process.exitCode = 1; };
// ---- users ----
const U = { super: "11111111-1111-1111-1111-111111111111", admin: "22222222-2222-2222-2222-222222222222", fin: "33333333-3333-3333-3333-333333333333",
  ameer: "44444444-4444-4444-4444-444444444444", p1: "55555555-5555-5555-5555-555555555555", p2: "66666666-6666-6666-6666-666666666666" };
await db.exec(`insert into auth.users values
 ('${U.super}','boss@org.com',null),('${U.admin}','admin@org.com',null),('${U.fin}','fin@org.com',null),('${U.ameer}','ameer@org.com',null),
 ('${U.p1}','96891234567@pilgrims.umrah.app',null),('${U.p2}',null,'96899999999');
 insert into staff (email,user_id,name,role) values ('boss@org.com','${U.super}','Boss','super');`);
const claims = { super: { sub: U.super, email: "boss@org.com" }, admin: { sub: U.admin, email: "admin@org.com" }, fin: { sub: U.fin, email: "fin@org.com" },
  ameer: { sub: U.ameer, email: "ameer@org.com" }, p1: { sub: U.p1, email: "96891234567@pilgrims.umrah.app" }, p2: { sub: U.p2, phone: "96899999999" } };
async function as(who, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claims', '${JSON.stringify(claims[who] || {})}', false); set role ${who === "anon" ? "anon" : "authenticated"};`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
}
async function fails(who, sql, msgPart, params = []) {
  try { await as(who, sql, params); bad(`expected failure: ${sql.slice(0, 70)}`); }
  catch (e) { (!msgPart || e.message.includes(msgPart)) ? ok(`blocked (${who}): ${e.message.slice(0, 90)}`) : bad(`wrong error: ${e.message}`); }
}
const one = async (who, sql, p) => (await as(who, sql, p)).rows[0];

console.log("\n-- staff setup");
await as("super", `select upsert_staff('admin@org.com','Adam','admin')`); await as("super", `select upsert_staff('fin@org.com','Fatima','finance')`);
await as("super", `select upsert_staff('ameer@org.com','Ameer Ali','ameer')`);
ok("super added staff: " + (await one("super", `select count(*) c from staff`)).c);
await fails("admin", `select upsert_staff('x@y.com','X','admin')`, "Only the Super Admin");
await fails("super", `select upsert_staff('nobody@y.com','X','admin')`, "No login exists");
console.log((await one("p1", "select current_mobile() m, is_staff() s")), (await one("p2", "select current_mobile() m")));

console.log("\n-- trip");
const ameerId = (await one("super", `select id from staff where role='ameer'`)).id;
const start = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const trip = (await one("admin", `insert into trips (code,title,start_date,end_date,status,max_seats,adult_fare,child_fare,infant_fare,visa_fees,ameer_id,reg_open)
  values ('T1','Dec trip',$1::date,$1::date+10,'open',3,180,120,40,'{"NEED_UMRAH":30,"NEED_MULTI":45,"HAS_MULTI":0}',$2,current_date) returning id`, [start, ameerId])).id;
ok("trip created by admin");
await fails("fin", `insert into trips (title,start_date,end_date) values ('x',current_date,current_date)`, "row-level security");
ok("anon sees open trips: " + (await as("anon", "select count(*) c from trips")).rows[0].c);

console.log("\n-- pilgrim request");
await as("p1", `insert into accounts (mobile) values ('96891234567')`);
await fails("p1", `insert into accounts (mobile) values ('96800000000')`, "row-level security");
const bk = (await one("p1", `insert into bookings (trip_id,account_mobile,lead_name,req_adults,req_infants,status) values ($1,'96891234567','Rafi',2,1,'approved') returning id, status`, [trip]));
bk.status === "enquiry" ? ok("forced to enquiry") : bad("status " + bk.status);
await fails("p1", `update bookings set status='approved' where id='${bk.id}'`, "Status can only be changed");
await fails("p1", `select submit_booking('${bk.id}')`, "wait for the office");
await fails("p1", `select set_booking_status('${bk.id}','details')`, "Only Super Admin");
await as("admin", `select set_booking_status('${bk.id}','details')`); ok("admin requested details");

console.log("\n-- people & documents");
const pA = (await one("p1", `select save_person(null, '{"name":"mohammed rafi","gender":"Male","dob":"1981-10-10","passport_no":"z123","passport_expiry":"2030-01-01","residence_no":"1","residence_expiry":"2028-01-01"}'::jsonb, null, 'Self') id`)).id;
const pB = (await one("p1", `select save_person(null, $1::jsonb, null, 'Daughter') id`, [JSON.stringify({ name: "baby", gender: "Female", dob: new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10), passport_no: "Z999", passport_expiry: "2030-01-01", on_visit_visa: true })])).id;
ok("persons saved; p1 sees " + (await one("p1", "select count(*) c from persons")).c + " person(s); p2 sees " + (await one("p2", "select count(*) c from persons")).c);
await fails("p2", `select save_person(null, '{"name":"x","passport_no":"Z123"}'::jsonb, null, 'Self')`, "already registered");
await as("p1", `insert into booking_passengers (booking_id,person_id,relationship,visa_type,fare_override) values ('${bk.id}','${pA}','Self','NEED_UMRAH',1),('${bk.id}','${pB}','Daughter','NEED_UMRAH',null)`);
const fo = await one("p1", `select fare_override from booking_passengers where person_id='${pA}'`); fo.fare_override === null ? ok("pilgrim cannot set fare override") : bad("override set");
let issues = (await one("p1", `select booking_issues('${bk.id}') i`)).i; console.log("  issues:", issues);
await fails("p1", `select submit_booking('${bk.id}')`, "Cannot submit");
for (const [p, d] of [[pA, "passportFront"], [pA, "passportBack"], [pA, "residenceFront"], [pA, "residenceBack"], [pB, "passportFront"], [pB, "passportBack"]])
  await as("p1", `insert into person_documents (person_id,doc_type,storage_path,status) values ('${p}','${d}','u/${U.p1}/${d}.jpg','verified')`);
ok("doc status forced: " + (await one("p1", `select distinct status from person_documents`)).status);
issues = (await one("p1", `select booking_issues('${bk.id}') i`)).i; issues.length ? bad("issues " + issues) : ok("no issues");
console.log("  category:", (await as("p1", `select p.name, pax_category(p.dob, $1::date) from persons p order by name`, [start])).rows.map(r => r.name + "=" + r.pax_category).join(", "));
ok("submit → " + (await one("p1", `select submit_booking('${bk.id}') s`)).s);

console.log("\n-- seats, duplicates");
console.log("  seats:", (await as("p2", "select * from trip_seats()")).rows[0]);
await as("p2", `insert into accounts (mobile) values ('96899999999')`);
await fails("p2", `insert into booking_passengers (booking_id, person_id) select '${bk.id}', '${pA}'`, "");
(await as("p2", `select count(*) c from bookings where id='${bk.id}'`)).rows[0].c == 0 ? ok("p2 cannot see p1's booking") : bad("leak");

console.log("\n-- approval, fare, payments");
await fails("admin", `select set_booking_status('${bk.id}','correction')`, "remark is required");
await as("admin", `select set_booking_status('${bk.id}','approved')`); ok("approved");
await as("fin", `update booking_passengers set fare_override=100, fare_note='x' where person_id='${pA}'`);
const fin = await one("fin", `select fare_override from booking_passengers where person_id='${pA}'`); console.log("  finance attempt left override:", fin.fare_override);
await fails("admin", `update booking_passengers set fare_override=100 where person_id='${pA}'`, "reason is required");
await as("admin", `update booking_passengers set fare_override=100, fare_note='Committee' where person_id='${pA}'`); ok("admin adjusted fare");
console.log("  amounts:", await one("p1", `select * from booking_amounts('${bk.id}')`));
await fails("p1", `select set_booking_status('${bk.id}','confirmed')`, "Only Super Admin");
await fails("admin", `select set_booking_status('${bk.id}','confirmed')`, "must be fully paid");
await fails("p1", `insert into payments (booking_id,amount,method,paid_on) values ('${bk.id}',100,'transfer',current_date)`, "receipt slip");
const pay = (await one("p1", `insert into payments (booking_id,amount,method,paid_on,receipt_path,status) values ('${bk.id}',100,'transfer',current_date,'u/x/r.jpg','verified') returning id,status`));
pay.status === "pending" ? ok("pilgrim payment pending") : bad(pay.status);
(await as("p1", `update payments set status='verified' where id='${pay.id}' returning id`)).rows.length === 0 ? ok("pilgrim cannot verify own payment") : bad("pilgrim verified");
await as("fin", `update payments set status='verified' where id='${pay.id}'`);
await as("fin", `insert into payments (booking_id,amount,method,paid_on) values ('${bk.id}',100,'cash',current_date)`);
console.log("  amounts:", await one("admin", `select * from booking_amounts('${bk.id}')`));
await as("admin", `select set_booking_status('${bk.id}','confirmed')`); ok("confirmed after full payment");

console.log("\n-- edits after approval");
await as("p1", `update persons set emergency='999' where id='${pB}'`);
ok("status after pilgrim edit: " + (await one("admin", `select status from bookings where id='${bk.id}'`)).status);

console.log("\n-- charges by ameer");
await fails("ameer", `insert into charges (booking_id,type,stage,amount,label) values ('${bk.id}','special_room','pre',10,'x')`, "row-level security");
await as("ameer", `insert into charges (booking_id,type,stage,amount,label,nights) values ('${bk.id}','special_room','on',160,'Family suite',4)`); ok("ameer added on-trip charge");
console.log("  amounts:", await one("admin", `select * from booking_amounts('${bk.id}')`));

console.log("\n-- privacy");
ok("p2 sees bookings: " + (await one("p2", "select count(*) c from bookings")).c + ", payments: " + (await one("p2", "select count(*) c from payments")).c + ", docs: " + (await one("p2", "select count(*) c from person_documents")).c);
await fails("p2", `select * from booking_amounts('${bk.id}')`, "Not allowed");
const lk = await one("p2", `select * from link_person('z123','1981-10-10','Father')`); ok("p2 linked existing person by passport+dob: " + lk.name);
await as("anon", "select * from staff_public"); ok("anon reads staff_public");
await fails("p2", `select pilgrim_user_ids('96891234567')`, "permission denied");
console.log("\n-- history");
console.log((await as("admin", `select by_name, text from booking_history where booking_id='${bk.id}' order by id`)).rows.map(r => "   " + r.by_name + " | " + r.text).join("\n"));
console.log("\n-- storage policies");
await db.exec(`insert into storage.objects (bucket_id,name) values ('docs','u/${U.p1}/passportFront.jpg'),('docs','u/${U.p2}/x.jpg')`);
ok("p1 sees objects: " + (await one("p1", "select count(*) c from storage.objects")).c + " ; p2 now sees: " + (await one("p2", "select count(*) c from storage.objects")).c + " ; admin: " + (await one("admin", "select count(*) c from storage.objects")).c);
await fails("p1", `insert into storage.objects (bucket_id,name) values ('docs','u/${U.p2}/hack.jpg')`, "row-level security");
console.log("\nDONE", process.exitCode ? "WITH FAILURES" : "ALL OK");
