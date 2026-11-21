// End-to-end test: loads web/index.html in jsdom and drives the full workflow against the real database rules.
import {setupDb} from "./setupdb.mjs";
import {makeClient} from "./mocksb.mjs";
import {JSDOM} from "jsdom";
import fs from "fs"; import crypto from "crypto";
const db = await setupDb();
const users = {"boss@org.com": {id: crypto.randomUUID(), password: "secret1"}, "adam@org.com": {id: crypto.randomUUID(), password: "secret2"}};
for (const [e, u] of Object.entries(users)) await db.query("insert into auth.users (id,email) values ($1,$2)", [u.id, e]);
await db.query("insert into staff (email,user_id,name,role) values ('boss@org.com',$1,'Boss','super')", [users["boss@org.com"].id]);
const client = makeClient(db, users);
let html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8").replace(/<script src=[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
const errors = [];
const dom = new JSDOM(html, {runScripts: "dangerously", pretendToBeVisual: true, url: "https://umrah.example.org/app/", beforeParse(w) {
  w.APP_CONFIG = {SUPABASE_URL: "x", SUPABASE_ANON_KEY: "y", PILGRIM_EMAIL_DOMAIN: "pilgrims.umrah.app"};
  w.supabase = {createClient: () => client};
  Object.defineProperty(w, "crypto", {value: crypto.webcrypto}); w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.addEventListener("error", e => errors.push(e.message)); w.console.error = (...a) => errors.push(a.join(" "));
}});
const w = dom.window, d = w.document;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 60; i++) { await sleep(25); if (d.body.style.cursor !== "progress") { await sleep(40); if (d.body.style.cursor !== "progress") return; } } };
const click = el => el.dispatchEvent(new w.MouseEvent("click", {bubbles: true}));
const act = async (a, arg) => { const els = [...d.querySelectorAll(`[data-act="${a}"]`)].filter(e => arg == null || e.dataset.arg === String(arg)); if (!els.length) throw new Error("no act " + a + " " + (arg ?? "")); click(els[0]); await settle(); };
const setVal = (sel, v) => { const el = d.querySelector(sel); if (!el) throw new Error("missing " + sel); if (el.type === "checkbox") el.checked = v; else el.value = v; el.dispatchEvent(new w.Event("input", {bubbles: true})); el.dispatchEvent(new w.Event("change", {bubbles: true})); el.dispatchEvent(new w.FocusEvent("focusout", {bubbles: true})); };
const submit = async () => { d.querySelector("form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true})); await settle(); };
const h1 = () => d.querySelector("main h1")?.textContent;
const lastToast = () => [...d.querySelectorAll("#toast div")].map(x => x.textContent).slice(-1)[0];
const upload = async (key) => { const el = d.querySelector(`#modal [data-upload="${key}"]`); const f = new w.File(["%PDF-1.4 test"], key + ".pdf", {type: "application/pdf"}); Object.defineProperty(el, "files", {value: [f]}); el.dispatchEvent(new w.Event("change", {bubbles: true})); await settle(); };
const dlgText = async (t) => { await sleep(30); d.querySelector("#dialog textarea").value = t; d.querySelector("#dialog form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true})); await settle(); };
const log = (...a) => console.log(" ", ...a);
const staffLogin = async (email, pw) => { await act("loginTab", "staff"); setVal("[name=email]", email); setVal("[name=pw]", pw); await submit(); };
try {
  await settle(); await sleep(200);
  log("login screen:", !!d.querySelector(".login"));
  await staffLogin("boss@org.com", "secret1"); log("staff dashboard:", h1());
  // masters
  await act("nav", "masters"); await act("bulkMaster", "regions"); setVal("#modal [data-bind=text]", "Muscat\nBatinah"); await act("saveBulk"); log("regions:", d.querySelector(".tabs a").textContent, lastToast());
  await act("masterTab", "hotels"); await act("editMaster", "hotels|"); setVal("#modal [data-bind=name]", "Hilton Makkah"); setVal("#modal [data-bind=city]", "Makkah"); await act("saveMaster"); log("hotel saved:", d.body.textContent.includes("Hilton Makkah"));
  // staff
  await act("nav", "settings"); await act("editStaff", ""); setVal("#modal [data-bind=name]", "Adam"); setVal("#modal [data-bind=email]", "adam@org.com"); await act("saveStaff"); log("staff added:", d.body.textContent.includes("adam@org.com"), lastToast());
  await act("editStaff", ""); setVal("#modal [data-bind=name]", "X"); setVal("#modal [data-bind=email]", "nouser@org.com"); await act("saveStaff"); log("unknown login blocked:", lastToast()); await act("closeModal");
  // trip
  await act("nav", "trips"); await act("newTrip"); const start = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10), end = new Date(Date.now() + 50 * 864e5).toISOString().slice(0, 10);
  setVal("[data-bind=title]", "January Umrah"); setVal("[data-bind=startDate]", start); setVal("[data-bind=endDate]", end); setVal("[data-bind=status]", "open"); setVal("[data-bind='fares.adult']", "180"); setVal("[data-bind='fares.child']", "120"); setVal("[data-bind='fares.infant']", "40"); setVal("[data-bind='visaFees.NEED_UMRAH']", "30");
  setVal("[data-bind='legs.0.hotelId']", d.querySelector("[data-bind='legs.0.hotelId'] option:nth-child(2)").value);
  await act("saveTrip"); log("trip saved:", h1(), d.body.textContent.includes("January Umrah"), lastToast());
  const tripId = d.querySelector("[data-act=editTrip]").dataset.arg;
  await act("logout");
  // pilgrim registers
  setVal("[name=mobile]", "91234567"); await submit(); await act("pinMode", "new"); setVal("[name=pin]", "123456"); setVal("[name=pin2]", "123456"); await submit();
  log("pilgrim home:", h1());
  await act("register", tripId); setVal("[data-bind=leadName]", "Mohammed Rafi"); setVal("[data-bind='requested.adults']", "1"); setVal("[data-bind='requested.infants']", "1"); await act("saveEnquiry");
  log("request:", d.querySelector("main .chip")?.textContent, lastToast());
  const bookingId = (await db.query("select id from bookings")).rows[0].id;
  await act("logout"); await staffLogin("adam@org.com", "secret2"); log("admin dashboard chips:", [...d.querySelectorAll("main .chip")].map(c => c.textContent).filter(t => /request/.test(t)).join("|"));
  await act("tripPipe", tripId); await act("openBooking", bookingId); await act("setStatus", "details"); log("status:", d.querySelector("main .chip")?.textContent);
  log("history:", [...d.querySelectorAll(".hist b")].map(x => x.textContent).join(" | "));
  await act("logout");
  // pilgrim adds details
  setVal("[name=mobile]", "91234567"); await submit(); setVal("[name=pin]", "123456"); await submit(); log("pilgrim back:", h1());
  await act("openBooking", bookingId); await act("editBooking", bookingId); log("editor:", h1());
  await act("editPerson", "new||bk"); setVal("#modal [data-bind=_rel]", "Self"); setVal("#modal [data-bind=name]", "mohammed rafi"); setVal("#modal [data-bind=gender]", "Male"); setVal("#modal [data-bind=dob]", "1981-10-10");
  setVal("#modal [data-bind=passportNo]", "z1234567"); setVal("#modal [data-bind=passportExpiry]", "2031-01-01"); setVal("#modal [data-bind=residenceNo]", "998877"); setVal("#modal [data-bind=residenceExpiry]", "2028-05-01");
  for (const k of ["passportFront", "passportBack", "residenceFront", "residenceBack"]) await upload(k);
  log("uploaded docs:", d.querySelectorAll("#modal .upl.has").length); await act("saveProfile"); log("saved self:", lastToast(), "modal closed:", !d.querySelector("#modal .box"));
  const infantDob = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  await act("editPerson", "new||bk"); setVal("#modal [data-bind=_rel]", "Son"); setVal("#modal [data-bind=name]", "baby rafi"); setVal("#modal [data-bind=gender]", "Male"); setVal("#modal [data-bind=dob]", infantDob);
  setVal("#modal [data-bind=passportNo]", "z7654321"); setVal("#modal [data-bind=passportExpiry]", "2031-01-01"); setVal("#modal [data-bind=onVisitVisa]", true);
  for (const k of ["passportFront", "passportBack"]) await upload(k); await act("saveProfile");
  log("passengers in editor:", d.querySelectorAll("main [data-act=removePax]").length, "cats:", [...d.querySelectorAll("main .pax .chip")].map(c => c.textContent).join(","));
  d.querySelectorAll("[data-bind$='.visaType']").forEach(() => {}); for (let i = 0; i < 2; i++) setVal(`[data-bind='passengers.${i}.visaType']`, "NEED_UMRAH");
  await act("saveBooking", "submit"); log("after submit:", d.querySelector("main .chip")?.textContent, lastToast());
  await act("newPayment", bookingId); setVal("#modal [data-bind=amount]", "100"); await upload("receipt"); await act("savePayment"); log("payment:", lastToast(), d.body.textContent.includes("pending"));
  await act("logout");
  // admin approves, adjusts fare, finance via super
  await staffLogin("adam@org.com", "secret2"); await act("nav", "bookings"); await act("openBooking", bookingId);
  log("docs to verify:", d.querySelectorAll("[data-act=docStatus]").length);
  await act("viewDoc"); log("doc viewer:", !!d.querySelector("#dialog a, #dialog img")); await act("dlg", "");
  await act("setStatus", "approved"); log("status:", d.querySelector("main .chip")?.textContent);
  await act("adjFare", "0"); setVal("#modal [data-bind=fare]", "150"); setVal("#modal [data-bind=note]", "Committee"); await act("saveFare", ""); log("fare:", lastToast());
  await act("setStatus", "confirmed"); log("confirm blocked:", lastToast());
  await act("logout"); await staffLogin("boss@org.com", "secret1"); await act("nav", "bookings"); await act("openBooking", bookingId);
  await act("payStatus", d.querySelector("[data-act=payStatus]").dataset.arg); log("verified:", lastToast() || "ok");
  await act("newPayment", bookingId); setVal("#modal [data-bind=method]", "cash"); 
  const bal = (await client._run(`select bal_pre from booking_amounts('${bookingId}')`)).rows; // run as current user (super)
  setVal("#modal [data-bind=amount]", String(bal[0].bal_pre)); await act("savePayment"); log("cash recorded:", lastToast());
  await act("setStatus", "confirmed"); log("final status:", d.querySelector("main .chip")?.textContent);
  await act("newCharge", bookingId); setVal("#modal [data-bind=stage]", "on"); setVal("#modal [data-bind=roomTypeId]", d.querySelector("#modal [data-bind=roomTypeId] option:nth-child(2)").value); setVal("#modal [data-bind=amount]", "80"); await act("saveCharge"); log("on-trip charge:", lastToast());
  await act("resetPin", "96891234567"); await dlgText("654321"); log("reset pin:", lastToast());
  await act("nav", "reports"); for (const t of ["requests", "manifest", "visa", "payments", "rooms", "summary"]) { await act("repTab", t); } await act("repTab", "manifest");
  log("manifest rows:", d.querySelectorAll("main tbody tr").length, "|", d.querySelector("main tbody tr")?.textContent.slice(0, 90));
  await act("nav", "home"); log("dashboard:", d.querySelector("main .grid")?.textContent.replace(/\s+/g, " ").slice(0, 160));
  await act("nav", "pilgrims"); log("pilgrims rows:", d.querySelectorAll("main tbody tr").length);
  log("history:", (await db.query(`select text from booking_history where booking_id=$1 order by id`, [bookingId])).rows.map(r => r.text).join(" | "));
} catch (e) { console.log("FAIL:", e.message); process.exitCode = 1; }
console.log("ERRORS:", errors.length ? errors : "none");
if (errors.length) process.exitCode = 1;
process.exit(process.exitCode || 0);
